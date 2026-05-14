import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Header from '@/components/Header';
import LanguageSelector, { getLanguageRTL, getLanguageName } from '@/components/LanguageSelector';
import RecordButton from '@/components/RecordButton';
import TranscriptionDisplay from '@/components/TranscriptionDisplay';
import SubtitleView from '@/components/SubtitleView';
import SettingsDialog from '@/components/SettingsDialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ArrowLeftRight, ChevronDown, ChevronUp, Download, History, Loader2, Wand2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useSettings } from '@/hooks/useSettings';
import type { SpeechMode, DisplayContent, TextDisplay } from '@/hooks/useSettings';
import ExportDialog from '@/components/ExportDialog';
import SessionHistoryDialog from '@/components/SessionHistoryDialog';
import { ChunkBasedTranscription } from '@/lib/chunk-based-transcription';
import { BrowserSpeechTranscription } from '@/lib/browser-speech-transcription';
import { StreamingTranscription } from '@/lib/streaming-transcription';
import { countSentences } from '@/lib/text-utils';
import { LocalWhisperTranscription } from '@/lib/local-whisper-transcription';
import { useAudioQuality } from '@/hooks/useAudioQuality';
import { saveSession } from '@/lib/session-db';

type AnyTranscriptionBackend = StreamingTranscription | ChunkBasedTranscription | BrowserSpeechTranscription | LocalWhisperTranscription;

interface TranscriptionSegment {
  original: string;
  translated: string;
}

// ── Segmented control ────────────────────────────────────────────────────────

interface SegOpt<T extends string> { value: T; label: string }

function SegControl<T extends string>({
  options, value, onChange, disabled,
}: { options: SegOpt<T>[]; value: T; onChange: (v: T) => void; disabled?: boolean }) {
  return (
    <div className="inline-flex rounded-lg border border-border overflow-hidden text-sm">
      {options.map(opt => (
        <button
          key={opt.value}
          type="button"
          onClick={() => onChange(opt.value)}
          disabled={disabled}
          className={`px-3 py-1.5 transition-colors ${
            value === opt.value
              ? 'bg-primary text-primary-foreground'
              : 'bg-background text-muted-foreground hover:text-foreground hover:bg-muted/50'
          } disabled:opacity-40 disabled:cursor-not-allowed`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function splitLastTwo(text: string): [string, string] {
  const parts = text.trim().split(/[.!?]+\s+/).filter(s => s.trim());
  if (parts.length === 0) return ['', ''];
  if (parts.length === 1) return [parts[0], ''];
  return [parts[parts.length - 1], parts[parts.length - 2]];
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function Home() {
  const { settings, updateSettings } = useSettings();
  const [sourceLanguage, setSourceLanguage] = useState(() => settings.defaultSourceLanguage || 'en');
  const [targetLanguage, setTargetLanguage] = useState(() => settings.defaultTargetLanguage || 'nl');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [originalText, setOriginalText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [previewText, setPreviewText] = useState('');
  // Default dark — matches the index.html inline script that adds 'dark' before paint
  const [isDark, setIsDark] = useState(true);
  const [isRetranslating, setIsRetranslating] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(false);
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [modelLoadProgress, setModelLoadProgress] = useState(0);
  const [chunkDurationSecs, setChunkDurationSecs] = useState(5);
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [isImproving, setIsImproving] = useState(false);
  const [lookbackChars, setLookbackChars] = useState(() => settings.defaultLookbackChars);
  useEffect(() => { setLookbackChars(settings.defaultLookbackChars); }, [settings.defaultLookbackChars]);
  const [webGpuSupported, setWebGpuSupported] = useState<boolean | null>(null);

  useEffect(() => {
    if (!('gpu' in navigator)) { setWebGpuSupported(false); return; }
    (navigator as Navigator & { gpu: { requestAdapter(): Promise<unknown> } }).gpu
      .requestAdapter()
      .then(a => setWebGpuSupported(a !== null))
      .catch(() => setWebGpuSupported(false));
  }, []);

  const [subtitleCurrent, setSubtitleCurrent] = useState('');
  const [subtitlePrevious, setSubtitlePrevious] = useState('');
  const subtitleCurrentRef = useRef('');

  const [sermonContext, setSermonContext] = useState('');
  const sermonContextRef = useRef('');
  useEffect(() => { sermonContextRef.current = sermonContext; }, [sermonContext]);

  const detectSpeakers = settings.speechMode === 'dialogue';

  const backendRef = useRef<AnyTranscriptionBackend | null>(null);
  const transcriptionSegmentsRef = useRef<TranscriptionSegment[]>([]);
  const pendingRetranslationRef = useRef(false);
  const previousTargetLanguageRef = useRef(targetLanguage);
  const previousDetectSpeakersRef = useRef(detectSpeakers);
  const lastRetroactiveSentenceCountRef = useRef(0);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const { toast } = useToast();

  const { quality, startMonitoring, stopMonitoring } = useAudioQuality();
  const [sessionCost, setSessionCost] = useState(0);
  const sessionCostRef = useRef(0);

  const sourceLanguageRef = useRef(sourceLanguage);
  const targetLanguageRef = useRef(targetLanguage);
  const detectSpeakersRef = useRef(detectSpeakers);
  const settingsRef = useRef(settings);

  useEffect(() => { sourceLanguageRef.current = sourceLanguage; }, [sourceLanguage]);
  useEffect(() => { targetLanguageRef.current = targetLanguage; }, [targetLanguage]);
  useEffect(() => { detectSpeakersRef.current = detectSpeakers; }, [detectSpeakers]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  // Sync isDark state with the class already applied by index.html script
  useEffect(() => {
    const saved = localStorage.getItem('theme');
    const dark = saved !== 'light'; // default dark unless explicitly saved as light
    setIsDark(dark);
    document.documentElement.classList.toggle('dark', dark);
  }, []);

  const applySubtitlesFromText = (text: string) => {
    const [current, previous] = splitLastTwo(text);
    subtitleCurrentRef.current = current;
    setSubtitleCurrent(current);
    setSubtitlePrevious(previous);
  };

  useEffect(() => {
    const retranslateAll = async () => {
      const languageChanged = targetLanguage !== previousTargetLanguageRef.current;
      const speakerChanged = detectSpeakers !== previousDetectSpeakersRef.current;

      if (!languageChanged && !speakerChanged && !pendingRetranslationRef.current) return;

      if (transcriptionSegmentsRef.current.length === 0) {
        pendingRetranslationRef.current = false;
        previousTargetLanguageRef.current = targetLanguage;
        previousDetectSpeakersRef.current = detectSpeakers;
        return;
      }

      if (isProcessing || isRetranslating) {
        pendingRetranslationRef.current = true;
        return;
      }

      pendingRetranslationRef.current = false;
      previousTargetLanguageRef.current = targetLanguage;
      previousDetectSpeakersRef.current = detectSpeakers;
      setIsRetranslating(true);

      const s = settingsRef.current;

      if (backendRef.current) {
        backendRef.current.updateConfig(
          sourceLanguageRef.current, targetLanguage, detectSpeakers,
          s.translationProvider,
          s.openaiApiKey,
          s.anthropicApiKey,
          s.theologicalGlossary,
          sermonContextRef.current,
        );
      }

      try {
        const allOriginalText = transcriptionSegmentsRef.current.map(seg => seg.original).join(' ');

        const response = await fetch('/api/retranslate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originalText: allOriginalText,
            targetLanguage,
            detectSpeakers,
            translationProvider: s.translationProvider,
            openaiApiKey: s.openaiApiKey,
            anthropicApiKey: s.anthropicApiKey,
            glossary: s.theologicalGlossary || undefined,
            sermonContext: sermonContextRef.current || undefined,
          }),
        });

        if (!response.ok) throw new Error('Re-translation failed');

        const data = await response.json();
        transcriptionSegmentsRef.current = [{ original: allOriginalText, translated: data.translatedText }];
        setOriginalText(allOriginalText);
        setTranslatedText(data.translatedText);
        applySubtitlesFromText(data.translatedText);
      } catch (error) {
        console.error('Re-translation error:', error);
        toast({ title: 'Re-translation failed', description: 'Could not translate to the new language.', variant: 'destructive' });
      } finally {
        setIsRetranslating(false);
      }
    };

    retranslateAll();
  }, [targetLanguage, detectSpeakers, isProcessing, isRetranslating]);

  const swapLanguages = useCallback(() => {
    setSourceLanguage(prev => { setTargetLanguage(prev); return targetLanguage; });
  }, [targetLanguage]);

  const addDebugLog = useCallback((message: string) => {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    setDebugLogs(prev => [...prev.slice(-49), `[${timestamp}] ${message}`]);
  }, []);

  const improveTranscript = useCallback(async () => {
    const fullOriginal = originalText;
    if (!fullOriginal || isImproving) return;

    setIsImproving(true);
    const chars = Math.max(1, lookbackChars);
    const cutPoint = Math.max(0, fullOriginal.length - chars);
    const prefixOriginal = fullOriginal.slice(0, cutPoint);
    const tailOriginal = fullOriginal.slice(cutPoint);

    // Find which segments belong to the prefix (by accumulated char count)
    const segs = transcriptionSegmentsRef.current;
    let accumulated = 0;
    let prefixSegCount = 0;
    for (const seg of segs) {
      const segLen = (accumulated > 0 ? 1 : 0) + seg.original.length;
      if (accumulated + segLen > cutPoint) break;
      accumulated += segLen;
      prefixSegCount++;
    }
    const prefixSegs = segs.slice(0, prefixSegCount);
    const prefixTranslated = prefixSegs.map(s => s.translated).filter(Boolean).join(' ');

    try {
      const s = settingsRef.current;
      const response = await fetch('/api/retroactive-correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accumulatedText: tailOriginal,
          targetLanguage: targetLanguageRef.current,
          detectSpeakers: detectSpeakersRef.current,
          translationProvider: s.improvementProvider,
          openaiApiKey: s.openaiApiKey,
          anthropicApiKey: s.anthropicApiKey,
          glossary: s.theologicalGlossary || undefined,
          sermonContext: sermonContextRef.current || undefined,
        }),
      });

      if (!response.ok) throw new Error('Improvement failed');
      const data = await response.json() as { correctedText: string; translatedText: string };

      const join = (a: string, b: string) => a && b ? `${a} ${b}` : a || b;
      const newOriginal = join(prefixOriginal, data.correctedText);
      const newTranslated = join(prefixTranslated, data.translatedText);

      transcriptionSegmentsRef.current = [
        ...prefixSegs,
        { original: data.correctedText, translated: data.translatedText },
      ];
      setOriginalText(newOriginal);
      setTranslatedText(newTranslated);
      applySubtitlesFromText(newTranslated);
      toast({ title: 'Transcript improved' });
    } catch (error) {
      toast({ title: 'Improvement failed', description: error instanceof Error ? error.message : 'Unknown error', variant: 'destructive' });
    } finally {
      setIsImproving(false);
    }
  }, [originalText, lookbackChars, isImproving, toast]);

  const toggleTheme = () => {
    const next = !isDark;
    setIsDark(next);
    document.documentElement.classList.toggle('dark', next);
    localStorage.setItem('theme', next ? 'dark' : 'light');
  };

  const performRetroactiveCorrection = useCallback(async () => {
    if (transcriptionSegmentsRef.current.length === 0) return;

    const allOriginalText = transcriptionSegmentsRef.current.map(s => s.original).join(' ');
    const lang = targetLanguageRef.current;
    const speakers = detectSpeakersRef.current;
    const s = settingsRef.current;

    try {
      const response = await fetch('/api/retroactive-correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          accumulatedText: allOriginalText,
          targetLanguage: lang,
          detectSpeakers: speakers,
          translationProvider: s.translationProvider,
          openaiApiKey: s.openaiApiKey,
          anthropicApiKey: s.anthropicApiKey,
          glossary: s.theologicalGlossary || undefined,
          sermonContext: sermonContextRef.current || undefined,
        }),
      });

      if (!response.ok) throw new Error('Retroactive correction failed');

      const data = await response.json();
      transcriptionSegmentsRef.current = [{ original: data.correctedText, translated: data.translatedText }];
      setOriginalText(data.correctedText);
      setTranslatedText(data.translatedText);
      applySubtitlesFromText(data.translatedText);
    } catch (error) {
      console.error('Retroactive correction error:', error);
      toast({ title: 'Retroactive correction failed', description: 'Could not perform coherence check.', variant: 'destructive' });
    }
  }, [toast]);

  const startRecording = useCallback(async () => {
    // ── Pre-flight API key validation ─────────────────────────────────────────
    if (settings.translationProvider === 'claude' && !settings.anthropicApiKey?.trim()) {
      toast({
        title: 'Anthropic API key required',
        description: 'Open Settings and enter your Anthropic API key to use Claude (Haiku).',
        variant: 'destructive',
      });
      return;
    }
    if (settings.translationProvider === 'openai' && !settings.openaiApiKey?.trim()) {
      toast({
        title: 'OpenAI API key required',
        description: 'Open Settings and enter your OpenAI API key to use GPT translation.',
        variant: 'destructive',
      });
      return;
    }

    try {
      setOriginalText('');
      setTranslatedText('');
      setPreviewText('');
      setSubtitleCurrent('');
      setSubtitlePrevious('');
      subtitleCurrentRef.current = '';
      transcriptionSegmentsRef.current = [];
      lastRetroactiveSentenceCountRef.current = 0;
      sessionCostRef.current = 0;
      setSessionCost(0);
      setDebugLogs([]);

      const chunkDurSecs = chunkDurationSecs;

      const events = {
        onReady: () => {
          setModelLoadProgress(0);
          const desc = settings.transcriptionProvider === 'browser'
            ? 'Browser speech recognition is active. Speak clearly.'
            : settings.transcriptionProvider === 'transformers'
              ? 'Local Whisper is active. Speak naturally.'
              : `Listening in ${chunkDurSecs}s intervals. Speak naturally.`;
          toast({ title: 'Recording started', description: desc });
          if (settings.debugMode) addDebugLog('Microphone ready — recording started');
        },
        onModelProgress: (loaded: number, total: number) => {
          if (total > 0) setModelLoadProgress(loaded / total);
        },
        onRawTranscript: (text: string) => { setPreviewText(text); },
        onTranslation: (original: string, translated: string) => {
          if (!original) return;
          setPreviewText('');
          transcriptionSegmentsRef.current.push({ original, translated });
          setOriginalText(prev => prev + (prev ? ' ' : '') + original);
          setTranslatedText(prev => prev + (prev ? ' ' : '') + translated);
          setPreviewText('');

          setSubtitlePrevious(subtitleCurrentRef.current);
          subtitleCurrentRef.current = translated;
          setSubtitleCurrent(translated);

          // Rough cost estimate based on chars processed
          const s = settingsRef.current;
          const chars = original.length + translated.length;
          const llmRate = s.translationProvider === 'claude' ? 1.5e-7
            : s.translationProvider === 'openai' ? 7.5e-8 : 0;
          const whisperCost = s.transcriptionProvider === 'whisper' ? 0.006 * (chunkDurSecs / 60) : 0;
          sessionCostRef.current += chars * llmRate + whisperCost;
          setSessionCost(sessionCostRef.current);

          const allText = transcriptionSegmentsRef.current.map(s => s.original).join(' ');
          const totalSentences = countSentences(allText);
          if (
            totalSentences >= 5 &&
            Math.floor(totalSentences / 5) > Math.floor(lastRetroactiveSentenceCountRef.current / 5)
          ) {
            lastRetroactiveSentenceCountRef.current = totalSentences;
            performRetroactiveCorrection();
          }
        },
        onDebug: (message: string) => { addDebugLog(message); },
        onError: (message: string) => {
          console.error('Transcription error:', message);
          if (settings.debugMode) addDebugLog(`Error: ${message}`);
          toast({ title: 'Transcription error', description: message, variant: 'destructive' });
        },
        onClose: () => {
          setIsRecording(false);
          setIsProcessing(false);
          setPreviewText('');
          setModelLoadProgress(0);
          stopMonitoring();
          wakeLockRef.current?.release().catch(() => {});
          wakeLockRef.current = null;
          // Auto-save completed session to IndexedDB
          const segments = transcriptionSegmentsRef.current;
          if (segments.length > 0) {
            const orig = segments.map(s => s.original).join(' ');
            const trans = segments.map(s => s.translated).join(' ');
            saveSession({
              id: crypto.randomUUID(),
              createdAt: Date.now(),
              sourceLanguage,
              targetLanguage,
              originalText: orig,
              translatedText: trans,
              sessionCost: sessionCostRef.current,
              transcriptionProvider: settings.transcriptionProvider,
              translationProvider: settings.translationProvider,
            }).catch(() => {});
          }
        },
        onStreamReady: (stream: MediaStream) => {
          startMonitoring(stream);
        },
      };

      let backend: AnyTranscriptionBackend;

      backendRef.current = null;
      setIsRecording(true);
      setIsProcessing(true);

      if (settings.transcriptionProvider === 'transformers') {
        const localBackend = new LocalWhisperTranscription(events, chunkDurationSecs * 1000);
        backend = localBackend;
        backendRef.current = backend;
        await localBackend.start(
          sourceLanguage,
          targetLanguage,
          detectSpeakers,
          settings.translationProvider,
          settings.openaiApiKey,
          settings.anthropicApiKey,
          settings.localWhisperModel,
        );
      } else if (settings.transcriptionProvider === 'browser') {
        backend = new BrowserSpeechTranscription(events);
        backendRef.current = backend;
        await backend.start(
          sourceLanguage,
          targetLanguage,
          detectSpeakers,
          settings.translationProvider,
          settings.openaiApiKey,
          settings.anthropicApiKey,
          settings.theologicalGlossary,
          sermonContextRef.current,
        );
      } else {
        // Default: AssemblyAI real-time streaming (PCM16 over WebSocket)
        const streamingBackend = new StreamingTranscription(events);
        backend = streamingBackend;
        backendRef.current = backend;
        if (settings.debugMode) addDebugLog('Requesting microphone and connecting to AssemblyAI…');
        await streamingBackend.start(
          sourceLanguage,
          targetLanguage,
          detectSpeakers,
          settings.translationProvider,
          settings.openaiApiKey,
          settings.anthropicApiKey,
          settings.theologicalGlossary,
          sermonContextRef.current,
          settings.debugMode,
        );
      }

      // Prevent screen from sleeping during a 45-min sermon
      if ('wakeLock' in navigator) {
        try {
          wakeLockRef.current = await (navigator as Navigator & { wakeLock: { request(type: string): Promise<WakeLockSentinel> } }).wakeLock.request('screen');
        } catch { /* not critical */ }
      }

      setIsProcessing(false);
    } catch (error) {
      console.error('Error starting recording:', error);
      setIsRecording(false);
      setIsProcessing(false);
      toast({
        title: 'Failed to start recording',
        description: error instanceof Error ? error.message : 'Please check microphone permissions.',
        variant: 'destructive',
      });
    }
  }, [sourceLanguage, targetLanguage, detectSpeakers, settings, chunkDurationSecs, toast, performRetroactiveCorrection, addDebugLog]);

  const stopRecording = useCallback(async () => {
    if (!isRecording) return;
    setIsProcessing(true);
    if (settings.debugMode) addDebugLog('Stop requested — flushing final chunk…');

    stopMonitoring();
    await wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;

    if (backendRef.current) {
      await backendRef.current.stop();
      backendRef.current = null;
    }

    setIsRecording(false);
    setIsProcessing(false);
    setPreviewText('');
    toast({ title: 'Recording stopped', description: 'All audio has been processed.' });
  }, [isRecording, toast, stopMonitoring, settings.debugMode, addDebugLog]);

  const displayOriginalText = previewText
    ? (originalText ? originalText + ' ' + previewText : previewText)
    : originalText;

  const translationTitle = isRetranslating
    ? 'Translation (updating…)'
    : settings.translationProvider === 'none'
      ? 'Transcription only'
      : 'Translation';

  const showOriginal = settings.displayContent === 'original' || settings.displayContent === 'both';
  const showTranslation = settings.displayContent === 'translation' || settings.displayContent === 'both';

  const configSummary = [
    `${getLanguageName(sourceLanguage)} → ${getLanguageName(targetLanguage)}`,
    settings.speechMode === 'monologue' ? 'Monologue' : 'Dialogue',
    settings.transcriptionProvider === 'browser' ? 'Browser' : 'Whisper',
  ].join('  ·  ');

  return (
    <div className="flex flex-col h-screen bg-background text-foreground">
      <Header
        onThemeToggle={toggleTheme}
        onSettingsOpen={() => setIsSettingsOpen(true)}
        isDark={isDark}
      />

      {/* ── Config strip ─────────────────────────────────────────────────── */}
      <Collapsible open={isConfigOpen} onOpenChange={setIsConfigOpen}>
        <CollapsibleTrigger asChild>
          <button
            className="w-full flex items-center gap-2 px-4 py-2.5 border-b border-border bg-background hover:bg-muted/30 transition-colors text-left"
            data-testid="button-configure-toggle"
          >
            {isRecording && (
              <span className="flex h-2 w-2 shrink-0">
                <span className="animate-ping absolute inline-flex h-2 w-2 rounded-full bg-red-500 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
              </span>
            )}
            <span className="text-sm text-muted-foreground truncate">{configSummary}</span>
            {sermonContext && (
              <>
                <span className="text-muted-foreground/40 shrink-0">·</span>
                <span className="text-sm text-muted-foreground/70 truncate italic">{sermonContext}</span>
              </>
            )}
            {isConfigOpen
              ? <ChevronUp className="ml-auto shrink-0 h-4 w-4 text-muted-foreground/60" />
              : <ChevronDown className="ml-auto shrink-0 h-4 w-4 text-muted-foreground/60" />
            }
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          <div className="px-4 pt-4 pb-5 space-y-4 border-b border-border bg-background">
            {/* Language selectors */}
            <div className="flex items-end gap-2">
              <div className="flex-1">
                <LanguageSelector
                  value={sourceLanguage}
                  onChange={setSourceLanguage}
                  disabled={isRecording}
                  label="Speaking in"
                  testId="select-source-language"
                />
              </div>
              <button
                type="button"
                onClick={swapLanguages}
                disabled={isRecording}
                aria-label="Swap languages"
                className="h-12 px-2 flex items-center text-muted-foreground hover:text-foreground disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <ArrowLeftRight className="h-4 w-4" />
              </button>
              <div className="flex-1">
                <LanguageSelector
                  value={targetLanguage}
                  onChange={setTargetLanguage}
                  disabled={false}
                  label="Translate to"
                  testId="select-target-language"
                />
              </div>
            </div>

            {/* Sermon context */}
            <div className="space-y-1.5">
              <Label htmlFor="sermon-context" className="text-sm text-muted-foreground">
                Today's sermon
              </Label>
              <input
                id="sermon-context"
                type="text"
                value={sermonContext}
                onChange={(e) => setSermonContext(e.target.value)}
                placeholder="e.g. Romans 8:1–11 — Life in the Spirit"
                disabled={isRecording}
                className="w-full text-sm border border-input rounded-lg px-3 py-2 bg-background text-foreground placeholder:text-muted-foreground/60 disabled:opacity-50 focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            {/* Mode · Show · Style controls */}
            <div className="flex flex-wrap gap-x-6 gap-y-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Mode</span>
                <SegControl
                  options={[
                    { value: 'monologue', label: 'Monologue' },
                    { value: 'dialogue', label: 'Dialogue' },
                  ] as { value: SpeechMode; label: string }[]}
                  value={settings.speechMode}
                  onChange={v => updateSettings({ speechMode: v as SpeechMode })}
                  disabled={isRecording}
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Show</span>
                <SegControl
                  options={[
                    { value: 'original', label: 'Original' },
                    { value: 'translation', label: 'Translation' },
                    { value: 'both', label: 'Both' },
                  ] as { value: DisplayContent; label: string }[]}
                  value={settings.displayContent}
                  onChange={v => updateSettings({ displayContent: v as DisplayContent })}
                />
              </div>

              {showTranslation && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Style</span>
                  <SegControl
                    options={[
                      { value: 'subtitle', label: 'Subtitle' },
                      { value: 'stream', label: 'Stream' },
                    ] as { value: TextDisplay; label: string }[]}
                    value={settings.textDisplay}
                    onChange={v => updateSettings({ textDisplay: v })}
                  />
                </div>
              )}

              {settings.transcriptionProvider === 'whisper' && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Interval</span>
                  <select
                    value={chunkDurationSecs}
                    onChange={(e) => {
                      const secs = Number(e.target.value);
                      setChunkDurationSecs(secs);
                      if (backendRef.current instanceof ChunkBasedTranscription) {
                        backendRef.current.setChunkDuration(secs * 1000);
                      }
                    }}
                    className="text-sm border border-input rounded-lg px-2 py-1.5 bg-background text-foreground disabled:opacity-50"
                    data-testid="select-chunk-duration"
                  >
                    <option value={3}>3s</option>
                    <option value={5}>5s</option>
                    <option value={8}>8s</option>
                    <option value={10}>10s</option>
                    <option value={15}>15s</option>
                  </select>
                </div>
              )}
            </div>

            {/* Provider info */}
            <p className="text-xs text-muted-foreground/60">
              {settings.transcriptionProvider === 'browser' ? 'Browser speech'
                : settings.transcriptionProvider === 'transformers' ? 'Local Whisper'
                : 'Whisper'}
              {' · '}
              {settings.translationProvider === 'none'
                ? 'No translation'
                : settings.translationProvider === 'claude'
                  ? 'Claude Haiku'
                  : 'GPT-4o-mini'}
              {settings.theologicalGlossary && ' · Glossary active'}
            </p>
          </div>
        </CollapsibleContent>
      </Collapsible>

      {modelLoadProgress > 0 && modelLoadProgress < 1 && (
        <div className="px-4 py-1 space-y-1">
          <p className="text-xs text-muted-foreground">Downloading model… {Math.round(modelLoadProgress * 100)}%</p>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className="h-full bg-primary transition-all duration-300 rounded-full"
              style={{ width: `${modelLoadProgress * 100}%` }}
            />
          </div>
        </div>
      )}

      {/* ── Improve transcript bar ───────────────────────────────────────── */}
      {(isRecording || originalText) && (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-background">
          <button
            type="button"
            onClick={improveTranscript}
            disabled={isImproving || !originalText}
            className="flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-md border border-border bg-background hover:bg-muted/50 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            {isImproving
              ? <Loader2 className="h-3 w-3 animate-spin" />
              : <Wand2 className="h-3 w-3" />}
            {isImproving ? 'Improving…' : 'Improve'}
          </button>
          <span className="text-xs text-muted-foreground">last</span>
          <input
            type="number"
            min={100}
            max={9999}
            step={100}
            value={lookbackChars}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!isNaN(v) && v >= 100) {
                setLookbackChars(v);
                updateSettings({ defaultLookbackChars: v });
              }
            }}
            className="w-16 text-xs border border-input rounded-md px-2 py-1 bg-background text-foreground text-center [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
          />
          <span className="text-xs text-muted-foreground">chars</span>
        </div>
      )}

      {/* ── Text display ──────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-hidden flex flex-col pb-24">
        {showOriginal && (
          <div className={`${showTranslation ? 'flex-1' : 'flex-[1]'} overflow-hidden ${showTranslation ? 'border-b border-border' : ''}`}>
            <TranscriptionDisplay
              title="Original"
              text={displayOriginalText}
              testId="text-original"
              isRTL={getLanguageRTL(sourceLanguage)}
              isPartial={!!previewText}
            />
          </div>
        )}

        {showTranslation && (
          <div className={`${showOriginal ? 'flex-1' : 'flex-[1]'} overflow-hidden`}>
            {settings.textDisplay === 'subtitle' ? (
              <SubtitleView
                current={subtitleCurrent}
                previous={subtitlePrevious}
                isRTL={getLanguageRTL(targetLanguage)}
              />
            ) : (
              <TranscriptionDisplay
                title={translationTitle}
                text={translatedText}
                testId="text-translation"
                isRTL={getLanguageRTL(targetLanguage)}
                displayStyle="stream"
              />
            )}
          </div>
        )}
      </div>

      {/* ── Debug overlay ────────────────────────────────────────────────── */}
      {settings.debugMode && debugLogs.length > 0 && (
        <div className="fixed bottom-[88px] left-0 right-0 mx-4 z-10">
          <div className="rounded-lg border border-border bg-background/95 backdrop-blur-sm shadow-lg overflow-hidden">
            <div className="px-3 py-1.5 border-b border-border flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground">Debug log</span>
              <button
                type="button"
                onClick={() => setDebugLogs([])}
                className="text-xs text-muted-foreground hover:text-foreground"
              >
                Clear
              </button>
            </div>
            <div className="max-h-32 overflow-y-auto px-3 py-2 space-y-0.5">
              {debugLogs.map((log, i) => (
                <p key={i} className="text-xs font-mono text-muted-foreground leading-relaxed">{log}</p>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── Fixed bottom action bar ───────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-border bg-background/95 backdrop-blur-sm px-6 py-4">
        <div className="flex items-center justify-between max-w-sm mx-auto">
          <div className="w-20">
            {quality.level > 0 && (
              <div className="flex items-end gap-0.5 h-5">
                {Array.from({ length: 8 }, (_, i) => (
                  <div
                    key={i}
                    className={`w-1.5 rounded-sm transition-all duration-100 ${
                      i / 8 < quality.level
                        ? quality.isClipping ? 'bg-red-500' : i / 8 > 0.7 ? 'bg-yellow-400' : 'bg-green-500'
                        : 'bg-muted'
                    }`}
                    style={{ height: `${((i + 1) / 8) * 100}%` }}
                  />
                ))}
              </div>
            )}
          </div>

          <RecordButton
            isRecording={isRecording}
            isProcessing={isProcessing}
            onClick={isRecording ? stopRecording : startRecording}
          />

          <div className="w-20 flex flex-col items-end gap-1">
            <div className="flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setIsExportDialogOpen(true)}
                disabled={!originalText && !translatedText}
                data-testid="button-export"
                className="text-muted-foreground hover:text-foreground gap-1.5"
              >
                <Download className="h-4 w-4" />
                Export
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => setIsHistoryOpen(true)}
                className="h-8 w-8"
                aria-label="Session history"
                data-testid="button-history"
              >
                <History className="h-4 w-4" />
              </Button>
            </div>
            {sessionCost >= 0.001 && (
              <span className="text-xs text-muted-foreground/50">~${sessionCost.toFixed(3)}</span>
            )}
          </div>
        </div>
      </div>

      {/* ── Dialogs ──────────────────────────────────────────────────────── */}
      <ExportDialog
        isOpen={isExportDialogOpen}
        onClose={() => setIsExportDialogOpen(false)}
        originalText={originalText}
        translatedText={translatedText}
        targetLanguage={targetLanguage}
        sourceLanguage={sourceLanguage}
      />

      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onUpdate={updateSettings}
        webGpuSupported={webGpuSupported}
      />

      <SessionHistoryDialog
        isOpen={isHistoryOpen}
        onClose={() => setIsHistoryOpen(false)}
      />
    </div>
  );
}

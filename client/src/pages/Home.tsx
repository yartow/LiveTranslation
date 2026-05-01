import { useState, useRef, useEffect, useCallback } from 'react';
import Header from '@/components/Header';
import LanguageSelector, { getLanguageRTL, getLanguageName } from '@/components/LanguageSelector';
import RecordButton from '@/components/RecordButton';
import TranscriptionDisplay from '@/components/TranscriptionDisplay';
import SubtitleView from '@/components/SubtitleView';
import SettingsDialog from '@/components/SettingsDialog';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, ChevronUp, Download } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useSettings } from '@/hooks/useSettings';
import type { SpeechMode, DisplayContent, TextDisplay } from '@/hooks/useSettings';
import ExportDialog from '@/components/ExportDialog';
import { ChunkBasedTranscription } from '@/lib/chunk-based-transcription';
import { BrowserSpeechTranscription } from '@/lib/browser-speech-transcription';
import { countSentences } from '@/lib/text-utils';

type AnyTranscriptionBackend = ChunkBasedTranscription | BrowserSpeechTranscription;

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
  const [sourceLanguage, setSourceLanguage] = useState('en');
  const [targetLanguage, setTargetLanguage] = useState('nl');
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
  const [chunkDurationSecs, setChunkDurationSecs] = useState(5);

  const [subtitleCurrent, setSubtitleCurrent] = useState('');
  const [subtitlePrevious, setSubtitlePrevious] = useState('');
  const subtitleCurrentRef = useRef('');

  const [sermonContext, setSermonContext] = useState('');
  const sermonContextRef = useRef('');
  useEffect(() => { sermonContextRef.current = sermonContext; }, [sermonContext]);

  const { settings, updateSettings } = useSettings();
  const detectSpeakers = settings.speechMode === 'dialogue';

  const backendRef = useRef<AnyTranscriptionBackend | null>(null);
  const transcriptionSegmentsRef = useRef<TranscriptionSegment[]>([]);
  const pendingRetranslationRef = useRef(false);
  const previousTargetLanguageRef = useRef(targetLanguage);
  const previousDetectSpeakersRef = useRef(detectSpeakers);
  const lastRetroactiveSentenceCountRef = useRef(0);
  const { toast } = useToast();

  const targetLanguageRef = useRef(targetLanguage);
  const detectSpeakersRef = useRef(detectSpeakers);
  const settingsRef = useRef(settings);

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

      if (backendRef.current) {
        backendRef.current.updateConfig(
          sourceLanguage, targetLanguage, detectSpeakers,
          settings.translationProvider,
          settings.openaiApiKey,
          settings.anthropicApiKey,
          settings.theologicalGlossary,
          sermonContextRef.current,
        );
      }

      try {
        const allOriginalText = transcriptionSegmentsRef.current.map(s => s.original).join(' ');

        const response = await fetch('/api/retranslate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originalText: allOriginalText,
            targetLanguage,
            detectSpeakers,
            translationProvider: settings.translationProvider,
            openaiApiKey: settings.openaiApiKey,
            anthropicApiKey: settings.anthropicApiKey,
            glossary: settings.theologicalGlossary || undefined,
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
    try {
      setOriginalText('');
      setTranslatedText('');
      setPreviewText('');
      setSubtitleCurrent('');
      setSubtitlePrevious('');
      subtitleCurrentRef.current = '';
      transcriptionSegmentsRef.current = [];
      lastRetroactiveSentenceCountRef.current = 0;

      const events = {
        onReady: () => {
          const desc = settings.transcriptionProvider === 'browser'
            ? 'Browser speech recognition is active. Speak clearly.'
            : `Listening in ${chunkDurationSecs}s intervals. Speak naturally.`;
          toast({ title: 'Recording started', description: desc });
        },
        onRawTranscript: (text: string) => { setPreviewText(text); },
        onTranslation: (original: string, translated: string) => {
          if (!original) return;
          transcriptionSegmentsRef.current.push({ original, translated });
          setOriginalText(prev => prev + (prev ? ' ' : '') + original);
          setTranslatedText(prev => prev + (prev ? ' ' : '') + translated);
          setPreviewText('');

          setSubtitlePrevious(subtitleCurrentRef.current);
          subtitleCurrentRef.current = translated;
          setSubtitleCurrent(translated);

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
        onError: (message: string) => {
          console.error('Transcription error:', message);
          toast({ title: 'Transcription error', description: message, variant: 'destructive' });
        },
        onClose: () => {
          setIsRecording(false);
          setIsProcessing(false);
          setPreviewText('');
        },
      };

      let backend: AnyTranscriptionBackend;
      if (settings.transcriptionProvider === 'browser') {
        backend = new BrowserSpeechTranscription(events);
      } else {
        backend = new ChunkBasedTranscription(events, chunkDurationSecs * 1000);
      }

      backendRef.current = backend;
      setIsRecording(true);
      setIsProcessing(true);

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
  }, [sourceLanguage, targetLanguage, detectSpeakers, settings, chunkDurationSecs, toast, performRetroactiveCorrection]);

  const stopRecording = useCallback(async () => {
    if (!isRecording) return;
    setIsProcessing(true);

    if (backendRef.current) {
      await backendRef.current.stop();
      backendRef.current = null;
    }

    setIsRecording(false);
    setIsProcessing(false);
    setPreviewText('');
    toast({ title: 'Recording stopped', description: 'All audio has been processed.' });
  }, [isRecording, toast]);

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

  // Config summary line shown when the panel is collapsed
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
            <div className="grid grid-cols-2 gap-3">
              <LanguageSelector
                value={sourceLanguage}
                onChange={setSourceLanguage}
                disabled={isRecording}
                label="Speaking in"
                testId="select-source-language"
              />
              <LanguageSelector
                value={targetLanguage}
                onChange={setTargetLanguage}
                disabled={false}
                label="Translate to"
                testId="select-target-language"
              />
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
                <SegControl<SpeechMode>
                  options={[
                    { value: 'monologue', label: 'Monologue' },
                    { value: 'dialogue', label: 'Dialogue' },
                  ]}
                  value={settings.speechMode}
                  onChange={v => updateSettings({ speechMode: v })}
                  disabled={isRecording}
                />
              </div>

              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Show</span>
                <SegControl<DisplayContent>
                  options={[
                    { value: 'original', label: 'Original' },
                    { value: 'translation', label: 'Translation' },
                    { value: 'both', label: 'Both' },
                  ]}
                  value={settings.displayContent}
                  onChange={v => updateSettings({ displayContent: v })}
                />
              </div>

              {showTranslation && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-muted-foreground">Style</span>
                  <SegControl<TextDisplay>
                    options={[
                      { value: 'subtitle', label: 'Subtitle' },
                      { value: 'stream', label: 'Stream' },
                    ]}
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
                    onChange={(e) => setChunkDurationSecs(Number(e.target.value))}
                    disabled={isRecording}
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
              {settings.transcriptionProvider === 'browser' ? 'Browser speech' : 'Whisper'}
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

      {/* ── Fixed bottom action bar ───────────────────────────────────────── */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-border bg-background/95 backdrop-blur-sm px-6 py-4">
        <div className="flex items-center justify-between max-w-sm mx-auto">
          <div className="w-20" />

          <RecordButton
            isRecording={isRecording}
            isProcessing={isProcessing}
            onClick={isRecording ? stopRecording : startRecording}
          />

          <div className="w-20 flex justify-end">
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
      />

      <SettingsDialog
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        settings={settings}
        onUpdate={updateSettings}
      />
    </div>
  );
}

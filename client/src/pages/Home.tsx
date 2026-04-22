import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Header from '@/components/Header';
import LanguageSelector, { getLanguageRTL } from '@/components/LanguageSelector';
import RecordButton from '@/components/RecordButton';
import RecordingIndicator from '@/components/RecordingIndicator';
import TranscriptionDisplay from '@/components/TranscriptionDisplay';
import SettingsDialog from '@/components/SettingsDialog';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, ChevronUp, Download } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useSettings } from '@/hooks/useSettings';
import ExportDialog from '@/components/ExportDialog';
import { ChunkBasedTranscription } from '@/lib/chunk-based-transcription';
import { BrowserSpeechTranscription } from '@/lib/browser-speech-transcription';

type AnyTranscriptionBackend = ChunkBasedTranscription | BrowserSpeechTranscription;

interface TranscriptionSegment {
  original: string;
  translated: string;
}

export default function Home() {
  const [sourceLanguage, setSourceLanguage] = useState('en');
  const [targetLanguage, setTargetLanguage] = useState('nl');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [originalText, setOriginalText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  // Raw Whisper / interim SpeechRecognition output shown as greyed-out preview
  const [previewText, setPreviewText] = useState('');
  const [isDark, setIsDark] = useState(false);
  const [isRetranslating, setIsRetranslating] = useState(false);
  const [detectSpeakers, setDetectSpeakers] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(true);
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [chunkDurationSecs, setChunkDurationSecs] = useState(5);

  const { settings, updateSettings } = useSettings();

  const backendRef = useRef<AnyTranscriptionBackend | null>(null);
  const transcriptionSegmentsRef = useRef<TranscriptionSegment[]>([]);
  const pendingRetranslationRef = useRef(false);
  const previousTargetLanguageRef = useRef(targetLanguage);
  const previousDetectSpeakersRef = useRef(detectSpeakers);
  const lastRetroactiveSentenceCountRef = useRef(0);
  const { toast } = useToast();

  // Keep refs in sync so async callbacks always read the latest values
  // without causing stale-closure bugs when called from startRecording's events.
  const sourceLanguageRef = useRef(sourceLanguage);
  const targetLanguageRef = useRef(targetLanguage);
  const detectSpeakersRef = useRef(detectSpeakers);
  const settingsRef = useRef(settings);

  useEffect(() => { sourceLanguageRef.current = sourceLanguage; }, [sourceLanguage]);
  useEffect(() => { targetLanguageRef.current = targetLanguage; }, [targetLanguage]);
  useEffect(() => { detectSpeakersRef.current = detectSpeakers; }, [detectSpeakers]);
  useEffect(() => { settingsRef.current = settings; }, [settings]);

  useEffect(() => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const savedTheme = localStorage.getItem('theme');
    const shouldBeDark = savedTheme === 'dark' || (!savedTheme && prefersDark);
    setIsDark(shouldBeDark);
    if (shouldBeDark) document.documentElement.classList.add('dark');
  }, []);

  // Re-translate all accumulated text when target language or speaker detection changes
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
          }),
        });

        if (!response.ok) throw new Error('Re-translation failed');

        const data = await response.json();
        transcriptionSegmentsRef.current = [{ original: allOriginalText, translated: data.translatedText }];
        setOriginalText(allOriginalText);
        setTranslatedText(data.translatedText);
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
    setIsDark(!isDark);
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', !isDark ? 'dark' : 'light');
  };

  const countSentences = (text: string): number => {
    if (!text.trim()) return 0;
    return (text.match(/[.!?]+/g) || []).length;
  };

  // Uses refs so it always reads current targetLanguage/detectSpeakers/settings
  // regardless of when it was captured in a callback closure.
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
        }),
      });

      if (!response.ok) throw new Error('Retroactive correction failed');

      const data = await response.json();
      transcriptionSegmentsRef.current = [{ original: data.correctedText, translated: data.translatedText }];
      setOriginalText(data.correctedText);
      setTranslatedText(data.translatedText);
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
      transcriptionSegmentsRef.current = [];
      lastRetroactiveSentenceCountRef.current = 0;

      const events = {
        onReady: () => {
          const desc = settings.transcriptionProvider === 'browser'
            ? 'Browser speech recognition is active. Speak clearly.'
            : `Listening in ${chunkDurationSecs}s intervals. Speak naturally.`;
          toast({ title: 'Recording started', description: desc });
        },
        onRawTranscript: (text: string) => {
          setPreviewText(text);
        },
        onTranslation: (original: string, translated: string) => {
          if (!original) return;
          setPreviewText('');
          transcriptionSegmentsRef.current.push({ original, translated });
          setOriginalText(prev => prev + (prev ? ' ' : '') + original);
          setTranslatedText(prev => prev + (prev ? ' ' : '') + translated);

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

  const handleRecordClick = () => {
    if (isRecording) stopRecording();
    else startRecording();
  };

  const displayOriginalText = previewText
    ? (originalText ? originalText + ' ' + previewText : previewText)
    : originalText;

  const translationTitle = useMemo(() => {
    if (isRetranslating) return 'Translation (updating...)';
    if (settings.translationProvider === 'none') return 'Translation (disabled)';
    return 'Translation';
  }, [isRetranslating, settings.translationProvider]);

  return (
    <div className="flex flex-col h-screen bg-background">
      <Header onThemeToggle={toggleTheme} onSettingsOpen={() => setIsSettingsOpen(true)} />

      <div className="relative flex-1 flex flex-col overflow-hidden">
        <RecordingIndicator isRecording={isRecording} />

        <div className="p-4 space-y-4 bg-background border-b border-border">
          <Collapsible open={isConfigOpen} onOpenChange={setIsConfigOpen}>
            <div className="flex items-center justify-between mb-3">
              <CollapsibleTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex items-center gap-2 px-0"
                  data-testid="button-configure-toggle"
                >
                  {isConfigOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  <span className="text-sm font-medium">Configure</span>
                </Button>
              </CollapsibleTrigger>
            </div>

            <CollapsibleContent className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
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

              <div className="flex flex-wrap items-center gap-6">
                <div className="flex items-center space-x-2">
                  <Checkbox
                    id="speaker-detection"
                    checked={detectSpeakers}
                    onCheckedChange={(checked) => setDetectSpeakers(checked as boolean)}
                    disabled={isRecording}
                    data-testid="checkbox-speaker-detection"
                  />
                  <Label
                    htmlFor="speaker-detection"
                    className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
                  >
                    Detect different speakers
                  </Label>
                </div>

                {settings.transcriptionProvider === 'whisper' && (
                  <div className="flex items-center gap-2">
                    <Label htmlFor="chunk-duration" className="text-sm font-medium whitespace-nowrap">
                      Listen interval:
                    </Label>
                    <select
                      id="chunk-duration"
                      value={chunkDurationSecs}
                      onChange={(e) => setChunkDurationSecs(Number(e.target.value))}
                      disabled={isRecording}
                      className="text-sm border border-input rounded px-2 py-1 bg-background"
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

                {/* Provider badges */}
                <div className="flex items-center gap-2 ml-auto">
                  <span className="text-xs text-muted-foreground">
                    {settings.transcriptionProvider === 'browser' ? '🎤 Browser' : '🎙 Whisper'}
                    {' · '}
                    {settings.translationProvider === 'none' ? 'No translation' :
                      settings.translationProvider === 'claude' ? '🤖 Claude' : '⚡ GPT-4o-mini'}
                  </span>
                </div>
              </div>
            </CollapsibleContent>
          </Collapsible>

          <div className="flex items-center gap-3">
            <RecordButton
              isRecording={isRecording}
              isProcessing={isProcessing}
              onClick={handleRecordClick}
            />
            <Button
              variant="outline"
              size="default"
              onClick={() => setIsExportDialogOpen(true)}
              disabled={!originalText && !translatedText}
              className="flex items-center gap-2"
              data-testid="button-export"
            >
              <Download className="h-4 w-4" />
              Export
            </Button>
          </div>
        </div>

        <div className="flex-1 flex flex-col gap-6 overflow-hidden pb-20">
          <div className="flex-1 bg-card rounded-lg mx-4 mt-6 min-h-[200px] border border-card-border">
            <TranscriptionDisplay
              title="Original"
              text={displayOriginalText}
              testId="text-original"
              isRTL={getLanguageRTL(sourceLanguage)}
              isPartial={!!previewText}
            />
          </div>

          <div className="flex-1 bg-card rounded-lg mx-4 mb-6 min-h-[200px] border border-card-border">
            <TranscriptionDisplay
              title={translationTitle}
              text={translatedText}
              testId="text-translation"
              isRTL={getLanguageRTL(targetLanguage)}
            />
          </div>
        </div>
      </div>

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

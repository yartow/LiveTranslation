import { useState, useRef, useEffect, useCallback } from 'react';
import Header from '@/components/Header';
import LanguageSelector, { getLanguageRTL } from '@/components/LanguageSelector';
import RecordButton from '@/components/RecordButton';
import RecordingIndicator from '@/components/RecordingIndicator';
import TranscriptionDisplay from '@/components/TranscriptionDisplay';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { ChevronDown, ChevronUp, Download } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import ExportDialog from '@/components/ExportDialog';
import { ChunkBasedTranscription } from '@/lib/chunk-based-transcription';

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
  // Shows the most recent raw Whisper output as a live preview while GPT
  // correction is in progress
  const [previewText, setPreviewText] = useState('');
  const [isDark, setIsDark] = useState(false);
  const [isRetranslating, setIsRetranslating] = useState(false);
  const [detectSpeakers, setDetectSpeakers] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(true);
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  // Chunk duration in seconds (how long each audio chunk is before it is sent
  // to Whisper; shorter = more responsive, longer = better context for Whisper)
  const [chunkDurationSecs, setChunkDurationSecs] = useState(5);

  const chunkRef = useRef<ChunkBasedTranscription | null>(null);
  const transcriptionSegmentsRef = useRef<TranscriptionSegment[]>([]);
  const pendingRetranslationRef = useRef(false);
  const previousTargetLanguageRef = useRef(targetLanguage);
  const previousDetectSpeakersRef = useRef(detectSpeakers);
  const lastRetroactiveCorrectionSentenceCountRef = useRef(0);
  const { toast } = useToast();

  useEffect(() => {
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const savedTheme = localStorage.getItem('theme');
    const shouldBeDark = savedTheme === 'dark' || (!savedTheme && prefersDark);

    setIsDark(shouldBeDark);
    if (shouldBeDark) {
      document.documentElement.classList.add('dark');
    }
  }, []);

  // Re-translate all accumulated text when the target language or speaker
  // detection setting changes
  useEffect(() => {
    const retranslateAll = async () => {
      const languageChanged = targetLanguage !== previousTargetLanguageRef.current;
      const speakerDetectionChanged = detectSpeakers !== previousDetectSpeakersRef.current;

      if (!languageChanged && !speakerDetectionChanged && !pendingRetranslationRef.current) {
        return;
      }

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

      if (chunkRef.current) {
        chunkRef.current.updateConfig(sourceLanguage, targetLanguage, detectSpeakers);
      }

      try {
        const allOriginalText = transcriptionSegmentsRef.current
          .map(seg => seg.original)
          .join(' ');

        const response = await fetch('/api/retranslate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ originalText: allOriginalText, targetLanguage, detectSpeakers }),
        });

        if (!response.ok) throw new Error('Re-translation failed');

        const data = await response.json();

        transcriptionSegmentsRef.current = [{
          original: allOriginalText,
          translated: data.translatedText,
        }];

        setOriginalText(allOriginalText);
        setTranslatedText(data.translatedText);
      } catch (error) {
        console.error('Re-translation error:', error);
        toast({
          title: "Re-translation failed",
          description: "Could not translate to the new language.",
          variant: "destructive",
        });
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
    const sentences = text.match(/[.!?]+/g);
    return sentences ? sentences.length : 0;
  };

  const performRetroactiveCorrection = async () => {
    if (transcriptionSegmentsRef.current.length === 0) return;

    const allOriginalText = transcriptionSegmentsRef.current
      .map(seg => seg.original)
      .join(' ');

    try {
      const response = await fetch('/api/retroactive-correct', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accumulatedText: allOriginalText, targetLanguage, detectSpeakers }),
      });

      if (!response.ok) throw new Error('Retroactive correction failed');

      const data = await response.json();

      transcriptionSegmentsRef.current = [{
        original: data.correctedText,
        translated: data.translatedText,
      }];

      setOriginalText(data.correctedText);
      setTranslatedText(data.translatedText);
    } catch (error) {
      console.error('Retroactive correction error:', error);
      toast({
        title: "Retroactive correction failed",
        description: "Could not perform coherence check and grammar correction.",
        variant: "destructive",
      });
    }
  };

  const startRecording = useCallback(async () => {
    try {
      setOriginalText('');
      setTranslatedText('');
      setPreviewText('');
      transcriptionSegmentsRef.current = [];
      lastRetroactiveCorrectionSentenceCountRef.current = 0;

      const chunk = new ChunkBasedTranscription(
        {
          onReady: () => {
            toast({
              title: "Recording started",
              description: `Listening in ${chunkDurationSecs}s intervals. Speak naturally.`,
            });
          },

          // Raw Whisper output arrives while GPT correction is in progress.
          // Show it greyed-out as a live preview.
          onRawTranscript: (text) => {
            setPreviewText(text);
          },

          // Final corrected + translated result, delivered in recording order.
          onTranslation: (original, translated) => {
            transcriptionSegmentsRef.current.push({ original, translated });
            setOriginalText(prev => prev + (prev ? ' ' : '') + original);
            setTranslatedText(prev => prev + (prev ? ' ' : '') + translated);

            const allOriginalText = transcriptionSegmentsRef.current
              .map(seg => seg.original)
              .join(' ');
            const totalSentences = countSentences(allOriginalText);

            if (
              totalSentences >= 5 &&
              Math.floor(totalSentences / 5) >
                Math.floor(lastRetroactiveCorrectionSentenceCountRef.current / 5)
            ) {
              lastRetroactiveCorrectionSentenceCountRef.current = totalSentences;
              performRetroactiveCorrection();
            }
          },

          onError: (message) => {
            console.error('Chunk transcription error:', message);
            toast({
              title: "Transcription error",
              description: message,
              variant: "destructive",
            });
          },

          onClose: () => {
            setIsRecording(false);
            setIsProcessing(false);
            setPreviewText('');
          },
        },
        chunkDurationSecs * 1000,
      );

      chunkRef.current = chunk;
      setIsRecording(true);
      setIsProcessing(true);

      await chunk.start(sourceLanguage, targetLanguage, detectSpeakers);
      setIsProcessing(false);

    } catch (error) {
      console.error('Error starting recording:', error);
      setIsRecording(false);
      setIsProcessing(false);
      toast({
        title: "Failed to start recording",
        description: error instanceof Error ? error.message : "Please check microphone permissions.",
        variant: "destructive",
      });
    }
  }, [sourceLanguage, targetLanguage, detectSpeakers, chunkDurationSecs, toast]);

  const stopRecording = useCallback(async () => {
    if (!isRecording) return;

    setIsProcessing(true);

    if (chunkRef.current) {
      await chunkRef.current.stop();
      chunkRef.current = null;
    }

    setIsRecording(false);
    setIsProcessing(false);
    setPreviewText('');

    toast({
      title: "Recording stopped",
      description: "All audio has been processed.",
    });
  }, [isRecording, toast]);

  const handleRecordClick = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  // Combine confirmed text with the in-flight Whisper preview
  const displayOriginalText = previewText
    ? (originalText ? originalText + ' ' + previewText : previewText)
    : originalText;

  return (
    <div className="flex flex-col h-screen bg-background">
      <Header onThemeToggle={toggleTheme} />

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

              <div className="flex items-center gap-6">
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
              title={isRetranslating ? "Translation (updating...)" : "Translation"}
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
    </div>
  );
}

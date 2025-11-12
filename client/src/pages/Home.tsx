import { useState, useRef, useEffect } from 'react';
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
  const [isDark, setIsDark] = useState(false);
  const [isRetranslating, setIsRetranslating] = useState(false);
  const [detectSpeakers, setDetectSpeakers] = useState(false);
  const [isConfigOpen, setIsConfigOpen] = useState(true);
  const [isExportDialogOpen, setIsExportDialogOpen] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunkQueueRef = useRef<Blob[]>([]);
  const isProcessingQueueRef = useRef(false);
  const transcriptionSegmentsRef = useRef<TranscriptionSegment[]>([]);
  const pendingRetranslationRef = useRef(false);
  const previousTargetLanguageRef = useRef(targetLanguage);
  const previousDetectSpeakersRef = useRef(detectSpeakers);
  const isRecordingRef = useRef(false);
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

      const segmentCountBeforeTranslation = transcriptionSegmentsRef.current.length;
      pendingRetranslationRef.current = false;
      previousTargetLanguageRef.current = targetLanguage;
      previousDetectSpeakersRef.current = detectSpeakers;
      setIsRetranslating(true);
      
      try {
        const allOriginalText = transcriptionSegmentsRef.current
          .map(seg => seg.original)
          .join(' ');

        const response = await fetch('/api/retranslate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            originalText: allOriginalText,
            targetLanguage,
            detectSpeakers
          }),
        });

        if (!response.ok) {
          throw new Error('Re-translation failed');
        }

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
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          accumulatedText: allOriginalText,
          targetLanguage,
          detectSpeakers,
        }),
      });

      if (!response.ok) {
        throw new Error('Retroactive correction failed');
      }

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

  const processNextChunk = async () => {
    if (isProcessingQueueRef.current || chunkQueueRef.current.length === 0) {
      return;
    }

    isProcessingQueueRef.current = true;
    setIsProcessing(true);

    const audioBlob = chunkQueueRef.current.shift()!;
    
    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');
      formData.append('sourceLanguage', sourceLanguage);
      formData.append('targetLanguage', targetLanguage);
      formData.append('detectSpeakers', String(detectSpeakers));

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.details || 'Transcription failed');
      }

      const data = await response.json();
      
      transcriptionSegmentsRef.current.push({
        original: data.originalText,
        translated: data.translatedText
      });
      
      setOriginalText(prev => prev + (prev ? ' ' : '') + data.originalText);
      setTranslatedText(prev => prev + (prev ? ' ' : '') + data.translatedText);

      const allOriginalText = transcriptionSegmentsRef.current
        .map(seg => seg.original)
        .join(' ');
      const totalSentences = countSentences(allOriginalText);
      
      if (totalSentences >= 5 && 
          Math.floor(totalSentences / 5) > Math.floor(lastRetroactiveCorrectionSentenceCountRef.current / 5)) {
        lastRetroactiveCorrectionSentenceCountRef.current = totalSentences;
        await performRetroactiveCorrection();
      }
    } catch (error) {
      console.error('Transcription error:', error);
      toast({
        title: "Transcription failed",
        description: error instanceof Error ? error.message : "Failed to transcribe audio. Please check your OpenAI API credits.",
        variant: "destructive",
      });
    } finally {
      isProcessingQueueRef.current = false;
      setIsProcessing(false);
      
      if (chunkQueueRef.current.length > 0) {
        processNextChunk();
      }
    }
  };

  const analyzeAudioVolume = async (audioBlob: Blob): Promise<boolean> => {
    return new Promise((resolve) => {
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const reader = new FileReader();
      
      reader.onload = async () => {
        try {
          const arrayBuffer = reader.result as ArrayBuffer;
          const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
          
          const channelData = audioBuffer.getChannelData(0);
          let sum = 0;
          for (let i = 0; i < channelData.length; i++) {
            sum += Math.abs(channelData[i]);
          }
          const average = sum / channelData.length;
          
          const isSilent = average < 0.01;
          resolve(!isSilent);
        } catch (error) {
          console.error('Audio analysis failed:', error);
          resolve(true);
        } finally {
          audioContext.close();
        }
      };
      
      reader.onerror = () => {
        console.error('FileReader error');
        resolve(true);
      };
      
      reader.readAsArrayBuffer(audioBlob);
    });
  };

  const enqueueAudioChunk = async (audioBlob: Blob) => {
    const hasAudio = await analyzeAudioVolume(audioBlob);
    
    if (!hasAudio) {
      console.log('Skipping silent audio chunk');
      return;
    }
    
    chunkQueueRef.current.push(audioBlob);
    processNextChunk();
  };

  const finalizeRecording = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }

    mediaRecorderRef.current = null;

    let attempts = 0;
    const maxAttempts = 60;
    const checkQueueComplete = setInterval(() => {
      attempts++;
      if (chunkQueueRef.current.length === 0 && !isProcessingQueueRef.current) {
        clearInterval(checkQueueComplete);
        toast({
          title: "Recording stopped",
          description: "All audio has been processed.",
        });
      } else if (attempts >= maxAttempts) {
        clearInterval(checkQueueComplete);
        toast({
          title: "Recording stopped",
          description: "Some audio may still be processing.",
          variant: "destructive",
        });
      }
    }, 500);
  };

  const restartRecordingCycle = () => {
    if (!isRecordingRef.current || !streamRef.current) {
      return;
    }

    const mediaRecorder = new MediaRecorder(streamRef.current, {
      mimeType: 'audio/webm',
    });

    mediaRecorderRef.current = mediaRecorder;

    mediaRecorder.ondataavailable = async (event: BlobEvent) => {
      if (event.data.size > 0) {
        await enqueueAudioChunk(event.data);
      }
      
      if (isRecordingRef.current) {
        setTimeout(() => restartRecordingCycle(), 100);
      }
    };

    mediaRecorder.onstop = () => {
      if (!isRecordingRef.current) {
        finalizeRecording();
      }
    };

    mediaRecorder.start();
    
    setTimeout(() => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
    }, 5000);
  };

  const startRecording = async () => {
    if (chunkQueueRef.current.length > 0 || isProcessingQueueRef.current) {
      toast({
        title: "Please wait",
        description: "Previous recording is still being processed.",
        variant: "destructive",
      });
      return;
    }

    try {
      setOriginalText('');
      setTranslatedText('');
      chunkQueueRef.current = [];
      transcriptionSegmentsRef.current = [];
      lastRetroactiveCorrectionSentenceCountRef.current = 0;
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100,
        } 
      });
      
      streamRef.current = stream;
      isRecordingRef.current = true;
      setIsRecording(true);
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm',
      });
      
      mediaRecorderRef.current = mediaRecorder;
      
      mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          enqueueAudioChunk(event.data);
        }
        
        if (isRecordingRef.current) {
          setTimeout(() => restartRecordingCycle(), 100);
        }
      };
      
      mediaRecorder.onstop = () => {
        if (!isRecordingRef.current) {
          finalizeRecording();
        }
      };
      
      mediaRecorder.start();
      
      setTimeout(() => {
        if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.stop();
        }
      }, 5000);
      
      toast({
        title: "Recording started",
        description: "Audio will be transcribed every 5 seconds while you speak.",
      });
    } catch (error) {
      console.error('Error accessing microphone:', error);
      toast({
        title: "Microphone access denied",
        description: "Please allow microphone access to use this feature.",
        variant: "destructive",
      });
    }
  };

  const stopRecording = () => {
    if (!isRecording) return;
    
    isRecordingRef.current = false;
    setIsRecording(false);

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (error) {
        console.error('Error stopping recorder:', error);
        finalizeRecording();
      }
    } else {
      finalizeRecording();
    }
  };

  const handleRecordClick = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

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
              text={originalText}
              testId="text-original"
              isRTL={getLanguageRTL(sourceLanguage)}
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

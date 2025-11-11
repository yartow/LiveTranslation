import { useState, useRef, useEffect } from 'react';
import Header from '@/components/Header';
import LanguageSelector, { getLanguageRTL } from '@/components/LanguageSelector';
import RecordButton from '@/components/RecordButton';
import RecordingIndicator from '@/components/RecordingIndicator';
import TranscriptionDisplay from '@/components/TranscriptionDisplay';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { useToast } from '@/hooks/use-toast';

interface TranscriptionSegment {
  original: string;
  translated: string;
}

export default function Home() {
  const [sourceLanguage, setSourceLanguage] = useState('en');
  const [targetLanguage, setTargetLanguage] = useState('es');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [originalText, setOriginalText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [isDark, setIsDark] = useState(false);
  const [isRetranslating, setIsRetranslating] = useState(false);
  const [detectSpeakers, setDetectSpeakers] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunkQueueRef = useRef<Blob[]>([]);
  const isProcessingQueueRef = useRef(false);
  const transcriptionSegmentsRef = useRef<TranscriptionSegment[]>([]);
  const pendingRetranslationRef = useRef(false);
  const previousTargetLanguageRef = useRef(targetLanguage);
  const previousDetectSpeakersRef = useRef(detectSpeakers);
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
          .join('\n\n');

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
        
        const newSegments = data.translatedText.split('\n\n');
        transcriptionSegmentsRef.current.slice(0, segmentCountBeforeTranslation).forEach((seg, i) => {
          if (newSegments[i]) {
            seg.translated = newSegments[i];
          }
        });
        
        const rebuiltTranslation = transcriptionSegmentsRef.current
          .map(seg => seg.translated)
          .join('\n\n');
        setTranslatedText(rebuiltTranslation);
        
        if (transcriptionSegmentsRef.current.length > segmentCountBeforeTranslation) {
          pendingRetranslationRef.current = true;
        }
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
      
      setOriginalText(prev => prev + (prev ? '\n\n' : '') + data.originalText);
      setTranslatedText(prev => prev + (prev ? '\n\n' : '') + data.translatedText);
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

  const enqueueAudioChunk = (audioBlob: Blob) => {
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
      
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100,
        } 
      });
      
      streamRef.current = stream;
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm',
      });
      
      mediaRecorderRef.current = mediaRecorder;
      
      mediaRecorder.ondataavailable = (event: BlobEvent) => {
        if (event.data.size > 0) {
          enqueueAudioChunk(event.data);
        }
      };
      
      mediaRecorder.onstop = () => {
        finalizeRecording();
      };
      
      mediaRecorder.start(5000);
      setIsRecording(true);
      
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
          
          <RecordButton
            isRecording={isRecording}
            isProcessing={isProcessing}
            onClick={handleRecordClick}
          />
        </div>

        <div className="flex-1 flex flex-col gap-6 overflow-hidden pb-20">
          <div className="flex-1 bg-card rounded-lg mx-4 mt-6 min-h-0 border border-card-border">
            <TranscriptionDisplay
              title="Original"
              text={originalText}
              testId="text-original"
              isRTL={getLanguageRTL(sourceLanguage)}
            />
          </div>
          
          <div className="flex-1 bg-card rounded-lg mx-4 mb-6 min-h-0 border border-card-border">
            <TranscriptionDisplay
              title={isRetranslating ? "Translation (updating...)" : "Translation"}
              text={translatedText}
              testId="text-translation"
              isRTL={getLanguageRTL(targetLanguage)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

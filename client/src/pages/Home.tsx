import { useState, useRef, useEffect } from 'react';
import Header from '@/components/Header';
import LanguageSelector from '@/components/LanguageSelector';
import RecordButton from '@/components/RecordButton';
import RecordingIndicator from '@/components/RecordingIndicator';
import TranscriptionDisplay from '@/components/TranscriptionDisplay';
import { useToast } from '@/hooks/use-toast';

export default function Home() {
  const [targetLanguage, setTargetLanguage] = useState('es');
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [originalText, setOriginalText] = useState('');
  const [translatedText, setTranslatedText] = useState('');
  const [isDark, setIsDark] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const isProcessingChunkRef = useRef(false);
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

  const toggleTheme = () => {
    setIsDark(!isDark);
    document.documentElement.classList.toggle('dark');
    localStorage.setItem('theme', !isDark ? 'dark' : 'light');
  };

  const processAudioChunk = async (audioBlob: Blob) => {
    if (isProcessingChunkRef.current) {
      return;
    }

    isProcessingChunkRef.current = true;
    setIsProcessing(true);
    
    try {
      const formData = new FormData();
      formData.append('audio', audioBlob, 'recording.webm');
      formData.append('targetLanguage', targetLanguage);

      const response = await fetch('/api/transcribe', {
        method: 'POST',
        body: formData,
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.details || 'Transcription failed');
      }

      const data = await response.json();
      
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
      isProcessingChunkRef.current = false;
      setIsProcessing(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          sampleRate: 44100,
        } 
      });
      
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: 'audio/webm',
      });
      
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = async (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
          
          const audioBlob = new Blob([event.data], { type: 'audio/webm' });
          await processAudioChunk(audioBlob);
        }
      };

      mediaRecorder.onstop = () => {
        stream.getTracks().forEach(track => track.stop());
        toast({
          title: "Recording stopped",
          description: "All audio has been processed.",
        });
      };

      mediaRecorder.start(10000);
      setIsRecording(true);
      
      toast({
        title: "Recording started",
        description: "Audio will be transcribed every 10 seconds while you speak.",
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
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
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
          <LanguageSelector
            value={targetLanguage}
            onChange={setTargetLanguage}
            disabled={isRecording}
          />
          
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
            />
          </div>
          
          <div className="flex-1 bg-card rounded-lg mx-4 mb-6 min-h-0 border border-card-border">
            <TranscriptionDisplay
              title="Translation"
              text={translatedText}
              testId="text-translation"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

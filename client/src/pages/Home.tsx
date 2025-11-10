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

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        stream.getTracks().forEach(track => track.stop());
        
        setIsProcessing(true);
        
        const mockOriginal = "And he said unto them, Go ye into all the world, and preach the gospel to every creature. For God so loved the world that he gave his only begotten Son.";
        const mockTranslations: Record<string, string> = {
          es: "Y les dijo: Id por todo el mundo y predicad el evangelio a toda criatura. Porque de tal manera amó Dios al mundo, que ha dado a su Hijo unigénito.",
          fr: "Et il leur dit: Allez par tout le monde, et prêchez la bonne nouvelle à toute la création. Car Dieu a tant aimé le monde qu'il a donné son Fils unique.",
          de: "Und er sprach zu ihnen: Gehet hin in alle Welt und predigt das Evangelium aller Kreatur. Denn also hat Gott die Welt geliebt, dass er seinen eingeborenen Sohn gab.",
        };
        
        setTimeout(() => {
          setOriginalText(prev => prev + (prev ? ' ' : '') + mockOriginal);
          setTranslatedText(prev => prev + (prev ? ' ' : '') + (mockTranslations[targetLanguage] || mockOriginal));
          setIsProcessing(false);
          
          toast({
            title: "Transcription complete",
            description: "Audio has been transcribed and translated.",
          });
        }, 2000);
      };

      mediaRecorder.start();
      setIsRecording(true);
      
      toast({
        title: "Recording started",
        description: "Speak clearly into your microphone.",
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

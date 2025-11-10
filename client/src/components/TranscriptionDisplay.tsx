import { useEffect, useRef } from 'react';

interface TranscriptionDisplayProps {
  title: string;
  text: string;
  testId?: string;
}

export default function TranscriptionDisplay({ title, text, testId }: TranscriptionDisplayProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text]);

  return (
    <div className="flex flex-col h-full">
      <div className="text-xs font-medium text-muted-foreground mb-2 px-6 pt-4">
        {title}
      </div>
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 pb-6 scrollbar-thin"
        data-testid={testId}
      >
        {text ? (
          <p className="text-lg leading-relaxed text-foreground whitespace-pre-wrap">
            {text}
          </p>
        ) : (
          <p className="text-base leading-relaxed text-muted-foreground italic">
            {title === 'Original' ? 'Transcription will appear here...' : 'Translation will appear here...'}
          </p>
        )}
      </div>
    </div>
  );
}

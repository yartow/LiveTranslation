import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface TranscriptionDisplayProps {
  title: string;
  text: string;
  testId?: string;
  isRTL?: boolean;
  isPartial?: boolean;
}

export default function TranscriptionDisplay({ title, text, testId, isRTL = false, isPartial = false }: TranscriptionDisplayProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    if (!text) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [text]);

  return (
    <div className="flex flex-col h-full">
      <div className="text-xs font-medium text-muted-foreground mb-2 px-6 pt-4 flex items-center justify-between">
        <span>{title}</span>
        {text && (
          <button
            onClick={handleCopy}
            className="p-1 rounded text-muted-foreground/50 hover:text-muted-foreground transition-colors"
            aria-label="Copy to clipboard"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          </button>
        )}
      </div>
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto px-6 pb-6 scrollbar-thin"
        data-testid={testId}
        dir={isRTL ? 'rtl' : 'ltr'}
      >
        {text ? (
          <p className={`text-lg leading-relaxed whitespace-pre-wrap ${isPartial ? 'text-muted-foreground' : 'text-foreground'}`}>
            {text}
            {isPartial && <span className="inline-block w-2 h-5 bg-primary ml-1 animate-pulse" />}
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

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface TranscriptionDisplayProps {
  title: string;
  text: string;
  testId?: string;
  isRTL?: boolean;
  isPartial?: boolean;
  displayStyle?: 'default' | 'stream';
}

function useTypewriter(text: string, active: boolean): string {
  const [displayed, setDisplayed] = useState(text);
  const prevRef = useRef(text);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!active) {
      setDisplayed(text);
      prevRef.current = text;
      return;
    }

    const prev = prevRef.current;
    prevRef.current = text;

    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }

    if (text === prev) return;

    if (!text.startsWith(prev)) {
      // Retranslation or reset — snap immediately
      setDisplayed(text);
      return;
    }

    // Extension of existing text — animate new words word-by-word
    const newPart = text.slice(prev.length);
    const words = newPart.match(/\S+\s*/g) ?? [];
    if (words.length === 0) {
      setDisplayed(text);
      return;
    }

    let i = 0;
    let current = prev;
    timerRef.current = setInterval(() => {
      if (i >= words.length) {
        clearInterval(timerRef.current!);
        timerRef.current = null;
        setDisplayed(text);
        return;
      }
      current += words[i];
      i++;
      setDisplayed(current);
    }, 120);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [text, active]);

  return displayed;
}

export default function TranscriptionDisplay({
  title,
  text,
  testId,
  isRTL = false,
  isPartial = false,
  displayStyle = 'default',
}: TranscriptionDisplayProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const isStream = displayStyle === 'stream' && !isPartial;
  const displayedText = useTypewriter(text, isStream);
  const visibleText = isStream ? displayedText : text;
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
  }, [visibleText]);

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
        {visibleText ? (
          <p className={`text-lg leading-relaxed whitespace-pre-wrap ${isPartial ? 'text-muted-foreground' : 'text-foreground'}`}>
            {visibleText}
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

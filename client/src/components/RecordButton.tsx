import { Button } from "@/components/ui/button";
import { Loader2 } from "lucide-react";

interface RecordButtonProps {
  isRecording: boolean;
  isProcessing: boolean;
  onClick: () => void;
  disabled?: boolean;
}

export default function RecordButton({ 
  isRecording, 
  isProcessing, 
  onClick, 
  disabled 
}: RecordButtonProps) {
  return (
    <div className="flex justify-center">
      <Button
        size="icon"
        variant={isRecording ? "default" : "outline"}
        onClick={onClick}
        disabled={disabled || isProcessing}
        className={`h-16 w-16 rounded-full ${isRecording ? 'animate-pulse' : ''}`}
        data-testid="button-record"
        aria-label={isRecording ? "Stop recording" : "Start recording"}
      >
        {isProcessing ? (
          <Loader2 className="h-6 w-6 animate-spin" />
        ) : isRecording ? (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
        ) : (
          <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z"/>
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/>
          </svg>
        )}
      </Button>
    </div>
  );
}

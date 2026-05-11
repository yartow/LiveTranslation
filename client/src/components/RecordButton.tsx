import { Loader2, Mic, Square } from 'lucide-react';

interface RecordButtonProps {
  isRecording: boolean;
  isProcessing: boolean;
  onClick: () => void;
  disabled?: boolean;
}

export default function RecordButton({ isRecording, isProcessing, onClick, disabled }: RecordButtonProps) {
  // Only disable the button while we're initialising before recording has started.
  // Once isRecording is true the user must always be able to click Stop.
  const isInitializing = isProcessing && !isRecording;
  return (
    <button
      onClick={onClick}
      disabled={disabled || isInitializing}
      data-testid="button-record"
      aria-label={isRecording ? 'Stop recording' : 'Start recording'}
      className={[
        'relative h-16 w-16 rounded-full flex items-center justify-center transition-all duration-200',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        isRecording
          ? 'bg-red-600 text-white shadow-lg shadow-red-900/40'
          : 'bg-primary text-primary-foreground hover:opacity-90',
      ].join(' ')}
    >
      {/* Pulsing outer ring while actively recording */}
      {isRecording && (
        <span className="absolute inset-0 rounded-full animate-ping bg-red-600 opacity-20" />
      )}

      {isInitializing
        ? <Loader2 className="h-6 w-6 animate-spin" />
        : isRecording
          ? <Square className="h-5 w-5 fill-current" />
          : <Mic className="h-6 w-6" />
      }
    </button>
  );
}

import { Badge } from "@/components/ui/badge";

interface RecordingIndicatorProps {
  isRecording: boolean;
}

export default function RecordingIndicator({ isRecording }: RecordingIndicatorProps) {
  if (!isRecording) return null;
  
  return (
    <Badge 
      variant="destructive" 
      className="absolute top-4 right-4 animate-pulse"
      data-testid="badge-recording"
    >
      <span className="w-2 h-2 bg-white rounded-full mr-2 animate-pulse"></span>
      Recording
    </Badge>
  );
}

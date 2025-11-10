import RecordingIndicator from '../RecordingIndicator';

export default function RecordingIndicatorExample() {
  return (
    <div className="relative h-24 bg-card rounded-lg">
      <RecordingIndicator isRecording={true} />
    </div>
  );
}

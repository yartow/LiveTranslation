import TranscriptionDisplay from '../TranscriptionDisplay';

export default function TranscriptionDisplayExample() {
  const sampleText = "In the beginning was the Word, and the Word was with God, and the Word was God. He was in the beginning with God. All things were made through him, and without him was not any thing made that was made.";
  
  return (
    <div className="h-64 bg-card rounded-lg">
      <TranscriptionDisplay 
        title="Original" 
        text={sampleText}
        testId="text-transcription"
      />
    </div>
  );
}

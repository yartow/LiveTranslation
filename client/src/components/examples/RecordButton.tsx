import { useState } from 'react';
import RecordButton from '../RecordButton';

export default function RecordButtonExample() {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  
  const handleClick = () => {
    if (isRecording) {
      setIsProcessing(true);
      setTimeout(() => {
        setIsProcessing(false);
        setIsRecording(false);
      }, 1500);
    } else {
      setIsRecording(true);
    }
    console.log('Record button clicked, recording:', !isRecording);
  };
  
  return (
    <div className="p-8">
      <RecordButton 
        isRecording={isRecording} 
        isProcessing={isProcessing}
        onClick={handleClick} 
      />
    </div>
  );
}

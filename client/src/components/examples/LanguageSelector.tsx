import { useState } from 'react';
import LanguageSelector from '../LanguageSelector';

export default function LanguageSelectorExample() {
  const [language, setLanguage] = useState('es');
  
  return (
    <div className="p-4">
      <LanguageSelector 
        value={language} 
        onChange={(val) => {
          setLanguage(val);
          console.log('Language changed to:', val);
        }} 
      />
    </div>
  );
}

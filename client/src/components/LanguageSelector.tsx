import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

interface LanguageSelectorProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  label?: string;
  testId?: string;
}

const LANGUAGES = [
  { code: 'en', name: 'English', rtl: false },
  { code: 'es', name: 'Spanish', rtl: false },
  { code: 'fr', name: 'French', rtl: false },
  { code: 'de', name: 'German', rtl: false },
  { code: 'nl', name: 'Dutch', rtl: false },
  { code: 'pt', name: 'Portuguese', rtl: false },
  { code: 'it', name: 'Italian', rtl: false },
  { code: 'zh', name: 'Chinese (Simplified)', rtl: false },
  { code: 'zh-TW', name: 'Chinese (Traditional)', rtl: false },
  { code: 'ar', name: 'Arabic', rtl: true },
  { code: 'fa', name: 'Farsi', rtl: true },
  { code: 'hi', name: 'Hindi', rtl: false },
  { code: 'ru', name: 'Russian', rtl: false },
  { code: 'ja', name: 'Japanese', rtl: false },
  { code: 'ko', name: 'Korean', rtl: false },
];

export function getLanguageRTL(code: string): boolean {
  const lang = LANGUAGES.find(l => l.code === code);
  return lang?.rtl || false;
}

export default function LanguageSelector({ 
  value, 
  onChange, 
  disabled,
  label = "Translate to",
  testId = "select-language"
}: LanguageSelectorProps) {
  return (
    <div className="space-y-2">
      <label htmlFor="language-select" className="text-sm font-medium text-foreground">
        {label}
      </label>
      <Select value={value} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger 
          id="language-select"
          className="h-12 w-full"
          data-testid={testId}
        >
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5h12M9 3v2m1.048 9.5A18.022 18.022 0 016.412 9m6.088 9h7M11 21l5-10 5 10M12.751 5C11.783 10.77 8.07 15.61 3 18.129" />
            </svg>
            <SelectValue placeholder="Select language" />
          </div>
        </SelectTrigger>
        <SelectContent>
          {LANGUAGES.map((lang) => (
            <SelectItem key={lang.code} value={lang.code}>
              {lang.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

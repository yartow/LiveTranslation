export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  nl: 'Dutch',
  pt: 'Portuguese',
  it: 'Italian',
  zh: 'Chinese (Simplified)',
  'zh-TW': 'Chinese (Traditional)',
  ar: 'Arabic',
  fa: 'Farsi',
  hi: 'Hindi',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
};

/** English name of a BCP-47 code as used in prompts; `fallback` for codes outside the supported list. */
export function languageName(code: string, fallback = 'English'): string {
  return LANGUAGE_NAMES[code] ?? fallback;
}

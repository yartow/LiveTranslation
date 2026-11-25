// Languages for listener mode (CLAUDE.md "Listener mode"): what the operator can offer on phones, what
// the phone page shows in each, and the `config` message the operator page sends to the hub.
//
// Mirrors server/lib/listener-lang.ts (client and server share no code). English is always available;
// the others are translated on the server from the finished English, only while someone reads them.

export const EXTRA_LISTENER_LANGUAGES = ['hi', 'ta', 'zh', 'zh-TW'] as const;
export type ExtraListenerLang = (typeof EXTRA_LISTENER_LANGUAGES)[number];
export type ListenerLang = 'en' | ExtraListenerLang;
export type ListenerProvider = 'openai' | 'claude' | 'ollama';

export interface ListenerLanguageSetting {
  enabled: boolean;
  provider: ListenerProvider;
  /** OpenAI model name; Claude uses Haiku and Ollama the model under General › Local models. */
  model: string;
}
export type ListenerLanguageSettings = Record<ExtraListenerLang, ListenerLanguageSetting>;

const DEFAULT_SETTING: ListenerLanguageSetting = { enabled: false, provider: 'openai', model: 'gpt-4o-mini' };

export const DEFAULT_LISTENER_LANGUAGES: ListenerLanguageSettings = {
  hi: { ...DEFAULT_SETTING },
  ta: { ...DEFAULT_SETTING },
  zh: { ...DEFAULT_SETTING },
  'zh-TW': { ...DEFAULT_SETTING },
};

/** Whatever was stored -> a complete, well-formed settings object (unknown keys dropped, bad values defaulted). */
export function normalizeListenerLanguages(raw: unknown): ListenerLanguageSettings {
  const source = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const out = {} as ListenerLanguageSettings;
  for (const lang of EXTRA_LISTENER_LANGUAGES) {
    const entry = source[lang] && typeof source[lang] === 'object' ? (source[lang] as Record<string, unknown>) : {};
    const provider = entry.provider === 'claude' || entry.provider === 'ollama' ? entry.provider : 'openai';
    const model = typeof entry.model === 'string' && entry.model.trim() && entry.model.length <= 80 ? entry.model : DEFAULT_SETTING.model;
    out[lang] = { enabled: entry.enabled === true, provider, model };
  }
  return out;
}

export interface ListenerLanguageInfo {
  code: ListenerLang;
  /** English name, for the settings page. */
  name: string;
  /** Name in its own script, for the phone's language picker (a Tamil reader can't pick "Tamil"). */
  native: string;
  /** BCP-47 tag for the `lang` attribute, so the phone picks the right font (matters for Chinese glyph variants). */
  htmlLang: string;
  /** An edited line is shown in italic — which Devanagari and Tamil script render poorly, so those never are. */
  italicForEdited: boolean;
  /** Line height for the reading text: Devanagari, Tamil and Chinese need more room than Latin. */
  leading: string;
}

export const LISTENER_LANGUAGE_INFO: Record<ListenerLang, ListenerLanguageInfo> = {
  en: { code: 'en', name: 'English', native: 'English', htmlLang: 'en', italicForEdited: true, leading: 'leading-relaxed sm:leading-relaxed' },
  hi: { code: 'hi', name: 'Hindi', native: 'हिन्दी', htmlLang: 'hi', italicForEdited: false, leading: 'leading-[1.9] sm:leading-[1.9]' },
  ta: { code: 'ta', name: 'Tamil', native: 'தமிழ்', htmlLang: 'ta', italicForEdited: false, leading: 'leading-[1.9] sm:leading-[1.9]' },
  zh: { code: 'zh', name: 'Chinese (Simplified)', native: '简体中文', htmlLang: 'zh-Hans', italicForEdited: true, leading: 'leading-[1.8] sm:leading-[1.8]' },
  'zh-TW': { code: 'zh-TW', name: 'Chinese (Traditional)', native: '繁體中文', htmlLang: 'zh-Hant', italicForEdited: true, leading: 'leading-[1.8] sm:leading-[1.8]' },
};

export function isListenerLang(value: unknown): value is ListenerLang {
  return value === 'en' || (typeof value === 'string' && (EXTRA_LISTENER_LANGUAGES as readonly string[]).indexOf(value) >= 0);
}

/** The language to show: the wanted one when the operator offers it, English otherwise. */
export function resolveListenerLang(wanted: unknown, offered: readonly string[]): ListenerLang {
  return isListenerLang(wanted) && (wanted === 'en' || offered.indexOf(wanted) >= 0) ? wanted : 'en';
}

export const LISTENER_LANG_STORAGE_KEY = 'cttay_listener_lang';

/** `?lang=hi` wins over what the phone remembered; English when neither says anything valid. */
export function initialListenerLang(search: string, stored: string | null): ListenerLang {
  let fromUrl: string | null = null;
  try { fromUrl = new URLSearchParams(search).get('lang'); } catch { /* ignore */ }
  if (isListenerLang(fromUrl)) return fromUrl;
  return isListenerLang(stored) ? stored : 'en';
}

/** What the operator page sends the hub (`config`) — the languages on offer and how to translate each. Never keys: the server uses its own. */
export function buildListenerConfig(
  languages: ListenerLanguageSettings,
  ollama: { baseUrl: string; model: string },
  /** The sermon glossary file whose Hindi/Tamil/Chinese columns the hub should use; '' = none (glossary switched off). */
  glossaryCsv = '',
): { type: 'config'; enabled: ExtraListenerLang[]; models: Record<string, { provider: ListenerProvider; model: string }>; ollamaBaseUrl: string; ollamaModel: string; glossaryCsv: string } {
  const enabled = EXTRA_LISTENER_LANGUAGES.filter(lang => languages[lang].enabled);
  const models: Record<string, { provider: ListenerProvider; model: string }> = {};
  for (const lang of EXTRA_LISTENER_LANGUAGES) models[lang] = { provider: languages[lang].provider, model: languages[lang].model };
  return { type: 'config', enabled, models, ollamaBaseUrl: ollama.baseUrl, ollamaModel: ollama.model, glossaryCsv };
}

/** The few words of chrome on the phone page, in each language. */
export interface ListenerUiStrings {
  title: string;
  connected: string;
  connecting: string;
  reconnecting: string;
  refresh: string;
  jumpToLive: string;
  waiting: string;
  language: string;
}

export const LISTENER_UI: Record<ListenerLang, ListenerUiStrings> = {
  en: { title: 'Live translation', connected: 'Connected', connecting: 'Connecting…', reconnecting: 'Reconnecting…', refresh: 'Refresh', jumpToLive: 'Jump to live', waiting: 'Waiting for the translation to begin…', language: 'Language' },
  hi: { title: 'लाइव अनुवाद', connected: 'जुड़ा हुआ', connecting: 'जुड़ रहा है…', reconnecting: 'फिर से जुड़ रहा है…', refresh: 'रीफ़्रेश', jumpToLive: 'लाइव पर जाएँ', waiting: 'अनुवाद शुरू होने की प्रतीक्षा है…', language: 'भाषा' },
  ta: { title: 'நேரடி மொழிபெயர்ப்பு', connected: 'இணைக்கப்பட்டது', connecting: 'இணைக்கிறது…', reconnecting: 'மீண்டும் இணைக்கிறது…', refresh: 'புதுப்பி', jumpToLive: 'நேரலைக்குச் செல்', waiting: 'மொழிபெயர்ப்பு தொடங்க காத்திருக்கிறது…', language: 'மொழி' },
  zh: { title: '实时翻译', connected: '已连接', connecting: '连接中…', reconnecting: '正在重新连接…', refresh: '刷新', jumpToLive: '回到最新', waiting: '正在等待翻译开始…', language: '语言' },
  'zh-TW': { title: '即時翻譯', connected: '已連線', connecting: '連線中…', reconnecting: '正在重新連線…', refresh: '重新整理', jumpToLive: '回到最新', waiting: '等待翻譯開始…', language: '語言' },
};

/** What the sermon glossary offers phones: the Hindi/Tamil/Chinese columns found in its CSV and how many terms each has (Settings › Glossary). */
export function listenerColumnsSummary(columns: string[] | undefined, counts: Record<string, number> | undefined): string {
  if (!columns || columns.length === 0) return 'No Hindi, Tamil or Chinese columns — phones in those languages use the built-in terms only.';
  return 'For listener phones: ' + columns.map(c => `${isListenerLang(c) ? LISTENER_LANGUAGE_INFO[c].name : c} ${counts?.[c] ?? 0}`).join(' · ') + ' terms';
}

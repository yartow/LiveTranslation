// The languages a listener's phone can read, and the operator's per-language translation settings as
// the hub receives them (the operator page sends them in a `config` message — useListenerBroadcast.ts).
// English is always available and is what the operator publishes; every other language is translated
// from that English on the server (listener-translate.ts) and only while a phone is reading it.
//
// Mirrored on the client in client/src/lib/listener-languages.ts (client and server share no code).

import { isSafeGlossaryName } from './glossary-file';

export const EXTRA_LISTENER_LANGUAGES = ['hi', 'ta', 'zh', 'zh-TW'] as const;
export type ExtraListenerLang = (typeof EXTRA_LISTENER_LANGUAGES)[number];
export type ListenerLang = 'en' | ExtraListenerLang;
export type ListenerProvider = 'openai' | 'claude' | 'ollama';

export interface LanguageModelConfig {
  provider: ListenerProvider;
  /** The OpenAI model name; Claude always uses the app's Haiku and Ollama the model set in `ollamaModel`. */
  model: string;
}

export const DEFAULT_MODEL_CONFIG: LanguageModelConfig = { provider: 'openai', model: 'gpt-4o-mini' };

export interface ListenerTranslationConfig {
  /** Extra languages the operator offers. English is implicit. */
  enabled: ExtraListenerLang[];
  models: Partial<Record<ExtraListenerLang, LanguageModelConfig>>;
  ollamaBaseUrl?: string;
  ollamaModel?: string;
  /** The glossary CSV (a plain filename in GLOSSARY_DIR) whose Hindi/Tamil/Chinese columns are handed to the translator. Absent = no glossary. */
  glossaryCsv?: string;
}

export function isExtraListenerLang(value: unknown): value is ExtraListenerLang {
  return typeof value === 'string' && (EXTRA_LISTENER_LANGUAGES as readonly string[]).indexOf(value) >= 0;
}

/** The language a phone gets for its request: the requested one when the operator offers it, otherwise English. */
export function resolveLanguage(requested: unknown, enabled: readonly ExtraListenerLang[]): ListenerLang {
  if (isExtraListenerLang(requested) && enabled.indexOf(requested) >= 0) return requested;
  return 'en';
}

const MAX_MODEL_LEN = 80;
const MAX_URL_LEN = 200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Narrows whatever the broadcaster sent as `config` to a well-formed ListenerTranslationConfig. Unknown
 * languages are dropped (this is the allowlist: a phone can never make the hub translate into a language
 * that is not in EXTRA_LISTENER_LANGUAGES *and* switched on), bad providers/models fall back to defaults.
 */
export function normalizeConfig(raw: unknown): ListenerTranslationConfig {
  const obj = isRecord(raw) ? raw : {};
  const enabled: ExtraListenerLang[] = [];
  if (Array.isArray(obj.enabled)) {
    for (const lang of obj.enabled) {
      if (isExtraListenerLang(lang) && enabled.indexOf(lang) < 0) enabled.push(lang);
    }
  }

  const models: Partial<Record<ExtraListenerLang, LanguageModelConfig>> = {};
  if (isRecord(obj.models)) {
    for (const lang of EXTRA_LISTENER_LANGUAGES) {
      const entry = obj.models[lang];
      if (!isRecord(entry)) continue;
      const provider: ListenerProvider = entry.provider === 'claude' || entry.provider === 'ollama' ? entry.provider : 'openai';
      const model = typeof entry.model === 'string' && entry.model.trim() && entry.model.length <= MAX_MODEL_LEN
        ? entry.model.trim()
        : DEFAULT_MODEL_CONFIG.model;
      models[lang] = { provider, model };
    }
  }

  const config: ListenerTranslationConfig = { enabled, models };
  if (typeof obj.ollamaBaseUrl === 'string' && /^https?:\/\//i.test(obj.ollamaBaseUrl) && obj.ollamaBaseUrl.length <= MAX_URL_LEN) {
    config.ollamaBaseUrl = obj.ollamaBaseUrl;
  }
  if (typeof obj.ollamaModel === 'string' && obj.ollamaModel.trim() && obj.ollamaModel.length <= MAX_MODEL_LEN) {
    config.ollamaModel = obj.ollamaModel.trim();
  }
  // A filename only, checked by the same sandbox rules as every glossary file (no path, right extension).
  if (typeof obj.glossaryCsv === 'string' && isSafeGlossaryName(obj.glossaryCsv, 'csv')) {
    config.glossaryCsv = obj.glossaryCsv;
  }
  return config;
}

export function modelFor(config: ListenerTranslationConfig, lang: ExtraListenerLang): LanguageModelConfig {
  return config.models[lang] ?? DEFAULT_MODEL_CONFIG;
}

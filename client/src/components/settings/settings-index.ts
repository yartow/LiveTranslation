// Single source of truth for the Settings dialog's structure: which groups and
// pages exist, which mode each one affects, and what every individual setting
// is called. The dialog renders its navigation from SETTINGS_PAGES, each page
// takes its labels/descriptions from SETTINGS_ITEMS (via <SettingItem>), and
// search runs over SETTINGS_ITEMS — so the three can't drift apart.
//
// Pure data + logic (no React) so it can be unit-tested.
//
// Adding a setting: add an item here (with its page and mode), then render it
// on that page with <SettingItem id="...">.

export type SettingsMode = 'sermon' | 'live';
export type SettingsScope = SettingsMode | 'both';

export type SettingsGroupId = 'general' | 'sermon' | 'live' | 'advanced';

export interface SettingsGroup {
  id: SettingsGroupId;
  title: string;
  /** Which app mode the group belongs to, or 'both' for shared groups. */
  scope: SettingsScope;
}

export interface SettingsPage {
  id: string;
  group: SettingsGroupId;
  title: string;
  summary: string;
  scope: SettingsScope;
  /** lucide-react icon component name, resolved by the dialog shell. */
  icon: string;
}

export interface SettingsItem {
  id: string;
  page: string;
  label: string;
  description: string;
  keywords: string[];
  /** Overrides the page's scope when this one setting differs from its page. */
  scope?: SettingsScope;
}

export const SETTINGS_GROUPS: SettingsGroup[] = [
  { id: 'general', title: 'General', scope: 'both' },
  { id: 'sermon', title: 'Sermon mode', scope: 'sermon' },
  { id: 'live', title: 'Live mode', scope: 'live' },
  { id: 'advanced', title: 'Advanced', scope: 'both' },
];

export const SETTINGS_PAGES: SettingsPage[] = [
  // ── General ──
  { id: 'api-keys', group: 'general', title: 'API keys', summary: 'OpenAI, Anthropic and ESV keys', scope: 'both', icon: 'KeyRound' },
  { id: 'languages', group: 'general', title: 'Languages', summary: 'Spoken and target language', scope: 'both', icon: 'Languages' },
  { id: 'speech', group: 'general', title: 'Speech recognition', summary: 'Which engine turns audio into text', scope: 'both', icon: 'AudioLines' },
  { id: 'microphone', group: 'general', title: 'Microphone', summary: 'Input processing and device profiles', scope: 'both', icon: 'Mic' },
  { id: 'ollama', group: 'general', title: 'Local models (Ollama)', summary: 'Server address and model name', scope: 'both', icon: 'Cpu' },
  { id: 'glossary', group: 'general', title: 'Glossary', summary: 'Terms recognised and translated consistently', scope: 'both', icon: 'BookA' },
  // ── Sermon mode ──
  { id: 'sermon-correction', group: 'sermon', title: 'Transcript correction', summary: 'Clean-up of each transcribed chunk', scope: 'sermon', icon: 'SpellCheck' },
  { id: 'sermon-translation', group: 'sermon', title: 'Translation', summary: 'Provider, model and context', scope: 'sermon', icon: 'Languages' },
  { id: 'sermon-timing', group: 'sermon', title: 'Timing', summary: 'Block length and stability', scope: 'sermon', icon: 'Timer' },
  { id: 'sermon-scripture', group: 'sermon', title: 'Scripture quotes', summary: 'Exact Bible text for read verses', scope: 'sermon', icon: 'BookOpen' },
  { id: 'sermon-listeners', group: 'sermon', title: 'Listeners', summary: 'Address for phones on the same Wi-Fi', scope: 'sermon', icon: 'Users' },
  // ── Live mode ──
  { id: 'live-translation', group: 'live', title: 'Translation', summary: 'Provider for live subtitles', scope: 'live', icon: 'Languages' },
  { id: 'live-improve', group: 'live', title: 'Improve button', summary: 'Re-process recent text with an LLM', scope: 'live', icon: 'Sparkles' },
  { id: 'live-audio', group: 'live', title: 'Audio & chunking', summary: 'Overlap, silence detection, streaming', scope: 'live', icon: 'SlidersHorizontal' },
  // ── Advanced ──
  { id: 'debug', group: 'advanced', title: 'Debug', summary: 'Live status messages', scope: 'both', icon: 'Bug' },
];

export const SETTINGS_ITEMS: SettingsItem[] = [
  // ── API keys ──
  { id: 'openai-key', page: 'api-keys', label: 'OpenAI API key', description: 'Needed for OpenAI Whisper transcription and GPT-4o-mini correction/translation. Stored only in this browser tab.', keywords: ['openai', 'gpt', 'whisper', 'sk-', 'token', 'secret'] },
  { id: 'anthropic-key', page: 'api-keys', label: 'Anthropic API key', description: 'Needed for Claude Haiku correction/translation. Stored only in this browser tab.', keywords: ['anthropic', 'claude', 'haiku', 'token', 'secret'] },
  { id: 'esv-key', page: 'api-keys', label: 'ESV API key', description: 'Only needed when the local ESV text has not been built. Without text or key, quotes fall back to the King James Version.', keywords: ['esv', 'bible', 'crossway', 'scripture', 'token'], scope: 'sermon' },

  // ── Languages ──
  { id: 'source-language', page: 'languages', label: 'Speaking in', description: 'The language being spoken. Pre-selected when the app opens.', keywords: ['source', 'input', 'dutch', 'nl'] },
  { id: 'target-language', page: 'languages', label: 'Translate to', description: 'The language to translate into. Pre-selected when the app opens.', keywords: ['target', 'output', 'english', 'en'] },

  // ── Speech recognition ──
  { id: 'transcription-provider', page: 'speech', label: 'Speech recognition engine', description: 'OpenAI Whisper (online) or local Whisper (MLX, offline). Sermon mode only uses these two; browser and in-browser engines are for Live mode.', keywords: ['whisper', 'mlx', 'transcription', 'offline', 'online', 'local', 'browser', 'transformers', 'webgpu', 'asr', 'stt'] },
  { id: 'local-whisper-model', page: 'speech', label: 'In-browser model size', description: 'Model used by the Transformers.js engine. First use downloads it once.', keywords: ['tiny', 'small', 'medium', 'transformers', 'webgpu', 'download'], scope: 'live' },

  // ── Microphone ──
  { id: 'mic-device', page: 'microphone', label: 'Microphone', description: 'Which input to record from. "System default" follows whatever macOS has selected, which is how the wrong microphone gets used by accident. Applies from the next recording.', keywords: ['input', 'device', 'usb', 'external', 'built-in', 'macbook', 'headset', 'interface', 'bluetooth'] },
  { id: 'raw-audio', page: 'microphone', label: 'Raw microphone audio', description: "Turns off the browser's echo cancellation, noise suppression and auto-gain. Whisper is more accurate on unprocessed audio. Applies from the next recording.", keywords: ['echo', 'noise', 'agc', 'gain', 'processing', 'unprocessed'] },
  { id: 'norm-gain', page: 'microphone', label: 'Normalization gain', description: 'Amplifies quiet microphones. 1.0 = no change.', keywords: ['volume', 'amplify', 'level', 'quiet', 'loudness', 'wizard'] },
  { id: 'device-profiles', page: 'microphone', label: 'Device profiles', description: 'Save the current audio settings as a named preset for quick switching between devices (e.g. phone vs. laptop, external mic).', keywords: ['preset', 'profile', 'external mic', 'save'] },

  // ── Local models ──
  { id: 'ollama-url', page: 'ollama', label: 'Ollama base URL', description: 'Address of the Ollama server. Used by both modes whenever a provider is set to Ollama.', keywords: ['ollama', 'local', 'llm', 'server', 'localhost', '11434'] },
  { id: 'ollama-model', page: 'ollama', label: 'Ollama model name', description: 'Model used for every Ollama call, in both modes. A large model competes with Whisper for the GPU.', keywords: ['ollama', 'qwen', 'local', 'llm', 'model'] },

  // ── Glossary ──
  { id: 'vocab-hints', page: 'glossary', label: 'Vocabulary hints', description: 'One term per line, optionally "term = translation". Passed to Whisper as spelling hints and to the correction step; Live mode also translates with it, and Sermon mode uses it when the glossary files are off.', keywords: ['theological', 'terms', 'vocabulary', 'words', 'paste', 'list', 'hints'], scope: 'both' },
  { id: 'glossary-enabled', page: 'glossary', label: 'Use glossary files', description: 'A CSV of fixed terms plus a disambiguation document, used to translate sermons consistently. Replaces the vocabulary hints for sermon translation.', keywords: ['csv', 'woordenlijst', 'disambiguation', 'files', 'terms'], scope: 'sermon' },
  { id: 'glossary-csv', page: 'glossary', label: 'Glossary CSV file', description: 'Fixed terms and context-dependent terms. Must live in the server glossary folder.', keywords: ['csv', 'file', 'terms'], scope: 'sermon' },
  { id: 'glossary-prompt', page: 'glossary', label: 'Disambiguation document', description: 'Markdown instructions for choosing between alternative translations. Must live in the server glossary folder.', keywords: ['markdown', 'prompt', 'md', 'file', 'rules'], scope: 'sermon' },
  { id: 'deity-capitals', page: 'glossary', label: 'Capitalise pronouns for God', description: 'Capitalise He/Him/His when they refer to God.', keywords: ['deity', 'capitals', 'pronouns', 'hoofdletters', 'he', 'him', 'his'], scope: 'sermon' },
  { id: 'glossary-warnings', page: 'glossary', label: 'Show glossary warnings', description: 'Flag segments whose translation does not use the glossary term.', keywords: ['warnings', 'check', 'adherence', 'flag'], scope: 'sermon' },

  // ── Sermon: correction ──
  { id: 'sermon-asr-correction', page: 'sermon-correction', label: 'Correct each chunk', description: 'Let a language model clean up every transcribed chunk (punctuation, wrong words). Off = use Whisper\'s text as is: faster, but glossary words are not fixed. This step runs while recording and can slow transcription down.', keywords: ['asr', 'correction', 'chunk', 'clean', 'punctuation', 'fragment', 'speed', 'slow'] },
  { id: 'sermon-correction-provider', page: 'sermon-correction', label: 'Correction provider', description: 'Which model corrects each chunk. Never translates. A local Ollama model shares the GPU with Whisper.', keywords: ['correction', 'provider', 'openai', 'claude', 'ollama', 'gpt', 'haiku', 'model'] },

  // ── Sermon: translation ──
  { id: 'sermon-translation-provider', page: 'sermon-translation', label: 'Translation provider', description: 'Which model translates finished segments. Also applies the glossary and Bible-quote handling. Runs after transcription, so it does not slow audio down.', keywords: ['translate', 'provider', 'openai', 'claude', 'ollama', 'gpt', 'haiku', 'model', 'vertaal'] },
  { id: 'sermon-model', page: 'sermon-translation', label: 'OpenAI model', description: 'Model name used when the provider is OpenAI. Claude always uses Haiku; Ollama uses the model set under Local models.', keywords: ['model', 'gpt-4o-mini', 'openai', 'name'] },
  { id: 'sermon-auto-translate', page: 'sermon-translation', label: 'Auto-translate', description: 'Translate new sentences as soon as they are stable. The Refresh button always works, even when this is off.', keywords: ['automatic', 'refresh', 'stable', 'automatisch'] },
  { id: 'sermon-context', page: 'sermon-translation', label: 'Context sentences', description: 'How many neighbouring segments are sent along as context: before (0–5) and after (0–3).', keywords: ['context', 'before', 'after', 'neighbours', 'surrounding'] },

  // ── Sermon: timing ──
  { id: 'sermon-max-latency', page: 'sermon-timing', label: 'Block length', description: 'How long a block of speech runs before it is finalized as one segment and translated. Transcribed text already shows (and can be edited) as soon as it arrives; longer blocks read more smoothly, shorter ones are translated sooner. Applies to a running session.', keywords: ['latency', 'delay', 'bracket', 'segment', 'seconds', 'vertraging'] },
  { id: 'sermon-stability', page: 'sermon-timing', label: 'Stability delay', description: 'How long a segment must stay unchanged before it is auto-translated.', keywords: ['debounce', 'stable', 'wait', 'delay', 'stabiliteit'] },

  // ── Sermon: scripture ──
  { id: 'scripture-enabled', page: 'sermon-scripture', label: 'Detect Bible quotes', description: 'Recognises a reference ("John 3:16") and replaces a verse read word-for-word with the exact English text instead of a model translation. A paraphrase is translated normally.', keywords: ['bible', 'verse', 'reference', 'quote', 'schrift', 'citaat', 'scripture'] },
  { id: 'bible-version', page: 'sermon-scripture', label: 'English Bible version', description: 'Version used for quoted verses and as guidance for paraphrases. ESV and LSB are read from locally built text; others fall back to KJV. The glossary uses this too.', keywords: ['kjv', 'esv', 'lsb', 'nasb', 'nkjv', 'version', 'translation', 'bible'] },
  { id: 'scripture-fallback', page: 'sermon-scripture', label: 'If the chosen version is unavailable', description: 'Fall back to the King James Version, or do not substitute and translate the verse like normal speech.', keywords: ['kjv', 'fallback', 'unavailable', 'missing'] },

  // ── Sermon: listeners ──
  { id: 'listener-address', page: 'sermon-listeners', label: 'Listener address', description: 'Give this address to listeners on the same Wi-Fi so they can follow the English translation on their phone. Look it up again after joining a different network.', keywords: ['ip', 'lan', 'wifi', 'phone', 'listen', 'url', 'address', 'luisteraars', 'network'] },

  // ── Live: translation ──
  { id: 'live-translation-provider', page: 'live-translation', label: 'Translation provider', description: 'Corrects and translates each live chunk. "None" shows the raw transcription only. This does not affect Sermon mode.', keywords: ['translate', 'correction', 'openai', 'claude', 'ollama', 'none', 'provider', 'subtitle'] },

  // ── Live: improve ──
  { id: 'improve-provider', page: 'live-improve', label: 'Improve provider', description: 'Model used by the Improve button to fix spelling, punctuation and theological terms.', keywords: ['improve', 'correction', 'openai', 'claude', 'provider', 'retroactive'] },
  { id: 'improve-chars', page: 'live-improve', label: 'Default characters to improve', description: 'How many trailing characters the Improve button re-processes (minimum 100).', keywords: ['lookback', 'chars', 'characters', 'improve', 'length'] },

  // ── Live: audio ──
  { id: 'chunk-overlap', page: 'live-audio', label: 'Chunk overlap', description: 'Audio overlap prepended to each chunk so words are not cut at the boundary (Whisper engines).', keywords: ['overlap', 'chunk', 'boundary', 'cut'] },
  { id: 'vad', page: 'live-audio', label: 'Voice activity detection', description: 'Commit a chunk on detected silence instead of a fixed timer. The threshold sets how long a pause must be.', keywords: ['vad', 'silence', 'pause', 'threshold', 'chunking'] },
  { id: 'assembly-thresholds', page: 'live-audio', label: 'AssemblyAI streaming thresholds', description: 'End-of-turn confidence and turn silence, applied when a streaming session starts.', keywords: ['assemblyai', 'streaming', 'end of turn', 'confidence', 'silence'] },
  { id: 'show-live-audio', page: 'live-audio', label: 'Live audio controls while recording', description: 'Adds a panel with VU meter, gain slider and normalization wizard during recording.', keywords: ['vu', 'meter', 'level', 'gain', 'wizard', 'panel'] },

  // ── Debug ──
  { id: 'debug-mode', page: 'debug', label: 'Show live status messages', description: 'Displays a real-time log of what the app is doing — recording, sending to Whisper, API key errors, etc.', keywords: ['debug', 'log', 'status', 'diagnostics'] },
];

const PAGE_BY_ID = new Map(SETTINGS_PAGES.map((p) => [p.id, p]));
const GROUP_BY_ID = new Map(SETTINGS_GROUPS.map((g) => [g.id, g]));

export function getPage(id: string): SettingsPage | undefined {
  return PAGE_BY_ID.get(id);
}

export function getGroup(id: SettingsGroupId): SettingsGroup | undefined {
  return GROUP_BY_ID.get(id);
}

export function getItem(id: string): SettingsItem {
  const item = SETTINGS_ITEMS.find((i) => i.id === id);
  if (!item) throw new Error(`Unknown settings item: ${id}`);
  return item;
}

/** The mode(s) an item affects: its own override, else its page's. */
export function itemScope(item: SettingsItem): SettingsScope {
  return item.scope ?? PAGE_BY_ID.get(item.page)?.scope ?? 'both';
}

/**
 * Groups in display order for the given mode: General first, then the current
 * mode's group, then the other mode's group, then Advanced. The current mode's
 * group is flagged so the dialog can mark it "(this mode)".
 */
export function groupsForMode(mode: SettingsMode): Array<SettingsGroup & { isCurrent: boolean }> {
  const rank = (g: SettingsGroup) =>
    g.id === 'general' ? 0 : g.id === mode ? 1 : g.id === 'advanced' ? 3 : 2;
  return [...SETTINGS_GROUPS]
    .sort((a, b) => rank(a) - rank(b))
    .map((g) => ({ ...g, isCurrent: g.id === mode }));
}

export function pagesInGroup(group: SettingsGroupId): SettingsPage[] {
  return SETTINGS_PAGES.filter((p) => p.group === group);
}

export function itemsOnPage(pageId: string): SettingsItem[] {
  return SETTINGS_ITEMS.filter((i) => i.page === pageId);
}

/** The first page shown when the dialog opens on desktop: the current mode's first page. */
export function defaultPageId(mode: SettingsMode): string {
  return pagesInGroup(mode)[0]?.id ?? SETTINGS_PAGES[0].id;
}

export interface SettingsSearchResult {
  item: SettingsItem;
  page: SettingsPage;
  group: SettingsGroup;
  scope: SettingsScope;
}

/**
 * Case-insensitive search over every setting. Every whitespace-separated token
 * must match somewhere; label hits rank above page-title hits, above
 * description and keyword hits. An empty query returns [].
 */
export function searchSettings(query: string): SettingsSearchResult[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];

  const scored: Array<{ result: SettingsSearchResult; score: number; order: number }> = [];
  SETTINGS_ITEMS.forEach((item, order) => {
    const page = PAGE_BY_ID.get(item.page);
    const group = page && GROUP_BY_ID.get(page.group);
    if (!page || !group) return;

    const label = item.label.toLowerCase();
    const pageTitle = page.title.toLowerCase();
    const rest = `${item.description} ${item.keywords.join(' ')}`.toLowerCase();

    let score = 0;
    for (const token of tokens) {
      if (label.includes(token)) score += 100;
      else if (pageTitle.includes(token)) score += 40;
      else if (rest.includes(token)) score += 10;
      else return; // every token must match
    }
    scored.push({ result: { item, page, group, scope: itemScope(item) }, score, order });
  });

  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((s) => s.result);
}

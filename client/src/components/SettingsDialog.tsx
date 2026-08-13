import { useState, useEffect, useCallback } from 'react';
import LanguageSelector from '@/components/LanguageSelector';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AppSettings, TranscriptionProvider, TranslationProvider, ImprovementProvider, LocalWhisperModel, DeviceProfile, SermonTranslationProvider, SermonBibleVersion, SermonScriptureFallback } from '@/hooks/useSettings';
import { maskKey } from '@/lib/mask-key';

interface SettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  settings: AppSettings;
  onUpdate: (updates: Partial<AppSettings>) => void;
  webGpuSupported?: boolean | null;
}

interface ApiKeyFieldProps {
  label: string;
  placeholder: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  keyPrefix?: string;
}

function ApiKeyField({ label, placeholder, description, value, onChange, keyPrefix }: ApiKeyFieldProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [validationError, setValidationError] = useState('');

  const isSet = value.length > 0;

  function handleSave() {
    const trimmed = draft.trim();
    if (!trimmed) return;
    if (keyPrefix && !trimmed.startsWith(keyPrefix)) {
      setValidationError(`Key must start with "${keyPrefix}"`);
      return;
    }
    setValidationError('');
    onChange(trimmed);
    setIsEditing(false);
    setDraft('');
  }

  function handleClear() {
    onChange('');
    setIsEditing(false);
    setDraft('');
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') {
      setIsEditing(false);
      setDraft('');
      setValidationError('');
    }
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <Label className="text-sm font-medium">{label}</Label>
        {isSet ? (
          <span className="text-xs text-green-600 dark:text-green-400 font-medium">✓ Saved</span>
        ) : (
          <span className="text-xs text-orange-500 font-medium">Not set</span>
        )}
      </div>

      {!isEditing && isSet ? (
        <div className="flex items-center gap-2 min-w-0 overflow-hidden">
          <code className="block flex-1 min-w-0 text-xs bg-muted rounded px-3 py-2 font-mono text-muted-foreground overflow-hidden text-ellipsis whitespace-nowrap">
            {maskKey(value)}
          </code>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => { setDraft(''); setIsEditing(true); }}
          >
            Change
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0 text-destructive hover:text-destructive"
            onClick={handleClear}
          >
            Clear
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <Input
              type="password"
              placeholder={placeholder}
              value={draft}
              onChange={(e) => { setDraft(e.target.value); setValidationError(''); }}
              onKeyDown={handleKeyDown}
              autoComplete="off"
              autoFocus={!isSet || isEditing}
              className={`font-mono text-sm ${validationError ? 'border-destructive' : ''}`}
            />
            <Button size="sm" onClick={handleSave} disabled={!draft.trim()}>
              Save
            </Button>
          </div>
          {validationError && (
            <p className="text-xs text-destructive">{validationError}</p>
          )}
          {isSet && (
            <Button
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => { setIsEditing(false); setDraft(''); setValidationError(''); }}
            >
              Cancel
            </Button>
          )}
        </div>
      )}

      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

// Mirrors server/lib/glossary-store.ts's GlossaryDiagnostics + the
// stale/available fields getGlossaryStatus() adds — kept as a local type
// rather than imported since client and server share no code (see
// server/lib/sermon-prompt.ts's header comment for why).
interface GlossaryStatus {
  loaded: boolean;
  version: string;
  csv: { name: string; exists: boolean; totalRows: number; fixedRows: number; contextRows: number; repairedRows: number; droppedRows: number };
  prompt: { name: string; exists: boolean; chars: number };
  warnings: string[];
  errors: string[];
  estimatedTokens: number;
  stale: boolean;
  available: { csv: string[]; md: string[] };
}

interface GlossaryPanelProps {
  settings: AppSettings;
  onUpdate: (updates: Partial<AppSettings>) => void;
  isOpen: boolean;
}

function GlossaryPanel({ settings, onUpdate, isOpen }: GlossaryPanelProps) {
  const [status, setStatus] = useState<GlossaryStatus | null>(null);
  const [isReloading, setIsReloading] = useState(false);
  const [showWarnings, setShowWarnings] = useState(false);
  const [fetchError, setFetchError] = useState('');

  const fetchStatus = useCallback(async () => {
    try {
      const params = new URLSearchParams({ csv: settings.sermonGlossaryCsv, prompt: settings.sermonDisambiguationPrompt });
      const res = await fetch(`/api/sermon/glossary/status?${params}`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      setStatus(await res.json());
      setFetchError('');
    } catch {
      setFetchError('Kon woordenlijst-status niet ophalen.');
    }
  }, [settings.sermonGlossaryCsv, settings.sermonDisambiguationPrompt]);

  useEffect(() => {
    if (isOpen) fetchStatus();
  }, [isOpen, fetchStatus]);

  async function handleReload() {
    setIsReloading(true);
    try {
      const res = await fetch('/api/sermon/glossary/reload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: settings.sermonGlossaryCsv, prompt: settings.sermonDisambiguationPrompt }),
      });
      if (res.ok) setStatus(await res.json());
    } finally {
      setIsReloading(false);
    }
  }

  if (!settings.sermonGlossaryEnabled) return null;

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs font-medium">CSV-bestand</Label>
          <Select value={settings.sermonGlossaryCsv} onValueChange={(v) => onUpdate({ sermonGlossaryCsv: v })}>
            <SelectTrigger className="h-8 text-xs" data-testid="select-glossary-csv">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(status?.available.csv ?? [settings.sermonGlossaryCsv]).map((name) => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-xs font-medium">Disambiguatie-prompt</Label>
          <Select value={settings.sermonDisambiguationPrompt} onValueChange={(v) => onUpdate({ sermonDisambiguationPrompt: v })}>
            <SelectTrigger className="h-8 text-xs" data-testid="select-glossary-prompt">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {(status?.available.md ?? [settings.sermonDisambiguationPrompt]).map((name) => (
                <SelectItem key={name} value={name}>{name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div className="space-y-1">
          <Label className="text-xs font-medium">Doelvertaling</Label>
          <Select value={settings.sermonBibleVersion} onValueChange={(v) => onUpdate({ sermonBibleVersion: v as SermonBibleVersion })}>
            <SelectTrigger className="h-8 text-xs" data-testid="select-bible-version">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="KJV">KJV</SelectItem>
              <SelectItem value="ESV">ESV</SelectItem>
              <SelectItem value="NASB">NASB</SelectItem>
              <SelectItem value="NKJV">NKJV</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center justify-between">
          <Label htmlFor="glossary-deity-capitals" className="text-xs font-medium cursor-pointer">
            Hoofdletters voor God (He/Him/His)
          </Label>
          <Switch
            id="glossary-deity-capitals"
            checked={settings.sermonDeityCapitals}
            onCheckedChange={(checked) => onUpdate({ sermonDeityCapitals: checked })}
          />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <Label htmlFor="glossary-warnings" className="text-xs font-medium cursor-pointer">
          Woordenlijst-waarschuwingen tonen
        </Label>
        <Switch
          id="glossary-warnings"
          checked={settings.sermonGlossaryWarnings}
          onCheckedChange={(checked) => onUpdate({ sermonGlossaryWarnings: checked })}
        />
      </div>

      <div className="rounded-md border border-border bg-muted/40 px-3 py-2 space-y-1.5">
        {fetchError && <p className="text-xs text-destructive">{fetchError}</p>}
        {!fetchError && !status && <p className="text-xs text-muted-foreground">Status laden…</p>}
        {status && !status.loaded && (
          <p className="text-xs text-amber-500">
            Geen woordenlijst geladen — er wordt vertaald zónder woordenlijst.
            {status.errors[0] ? ` (${status.errors[0]})` : ''}
          </p>
        )}
        {status && status.loaded && (
          <>
            <p className="text-xs text-muted-foreground">
              {status.csv.fixedRows} vaste termen · {status.csv.contextRows} contextafhankelijk
              {status.csv.repairedRows > 0 ? ` · ${status.csv.repairedRows} rijen hersteld` : ''}
              {' · ~'}{status.estimatedTokens} tokens
            </p>
            {status.stale && (
              <p className="text-xs text-amber-500">Bestand is gewijzigd op schijf sinds het laatst geladen is — herladen aanbevolen.</p>
            )}
            {status.warnings.length > 0 && (
              <div>
                <button
                  type="button"
                  className="text-xs text-amber-500 underline decoration-dotted"
                  onClick={() => setShowWarnings((v) => !v)}
                >
                  ⚠ {status.warnings.length} inconsistenties {showWarnings ? '▴' : '▾'}
                </button>
                {showWarnings && (
                  <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground list-disc list-inside">
                    {status.warnings.map((w, i) => <li key={i}>{w}</li>)}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
        <Button variant="outline" size="sm" onClick={handleReload} disabled={isReloading}>
          {isReloading ? 'Herladen…' : 'Herladen'}
        </Button>
      </div>

      <p className="text-xs text-muted-foreground italic">
        Bestanden moeten in de glossary-map van de server staan (standaard <code>data/</code>,
        instelbaar via de <code>GLOSSARY_DIR</code> omgevingsvariabele) — geen vrij pad, om te
        voorkomen dat willekeurige bestanden op de server gelezen kunnen worden.
      </p>
    </div>
  );
}

export default function SettingsDialog({ isOpen, onClose, settings, onUpdate, webGpuSupported }: SettingsDialogProps) {
  const hasOpenAIKey = settings.openaiApiKey.length > 0;
  const hasAnthropicKey = settings.anthropicApiKey.length > 0;
  const noWebGpu = webGpuSupported === false;
  const isBrave = typeof (window.navigator as any).brave !== 'undefined';

  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileExternalMic, setNewProfileExternalMic] = useState(false);

  function saveNewProfile() {
    const name = newProfileName.trim();
    if (!name) return;
    const profile: DeviceProfile = {
      id: crypto.randomUUID(),
      name,
      externalMic: newProfileExternalMic,
      audioNormalizationGain: settings.audioNormalizationGain,
      chunkOverlapMs: settings.chunkOverlapMs,
      useVADChunking: settings.useVADChunking,
      vadSilenceThresholdMs: settings.vadSilenceThresholdMs,
      assemblyEndOfTurnThreshold: settings.assemblyEndOfTurnThreshold,
      assemblyTurnSilenceMs: settings.assemblyTurnSilenceMs,
      useTranscriptAsWhisperContext: settings.useTranscriptAsWhisperContext,
      chunkDurationSecs: 5,
    };
    onUpdate({
      deviceProfiles: [...settings.deviceProfiles, profile],
      activeDeviceProfileId: profile.id,
    });
    setIsSavingProfile(false);
    setNewProfileName('');
  }

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="w-full max-w-[calc(100vw-2rem)] sm:max-w-2xl max-h-[90vh] overflow-y-auto overflow-x-hidden" data-testid="dialog-settings">
        <DialogHeader>
          <DialogTitle>Settings</DialogTitle>
        </DialogHeader>

        <div className="space-y-6 py-2">

          {/* ── API Keys ── */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b border-border pb-1">
              API Keys
            </h3>
            <p className="text-xs text-muted-foreground">
              Keys are stored only in your browser. They are sent directly to the respective service for each request.
            </p>

            <ApiKeyField
              label="OpenAI API Key"
              placeholder="sk-..."
              description="Required for OpenAI Whisper transcription and GPT-4o-mini translation. Get one at platform.openai.com."
              value={settings.openaiApiKey}
              onChange={(v) => onUpdate({ openaiApiKey: v })}
              keyPrefix="sk-"
            />

            <ApiKeyField
              label="Anthropic API Key"
              placeholder="sk-ant-..."
              description="Required for Claude Haiku translation. Free tier available at console.anthropic.com."
              value={settings.anthropicApiKey}
              onChange={(v) => onUpdate({ anthropicApiKey: v })}
              keyPrefix="sk-ant-"
            />
          </section>

          {/* ── Transcription ── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground border-b border-border pb-1">
              Transcription
            </h3>
            <RadioGroup
              value={settings.transcriptionProvider}
              onValueChange={(v) => onUpdate({ transcriptionProvider: v as TranscriptionProvider })}
            >
              {/* OpenAI Whisper — requires OpenAI key */}
              <div className={`flex items-start gap-3 rounded-md border border-border p-3 transition-opacity ${!hasOpenAIKey ? 'opacity-50' : ''}`}>
                <RadioGroupItem value="whisper" id="t-whisper" className="mt-0.5" disabled={!hasOpenAIKey} />
                <div>
                  <Label htmlFor="t-whisper" className={`font-medium ${hasOpenAIKey ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                    OpenAI Whisper (gpt-4o-transcribe)
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Highest accuracy across 50+ languages. Same engine as ChatGPT voice.
                  </p>
                  {!hasOpenAIKey && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">Enter an OpenAI API key above to enable.</p>
                  )}
                </div>
              </div>

              {/* Local MLX Whisper — Apple Silicon only, no key/network needed */}
              <div className="flex items-start gap-3 rounded-md border border-border p-3">
                <RadioGroupItem value="mlx" id="t-mlx" className="mt-0.5" />
                <div>
                  <Label htmlFor="t-mlx" className="font-medium cursor-pointer">
                    Local Whisper (MLX){' '}
                    <span className="text-xs font-normal text-green-600 dark:text-green-400">free · offline</span>
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Runs whisper-large-v3 on-device via mlx-whisper. Apple Silicon Macs only —
                    requires the app's own server running locally with mlx-whisper installed.
                    Fastest and most private option; no API key needed.
                  </p>
                </div>
              </div>

              {/* Browser Speech — always available */}
              <div className="flex items-start gap-3 rounded-md border border-border p-3">
                <RadioGroupItem value="browser" id="t-browser" className="mt-0.5" />
                <div>
                  <Label htmlFor="t-browser" className="font-medium cursor-pointer">
                    Browser Speech API{' '}
                    <span className="text-xs font-normal text-green-600 dark:text-green-400">free</span>
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    No API key required. Best in Chrome or Edge. Lower accuracy than Whisper.
                  </p>
                  {isBrave && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                      Brave blocks Google's speech service by default. Disable Shields for this page, or use OpenAI Whisper instead.
                    </p>
                  )}
                </div>
              </div>

              {/* Local Whisper — requires WebGPU */}
              <div className={`flex items-start gap-3 rounded-md border border-border p-3 transition-opacity ${noWebGpu ? 'opacity-50' : ''}`}>
                <RadioGroupItem value="transformers" id="t-transformers" className="mt-0.5" disabled={noWebGpu} />
                <div className="flex-1">
                  <Label htmlFor="t-transformers" className={`font-medium ${noWebGpu ? 'cursor-not-allowed' : 'cursor-pointer'}`}>
                    Local Whisper (Transformers.js){' '}
                    <span className="text-xs font-normal text-green-600 dark:text-green-400">free · offline</span>
                  </Label>
                  {noWebGpu ? (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
                      WebGPU is not available in this browser. Use Chrome or Edge for local inference.
                    </p>
                  ) : (
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Runs Whisper in your browser. No API key needed. First use downloads the model once.
                    </p>
                  )}
                  {settings.transcriptionProvider === 'transformers' && !noWebGpu && (
                    <div className="mt-2">
                      <Select
                        value={settings.localWhisperModel}
                        onValueChange={(v) => onUpdate({ localWhisperModel: v as LocalWhisperModel })}
                      >
                        <SelectTrigger className="h-8 text-xs">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="tiny">Tiny (~40 MB) — fastest, lower accuracy</SelectItem>
                          <SelectItem value="small">Small (~244 MB) — recommended</SelectItem>
                          <SelectItem value="medium">
                            Medium (~769 MB) — high accuracy, requires strong WebGPU support
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  )}
                </div>
              </div>
            </RadioGroup>
          </section>

          {/* ── Translation & Correction ── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground border-b border-border pb-1">
              Translation &amp; Correction
            </h3>
            <RadioGroup
              value={settings.translationProvider}
              onValueChange={(v) => onUpdate({ translationProvider: v as TranslationProvider })}
            >
              {/* GPT-4o-mini — requires OpenAI key */}
              <div className={`flex items-start gap-3 rounded-md border border-border p-3 transition-opacity ${!hasOpenAIKey ? 'opacity-50' : ''}`}>
                <RadioGroupItem value="openai" id="tr-openai" className="mt-0.5" disabled={!hasOpenAIKey} />
                <div>
                  <Label htmlFor="tr-openai" className={`font-medium ${hasOpenAIKey ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                    OpenAI GPT-4o-mini
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Fast correction and translation.
                  </p>
                  {!hasOpenAIKey && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">Enter an OpenAI API key above to enable.</p>
                  )}
                </div>
              </div>

              {/* Claude Haiku — requires Anthropic key */}
              <div className={`flex items-start gap-3 rounded-md border border-border p-3 transition-opacity ${!hasAnthropicKey ? 'opacity-50' : ''}`}>
                <RadioGroupItem value="claude" id="tr-claude" className="mt-0.5" disabled={!hasAnthropicKey} />
                <div>
                  <Label htmlFor="tr-claude" className={`font-medium ${hasAnthropicKey ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                    Claude Haiku (Anthropic)
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Excellent translation quality. Anthropic offers a free tier.
                  </p>
                  {!hasAnthropicKey && (
                    <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">Enter an Anthropic API key above to enable.</p>
                  )}
                </div>
              </div>

              {/* Ollama — local LLM */}
              <div className="flex items-start gap-3 rounded-md border border-border p-3">
                <RadioGroupItem value="ollama" id="tr-ollama" className="mt-0.5" />
                <div className="flex-1 min-w-0">
                  <Label htmlFor="tr-ollama" className="font-medium cursor-pointer">
                    Ollama (local){' '}
                    <span className="text-xs font-normal text-green-600 dark:text-green-400">free · offline</span>
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Translate using a local model via Ollama. Requires Ollama running on your machine.
                  </p>
                  {settings.translationProvider === 'ollama' && (
                    <div className="mt-2 space-y-2">
                      <div>
                        <Label className="text-xs text-muted-foreground">Ollama base URL</Label>
                        <input
                          type="text"
                          value={settings.ollamaBaseUrl}
                          onChange={(e) => onUpdate({ ollamaBaseUrl: e.target.value })}
                          placeholder="http://localhost:11434"
                          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      </div>
                      <div>
                        <Label className="text-xs text-muted-foreground">Model name</Label>
                        <input
                          type="text"
                          value={settings.ollamaModel}
                          onChange={(e) => onUpdate({ ollamaModel: e.target.value })}
                          placeholder="qwen2.5:14b"
                          className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
                        />
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* None — always available */}
              <div className="flex items-start gap-3 rounded-md border border-border p-3">
                <RadioGroupItem value="none" id="tr-none" className="mt-0.5" />
                <div>
                  <Label htmlFor="tr-none" className="font-medium cursor-pointer">
                    None — transcription only{' '}
                    <span className="text-xs font-normal text-green-600 dark:text-green-400">free</span>
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Shows raw transcription without cleanup or translation. No API key needed when combined with Browser Speech API.
                  </p>
                </div>
              </div>
            </RadioGroup>
          </section>

          {/* ── Improve Transcription ── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground border-b border-border pb-1">
              Improve Transcription
            </h3>
            <p className="text-xs text-muted-foreground">
              The "Improve" button re-processes the last N characters with an LLM to fix spelling,
              punctuation, theological terms, and incoherent ASR output.
            </p>

            <div className="space-y-1">
              <Label className="text-xs font-medium">Provider</Label>
              <RadioGroup
                value={settings.improvementProvider}
                onValueChange={(v) => onUpdate({ improvementProvider: v as ImprovementProvider })}
              >
                <div className={`flex items-start gap-3 rounded-md border border-border p-3 transition-opacity ${!hasOpenAIKey ? 'opacity-50' : ''}`}>
                  <RadioGroupItem value="openai" id="imp-openai" className="mt-0.5" disabled={!hasOpenAIKey} />
                  <div>
                    <Label htmlFor="imp-openai" className={`font-medium ${hasOpenAIKey ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                      OpenAI GPT-4o-mini
                    </Label>
                    <p className="text-xs text-muted-foreground mt-0.5">Fast correction.</p>
                    {!hasOpenAIKey && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">Enter an OpenAI API key above to enable.</p>
                    )}
                  </div>
                </div>
                <div className={`flex items-start gap-3 rounded-md border border-border p-3 transition-opacity ${!hasAnthropicKey ? 'opacity-50' : ''}`}>
                  <RadioGroupItem value="claude" id="imp-claude" className="mt-0.5" disabled={!hasAnthropicKey} />
                  <div>
                    <Label htmlFor="imp-claude" className={`font-medium ${hasAnthropicKey ? 'cursor-pointer' : 'cursor-not-allowed'}`}>
                      Claude Haiku (Anthropic)
                    </Label>
                    <p className="text-xs text-muted-foreground mt-0.5">High-quality correction and theological term handling.</p>
                    {!hasAnthropicKey && (
                      <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">Enter an Anthropic API key above to enable.</p>
                    )}
                  </div>
                </div>
              </RadioGroup>
            </div>

            <div className="flex items-center gap-3">
              <Label htmlFor="default-lookback" className="text-xs font-medium whitespace-nowrap">
                Default chars to improve
              </Label>
              <Input
                id="default-lookback"
                type="number"
                min={100}
                max={9999}
                step={100}
                value={settings.defaultLookbackChars}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 100) onUpdate({ defaultLookbackChars: v });
                }}
                className="w-24 text-xs text-center"
              />
              <span className="text-xs text-muted-foreground">chars</span>
            </div>
          </section>

          {/* ── Advanced Audio ── */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b border-border pb-1">
              Advanced Audio
            </h3>

            {/* Chunk overlap */}
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Chunk overlap (Whisper mode)</Label>
              <p className="text-xs text-muted-foreground">
                Audio overlap prepended to each chunk to prevent words being cut at boundaries.
              </p>
              <RadioGroup
                value={String(settings.chunkOverlapMs)}
                onValueChange={(v) => onUpdate({ chunkOverlapMs: Number(v) as 0 | 500 | 1000 })}
                className="flex gap-4"
              >
                {([0, 500, 1000] as const).map((ms) => (
                  <div key={ms} className="flex items-center gap-1.5">
                    <RadioGroupItem value={String(ms)} id={`overlap-${ms}`} />
                    <Label htmlFor={`overlap-${ms}`} className="cursor-pointer text-xs">
                      {ms === 0 ? 'None' : `${ms} ms`}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>

            {/* Previous transcript context */}
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="whisper-context" className="font-medium cursor-pointer text-sm">
                  Previous transcript context
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Passes the last 2 sentences to Whisper as context for better inter-chunk continuity.
                </p>
              </div>
              <Switch
                id="whisper-context"
                checked={settings.useTranscriptAsWhisperContext}
                onCheckedChange={(checked) => onUpdate({ useTranscriptAsWhisperContext: checked })}
              />
            </div>

            {/* VAD chunking */}
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="vad-chunking" className="font-medium cursor-pointer text-sm">
                    Voice activity detection
                  </Label>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Commit a chunk on detected silence instead of a fixed timer.
                  </p>
                </div>
                <Switch
                  id="vad-chunking"
                  checked={settings.useVADChunking}
                  onCheckedChange={(checked) => onUpdate({ useVADChunking: checked })}
                />
              </div>
              {settings.useVADChunking && (
                <div className="flex items-center gap-3 pl-4">
                  <Label htmlFor="vad-threshold" className="text-xs font-medium whitespace-nowrap">
                    Silence threshold
                  </Label>
                  <input
                    id="vad-threshold"
                    type="range"
                    min={200}
                    max={2000}
                    step={100}
                    value={settings.vadSilenceThresholdMs}
                    onChange={(e) => onUpdate({ vadSilenceThresholdMs: Number(e.target.value) })}
                    className="flex-1 accent-primary"
                  />
                  <span className="text-xs text-muted-foreground w-14 text-right">
                    {settings.vadSilenceThresholdMs} ms
                  </span>
                </div>
              )}
            </div>

            {/* Normalization gain */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-3">
                <Label htmlFor="norm-gain" className="text-xs font-medium whitespace-nowrap">
                  Normalization gain
                </Label>
                <input
                  id="norm-gain"
                  type="range"
                  min={0.1}
                  max={10}
                  step={0.1}
                  value={settings.audioNormalizationGain}
                  onChange={(e) => onUpdate({ audioNormalizationGain: Number(e.target.value) })}
                  className="flex-1 accent-primary"
                />
                <span className="text-xs text-muted-foreground w-10 text-right">
                  {settings.audioNormalizationGain.toFixed(1)}×
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Amplify quiet microphones. 1.0 = no change. Use the normalization wizard to calibrate.
              </p>
            </div>

            {/* AssemblyAI thresholds */}
            <div className="space-y-3 rounded-md border border-border p-3">
              <div>
                <p className="text-xs font-medium">AssemblyAI streaming thresholds</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Applied when using the AssemblyAI streaming service (set at session start).
                </p>
              </div>
              <div className="flex items-center gap-3">
                <Label htmlFor="eot-threshold" className="text-xs whitespace-nowrap w-40">
                  End-of-turn confidence
                </Label>
                <input
                  id="eot-threshold"
                  type="range"
                  min={0.5}
                  max={1.0}
                  step={0.05}
                  value={settings.assemblyEndOfTurnThreshold}
                  onChange={(e) => onUpdate({ assemblyEndOfTurnThreshold: Number(e.target.value) })}
                  className="flex-1 accent-primary"
                />
                <span className="text-xs text-muted-foreground w-10 text-right">
                  {settings.assemblyEndOfTurnThreshold.toFixed(2)}
                </span>
              </div>
              <div className="flex items-center gap-3">
                <Label htmlFor="turn-silence" className="text-xs whitespace-nowrap w-40">
                  Turn silence
                </Label>
                <input
                  id="turn-silence"
                  type="range"
                  min={200}
                  max={2000}
                  step={100}
                  value={settings.assemblyTurnSilenceMs}
                  onChange={(e) => onUpdate({ assemblyTurnSilenceMs: Number(e.target.value) })}
                  className="flex-1 accent-primary"
                />
                <span className="text-xs text-muted-foreground w-14 text-right">
                  {settings.assemblyTurnSilenceMs} ms
                </span>
              </div>
            </div>

            {/* Show live audio controls */}
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="show-live-audio" className="font-medium cursor-pointer text-sm">
                  Show live audio controls during recording
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Adds a panel with VU meter, gain slider, and normalization wizard while recording.
                </p>
              </div>
              <Switch
                id="show-live-audio"
                checked={settings.showAdvancedAudioDuringRecording}
                onCheckedChange={(checked) => onUpdate({ showAdvancedAudioDuringRecording: checked })}
              />
            </div>
          </section>

          {/* ── Default Languages ── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground border-b border-border pb-1">
              Default Languages
            </h3>
            <p className="text-xs text-muted-foreground">
              These languages are pre-selected when you open the app. You can always change them per session.
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <LanguageSelector
                value={settings.defaultSourceLanguage}
                onChange={(v) => onUpdate({ defaultSourceLanguage: v })}
                label="Speaking in"
                testId="select-default-source-language"
              />
              <LanguageSelector
                value={settings.defaultTargetLanguage}
                onChange={(v) => onUpdate({ defaultTargetLanguage: v })}
                label="Translate to"
                testId="select-default-target-language"
              />
            </div>
          </section>

          {/* ── Theological Glossary ── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground border-b border-border pb-1">
              Theological Glossary
            </h3>
            <p className="text-xs text-muted-foreground">
              Terms that should be recognised and translated consistently. One entry per line.
              Optionally include a translation after <code>=</code> (e.g.{' '}
              <code>sanctification = heiliging</code>). Terms are also passed to Whisper to improve
              speech recognition of theological vocabulary.
            </p>
            <Textarea
              value={settings.theologicalGlossary}
              onChange={(e) => onUpdate({ theologicalGlossary: e.target.value })}
              placeholder={`sanctification = heiliging\natonement = verzoening\ncovenant = verbond\neschatology\nsoteriology\npneumatology`}
              rows={6}
              className="font-mono text-sm resize-y"
            />
          </section>

          {/* ── Device Profiles ── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground border-b border-border pb-1">
              Device Profiles
            </h3>
            <p className="text-xs text-muted-foreground">
              Save the current audio settings as a named preset for quick switching between devices
              (e.g. phone vs. laptop, with or without an external mic).
            </p>

            {settings.deviceProfiles.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs font-medium">Active profile</Label>
                <Select
                  value={settings.activeDeviceProfileId ?? '__none__'}
                  onValueChange={(v) => {
                    const profileId = v === '__none__' ? null : v;
                    if (!profileId) { onUpdate({ activeDeviceProfileId: null }); return; }
                    const profile = settings.deviceProfiles.find(p => p.id === profileId);
                    if (profile) {
                      onUpdate({
                        activeDeviceProfileId: profile.id,
                        audioNormalizationGain: profile.audioNormalizationGain,
                        chunkOverlapMs: profile.chunkOverlapMs,
                        useVADChunking: profile.useVADChunking,
                        vadSilenceThresholdMs: profile.vadSilenceThresholdMs,
                        assemblyEndOfTurnThreshold: profile.assemblyEndOfTurnThreshold,
                        assemblyTurnSilenceMs: profile.assemblyTurnSilenceMs,
                        useTranscriptAsWhisperContext: profile.useTranscriptAsWhisperContext,
                      });
                    }
                  }}
                >
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">— None —</SelectItem>
                    {settings.deviceProfiles.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}{p.externalMic ? ' · external mic' : ''}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {isSavingProfile ? (
              <div className="space-y-2 rounded-md border border-border p-3">
                <Label className="text-xs font-medium">Profile name</Label>
                <Input
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  placeholder="e.g. Pixel 7 Pro – external mic"
                  className="text-sm"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveNewProfile();
                    if (e.key === 'Escape') { setIsSavingProfile(false); setNewProfileName(''); }
                  }}
                />
                <div className="flex items-center gap-2">
                  <Switch
                    id="new-profile-ext-mic"
                    checked={newProfileExternalMic}
                    onCheckedChange={setNewProfileExternalMic}
                  />
                  <Label htmlFor="new-profile-ext-mic" className="text-xs cursor-pointer">
                    External microphone
                  </Label>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={saveNewProfile} disabled={!newProfileName.trim()}>
                    Save
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => { setIsSavingProfile(false); setNewProfileName(''); }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <Button
                variant="outline"
                size="sm"
                onClick={() => { setIsSavingProfile(true); setNewProfileName(''); setNewProfileExternalMic(false); }}
              >
                Save current settings as profile…
              </Button>
            )}

            {settings.deviceProfiles.length > 0 && (
              <div className="space-y-1">
                <Label className="text-xs font-medium text-muted-foreground">Saved profiles</Label>
                {settings.deviceProfiles.map((p) => (
                  <div key={p.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2">
                    <div>
                      <span className="text-sm font-medium">{p.name}</span>
                      {p.externalMic && (
                        <span className="text-xs text-muted-foreground ml-2">· external mic</span>
                      )}
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive h-7 px-2"
                      onClick={() => {
                        onUpdate({
                          deviceProfiles: settings.deviceProfiles.filter(x => x.id !== p.id),
                          activeDeviceProfileId:
                            settings.activeDeviceProfileId === p.id ? null : settings.activeDeviceProfileId,
                        });
                      }}
                    >
                      Delete
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Sermon Mode ── */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-foreground border-b border-border pb-1">
              Preekmodus
            </h3>
            <p className="text-xs text-muted-foreground">
              Instellingen voor de dual-pane preekvertaler. Bracket-size en
              stabiliteit werken direct door op een lopende sessie — geen herstart nodig.
            </p>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs font-medium">Correctieprovider (ASR)</Label>
                <Select
                  value={settings.sermonCorrectionProvider}
                  onValueChange={(v) => onUpdate({ sermonCorrectionProvider: v as SermonTranslationProvider })}
                >
                  <SelectTrigger className="h-8 text-xs" data-testid="select-sermon-correction-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI GPT-4o-mini</SelectItem>
                    <SelectItem value="claude">Claude Haiku</SelectItem>
                    <SelectItem value="ollama">Ollama (lokaal)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs font-medium">Vertaalprovider</Label>
                <Select
                  value={settings.sermonTranslationProvider}
                  onValueChange={(v) => onUpdate({ sermonTranslationProvider: v as SermonTranslationProvider })}
                >
                  <SelectTrigger className="h-8 text-xs" data-testid="select-sermon-translation-provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="openai">OpenAI GPT-4o-mini</SelectItem>
                    <SelectItem value="claude">Claude Haiku</SelectItem>
                    <SelectItem value="ollama">Ollama (lokaal)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="sermon-model" className="text-xs font-medium">Modelnaam</Label>
              <input
                id="sermon-model"
                type="text"
                value={settings.sermonModel}
                onChange={(e) => onUpdate({ sermonModel: e.target.value })}
                placeholder="gpt-4o-mini"
                className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
              />
            </div>

            <div className="flex items-center gap-3">
              <Label htmlFor="sermon-max-latency" className="text-xs font-medium whitespace-nowrap w-40">
                Max. vertraging (bracket-size)
              </Label>
              <input
                id="sermon-max-latency"
                type="range"
                min={3}
                max={20}
                step={1}
                value={settings.sermonMaxLatencySecs}
                onChange={(e) => onUpdate({ sermonMaxLatencySecs: Number(e.target.value) })}
                className="flex-1 accent-primary"
              />
              <span className="text-xs text-muted-foreground w-10 text-right">
                {settings.sermonMaxLatencySecs}s
              </span>
            </div>

            <div className="flex items-center gap-3">
              <Label htmlFor="sermon-stability" className="text-xs font-medium whitespace-nowrap w-40">
                Stabiliteits-debounce
              </Label>
              <input
                id="sermon-stability"
                type="range"
                min={300}
                max={5000}
                step={100}
                value={settings.sermonStabilityMs}
                onChange={(e) => onUpdate({ sermonStabilityMs: Number(e.target.value) })}
                className="flex-1 accent-primary"
              />
              <span className="text-xs text-muted-foreground w-14 text-right">
                {settings.sermonStabilityMs} ms
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="flex items-center gap-2">
                <Label htmlFor="sermon-context-before" className="text-xs font-medium whitespace-nowrap">
                  Context vóór
                </Label>
                <Input
                  id="sermon-context-before"
                  type="number"
                  min={0}
                  max={5}
                  value={settings.sermonContextBefore}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!Number.isNaN(v)) onUpdate({ sermonContextBefore: v });
                  }}
                  className="w-16 text-xs text-center"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="sermon-context-after" className="text-xs font-medium whitespace-nowrap">
                  Context ná
                </Label>
                <Input
                  id="sermon-context-after"
                  type="number"
                  min={0}
                  max={3}
                  value={settings.sermonContextAfter}
                  onChange={(e) => {
                    const v = parseInt(e.target.value, 10);
                    if (!Number.isNaN(v)) onUpdate({ sermonContextAfter: v });
                  }}
                  className="w-16 text-xs text-center"
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="sermon-auto-translate" className="font-medium cursor-pointer text-sm">
                  Automatisch vertalen
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Nieuwe zinnen automatisch vertalen zodra ze stabiel zijn. Refresh werkt altijd, ook uit.
                </p>
              </div>
              <Switch
                id="sermon-auto-translate"
                checked={settings.sermonAutoTranslate}
                onCheckedChange={(checked) => onUpdate({ sermonAutoTranslate: checked })}
              />
            </div>

            <p className="text-xs text-muted-foreground italic">
              Preekmodus forceert tijdens opnemen voice-activity-detection chunking met overlap 0
              (i.p.v. de audio-instellingen hierboven) — zo landen chunkgrenzen tussen woorden.
            </p>
          </section>

          {/* ── Preekmodus — woordenlijst ── */}
          <section className="space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-1">
              <h3 className="text-sm font-semibold text-foreground">
                Preekmodus — woordenlijst
              </h3>
              <Switch
                checked={settings.sermonGlossaryEnabled}
                onCheckedChange={(checked) => onUpdate({ sermonGlossaryEnabled: checked })}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Bestandsgebaseerde theologische woordenlijst + disambiguatie-instructie, opgebouwd
              als stabiel vertaalprefix (zie de "Theological Glossary" hierboven voor de vrije-tekst
              variant, gebruikt zolang deze woordenlijst uit staat of niet geladen kan worden).
            </p>
            <GlossaryPanel settings={settings} onUpdate={onUpdate} isOpen={isOpen} />
          </section>

          {/* ── Preekmodus — Schriftcitaten ── */}
          <section className="space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-1">
              <h3 className="text-sm font-semibold text-foreground">
                Preekmodus — Schriftcitaten
              </h3>
              <Switch
                checked={settings.sermonScriptureEnabled}
                onCheckedChange={(checked) => onUpdate({ sermonScriptureEnabled: checked })}
                data-testid="switch-scripture-enabled"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Herkent een Bijbelreferentie ("Johannes 3:16") in de brontekst en vervangt een
              woordelijk voorgelezen vers door de exacte Engelse verstekst i.p.v. een
              model-vertaling — gemarkeerd als <code>SCRIPTURE</code> in de segmentrij. Parafraseert
              de prediker het vers, dan wordt zíjn formulering gewoon vertaald.
            </p>

            {settings.sermonScriptureEnabled && (
              <>
                <ApiKeyField
                  label="ESV API Key"
                  placeholder="uw ESV API-sleutel"
                  description="Voorkeursbron voor de verstekst — gratis voor niet-commercieel gebruik via api.esv.org. Zonder sleutel (of bij een mislukte lookup) wordt teruggevallen op de gebundelde King James Version."
                  value={settings.esvApiKey}
                  onChange={(v) => onUpdate({ esvApiKey: v })}
                />

                <div className="space-y-1">
                  <Label className="text-xs font-medium">Als ESV niet beschikbaar is</Label>
                  <Select
                    value={settings.sermonScriptureFallback}
                    onValueChange={(v) => onUpdate({ sermonScriptureFallback: v as SermonScriptureFallback })}
                  >
                    <SelectTrigger className="h-8 text-xs" data-testid="select-scripture-fallback">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="kjv">Terugvallen op King James Version (aanbevolen)</SelectItem>
                      <SelectItem value="none">Niet vervangen — gewoon vertalen als model-tekst</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                <p className="text-xs text-muted-foreground italic">
                  Scripture quotations marked ESV are from the ESV® Bible (The Holy Bible, English
                  Standard Version®), copyright © 2001 by Crossway, a publishing ministry of Good
                  News Publishers. Used by permission. All rights reserved. De King James Version
                  is public domain.
                </p>
              </>
            )}
          </section>

          {/* ── Debug Mode ── */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-foreground border-b border-border pb-1">
              Debug Mode
            </h3>
            <div className="flex items-center justify-between">
              <div>
                <Label htmlFor="debug-mode" className="font-medium cursor-pointer">
                  Show live status messages
                </Label>
                <p className="text-xs text-muted-foreground mt-0.5">
                  Displays a real-time log of what the app is doing — recording, sending to Whisper, API key errors, etc.
                </p>
              </div>
              <Switch
                id="debug-mode"
                checked={settings.debugMode}
                onCheckedChange={(checked) => onUpdate({ debugMode: checked })}
              />
            </div>
          </section>

          {/* ── Free mode callout ── */}
          {(settings.transcriptionProvider === 'browser' || settings.translationProvider === 'none') && (
            <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground space-y-1">
              <p className="font-semibold text-foreground">Free mode active</p>
              {settings.transcriptionProvider === 'browser' && (
                <p>Browser Speech API is used for transcription — works best in Chrome or Edge on a desktop with a clear microphone.</p>
              )}
              {settings.translationProvider === 'none' && (
                <p>Translation is disabled. Only the transcribed text will be shown.</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button onClick={onClose} data-testid="button-settings-done">Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

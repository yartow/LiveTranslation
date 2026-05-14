import { useState } from 'react';
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
import type { AppSettings, TranscriptionProvider, TranslationProvider, ImprovementProvider, LocalWhisperModel } from '@/hooks/useSettings';
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

export default function SettingsDialog({ isOpen, onClose, settings, onUpdate, webGpuSupported }: SettingsDialogProps) {
  const hasOpenAIKey = settings.openaiApiKey.length > 0;
  const hasAnthropicKey = settings.anthropicApiKey.length > 0;
  const noWebGpu = webGpuSupported === false;
  const isBrave = typeof (window.navigator as any).brave !== 'undefined';

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

import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import type { ImprovementProvider, TranslationProvider } from '@/hooks/useSettings';
import { Note, PageHeader, RadioOption, SettingCard, SettingItem, Warning } from '../primitives';
import type { SettingsPageProps } from './types';

// ── Translation ──

export function LiveTranslationPage({ settings, onUpdate }: SettingsPageProps) {
  const hasOpenAIKey = settings.openaiApiKey.length > 0;
  const hasAnthropicKey = settings.anthropicApiKey.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader pageId="live-translation" />

      <SettingItem id="live-translation-provider">
        <RadioGroup
          value={settings.translationProvider}
          onValueChange={(v) => onUpdate({ translationProvider: v as TranslationProvider })}
          className="gap-2"
        >
          <RadioOption
            value="openai"
            id="tr-openai"
            title="OpenAI GPT-4o-mini"
            tag="online"
            disabled={!hasOpenAIKey}
            description="Fast correction and translation."
            warning={!hasOpenAIKey && <Warning>Enter an OpenAI API key under API keys to enable.</Warning>}
          />
          <RadioOption
            value="claude"
            id="tr-claude"
            title="Claude Haiku (Anthropic)"
            tag="online"
            disabled={!hasAnthropicKey}
            description="Excellent translation quality."
            warning={!hasAnthropicKey && <Warning>Enter an Anthropic API key under API keys to enable.</Warning>}
          />
          <RadioOption
            value="ollama"
            id="tr-ollama"
            title="Ollama (local)"
            tag="free · offline"
            description="Translate with a local model. Requires Ollama running on this machine; the address and model are set under General › Local models (Ollama)."
          />
          <RadioOption
            value="none"
            id="tr-none"
            title="None — transcription only"
            tag="free"
            description="Shows the raw transcription without cleanup or translation. No API key needed with the Browser Speech API."
          />
        </RadioGroup>
      </SettingItem>

      {(settings.transcriptionProvider === 'browser' || settings.translationProvider === 'none') && (
        <div className="rounded-md bg-muted p-3 text-xs text-muted-foreground space-y-1">
          <p className="font-semibold text-foreground">Free mode active</p>
          {settings.transcriptionProvider === 'browser' && (
            <p>The Browser Speech API is used for transcription — works best in Chrome or Edge on a desktop with a clear microphone.</p>
          )}
          {settings.translationProvider === 'none' && (
            <p>Translation is disabled. Only the transcribed text will be shown.</p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Improve button ──

export function LiveImprovePage({ settings, onUpdate }: SettingsPageProps) {
  const hasOpenAIKey = settings.openaiApiKey.length > 0;
  const hasAnthropicKey = settings.anthropicApiKey.length > 0;

  return (
    <div className="space-y-6">
      <PageHeader pageId="live-improve" />
      <Note>
        The Improve button re-processes the last N characters with a language model to fix spelling,
        punctuation, theological terms and garbled speech recognition. It is independent of the
        translation provider.
      </Note>

      <SettingItem id="improve-provider">
        <RadioGroup
          value={settings.improvementProvider}
          onValueChange={(v) => onUpdate({ improvementProvider: v as ImprovementProvider })}
          className="gap-2"
        >
          <RadioOption
            value="openai"
            id="imp-openai"
            title="OpenAI GPT-4o-mini"
            disabled={!hasOpenAIKey}
            description="Fast correction."
            warning={!hasOpenAIKey && <Warning>Enter an OpenAI API key under API keys to enable.</Warning>}
          />
          <RadioOption
            value="claude"
            id="imp-claude"
            title="Claude Haiku (Anthropic)"
            disabled={!hasAnthropicKey}
            description="High-quality correction and theological term handling."
            warning={!hasAnthropicKey && <Warning>Enter an Anthropic API key under API keys to enable.</Warning>}
          />
        </RadioGroup>
      </SettingItem>

      <SettingItem id="improve-chars" htmlFor="default-lookback">
        <div className="flex items-center gap-3">
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
          <span className="text-xs text-muted-foreground">characters</span>
        </div>
      </SettingItem>
    </div>
  );
}

// ── Audio & chunking ──

export function LiveAudioPage({ settings, onUpdate }: SettingsPageProps) {
  return (
    <div className="space-y-6">
      <PageHeader pageId="live-audio" />
      <Note>These apply to Live mode only. Sermon mode uses its own fixed chunking (see Sermon mode › Timing).</Note>

      <SettingItem id="chunk-overlap">
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
      </SettingItem>

      <div className="space-y-3">
        <SettingItem id="vad" layout="row" htmlFor="vad-chunking">
          <Switch
            id="vad-chunking"
            checked={settings.useVADChunking}
            onCheckedChange={(checked) => onUpdate({ useVADChunking: checked })}
          />
        </SettingItem>
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

      <SettingItem id="assembly-thresholds">
        <SettingCard>
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
        </SettingCard>
      </SettingItem>

      <SettingItem id="show-live-audio" layout="row" htmlFor="show-live-audio-switch">
        <Switch
          id="show-live-audio-switch"
          checked={settings.showAdvancedAudioDuringRecording}
          onCheckedChange={(checked) => onUpdate({ showAdvancedAudioDuringRecording: checked })}
        />
      </SettingItem>
    </div>
  );
}

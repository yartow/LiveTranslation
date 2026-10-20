import { useState } from 'react';
import LanguageSelector from '@/components/LanguageSelector';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RadioGroup } from '@/components/ui/radio-group';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { isBuiltInMic, useMicDevices } from '@/hooks/useMicDevices';
import type { DeviceProfile, LocalWhisperModel, TranscriptionProvider } from '@/hooks/useSettings';
import ApiKeyField from '../ApiKeyField';
import GlossaryPanel from '../GlossaryPanel';
import { ModeBadge, Note, PageHeader, RadioOption, SettingItem, Warning } from '../primitives';
import { getItem } from '../settings-index';
import type { SettingsPageProps } from './types';

// ── API keys ──

export function ApiKeysPage({ settings, onUpdate }: SettingsPageProps) {
  const openai = getItem('openai-key');
  const anthropic = getItem('anthropic-key');
  const esv = getItem('esv-key');
  return (
    <div className="space-y-6">
      <PageHeader pageId="api-keys" />
      <Note>
        Keys are stored only in your browser (cleared when the tab closes). They are sent to the
        respective service with each request, never saved on the server.
      </Note>
      <div id="setting-openai-key" className="rounded-md p-1 -m-1 transition-shadow">
        <ApiKeyField
          label={openai.label}
          placeholder="sk-..."
          description={openai.description}
          value={settings.openaiApiKey}
          onChange={(v) => onUpdate({ openaiApiKey: v })}
          keyPrefix="sk-"
        />
      </div>
      <div id="setting-anthropic-key" className="rounded-md p-1 -m-1 transition-shadow">
        <ApiKeyField
          label={anthropic.label}
          placeholder="sk-ant-..."
          description={anthropic.description}
          value={settings.anthropicApiKey}
          onChange={(v) => onUpdate({ anthropicApiKey: v })}
          keyPrefix="sk-ant-"
        />
      </div>
      <div id="setting-esv-key" className="rounded-md p-1 -m-1 transition-shadow">
        <ApiKeyField
          label={esv.label}
          placeholder="Your ESV API key"
          description={esv.description}
          value={settings.esvApiKey}
          onChange={(v) => onUpdate({ esvApiKey: v })}
          badge={<ModeBadge scope="sermon" />}
        />
      </div>
    </div>
  );
}

// ── Languages ──

export function LanguagesPage({ settings, onUpdate }: SettingsPageProps) {
  return (
    <div className="space-y-6">
      <PageHeader pageId="languages" />
      <div id="setting-source-language" className="rounded-md p-1 -m-1 transition-shadow">
        <LanguageSelector
          value={settings.defaultSourceLanguage}
          onChange={(v) => onUpdate({ defaultSourceLanguage: v })}
          label={getItem('source-language').label}
          testId="select-default-source-language"
        />
        <Note>{getItem('source-language').description}</Note>
      </div>
      <div id="setting-target-language" className="rounded-md p-1 -m-1 transition-shadow">
        <LanguageSelector
          value={settings.defaultTargetLanguage}
          onChange={(v) => onUpdate({ defaultTargetLanguage: v })}
          label={getItem('target-language').label}
          testId="select-default-target-language"
        />
        <Note>{getItem('target-language').description}</Note>
      </div>
    </div>
  );
}

// ── Speech recognition ──

export function SpeechPage({ settings, onUpdate, webGpuSupported }: SettingsPageProps) {
  const hasOpenAIKey = settings.openaiApiKey.length > 0;
  const noWebGpu = webGpuSupported === false;
  const isBrave = typeof (window.navigator as any).brave !== 'undefined';
  const sermonFallback = settings.transcriptionProvider === 'browser' || settings.transcriptionProvider === 'transformers';

  return (
    <div className="space-y-6">
      <PageHeader pageId="speech" />
      <SettingItem id="transcription-provider">
        <RadioGroup
          value={settings.transcriptionProvider}
          onValueChange={(v) => onUpdate({ transcriptionProvider: v as TranscriptionProvider })}
          className="gap-2"
        >
          <RadioOption
            value="whisper"
            id="t-whisper"
            title="OpenAI Whisper (gpt-4o-transcribe)"
            tag="online"
            scope="both"
            disabled={!hasOpenAIKey}
            description="Highest accuracy across 50+ languages. Needs an OpenAI API key."
            warning={!hasOpenAIKey && <Warning>Enter an OpenAI API key under API keys to enable.</Warning>}
          />
          <RadioOption
            value="mlx"
            id="t-mlx"
            title="Local Whisper (MLX)"
            tag="free · offline"
            scope="both"
            description="Runs whisper-large-v3 on this Mac via mlx-whisper. Apple Silicon only, and the app's server must be running locally with mlx-whisper installed. Fastest and most private; no API key."
          />
          <RadioOption
            value="browser"
            id="t-browser"
            title="Browser Speech API"
            tag="free"
            scope="live"
            description="No API key. Best in Chrome or Edge; lower accuracy than Whisper."
            warning={isBrave && (
              <Warning>Brave blocks Google's speech service by default. Disable Shields for this page, or use OpenAI Whisper.</Warning>
            )}
          />
          <RadioOption
            value="transformers"
            id="t-transformers"
            title="Local Whisper (Transformers.js)"
            tag="free · offline"
            scope="live"
            disabled={noWebGpu}
            description={noWebGpu
              ? 'WebGPU is not available in this browser. Use Chrome or Edge for local inference.'
              : 'Runs Whisper inside your browser. No API key. The first use downloads the model once.'}
          />
        </RadioGroup>
        {sermonFallback && (
          <Note>
            Sermon mode cannot use this engine and falls back to OpenAI Whisper (it needs an OpenAI key).
          </Note>
        )}
      </SettingItem>

      {settings.transcriptionProvider === 'transformers' && !noWebGpu && (
        <SettingItem id="local-whisper-model">
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
              <SelectItem value="medium">Medium (~769 MB) — high accuracy, needs strong WebGPU support</SelectItem>
            </SelectContent>
          </Select>
        </SettingItem>
      )}
    </div>
  );
}

// ── Microphone ──

export function MicrophonePage({ settings, onUpdate }: SettingsPageProps) {
  const [isSavingProfile, setIsSavingProfile] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileExternalMic, setNewProfileExternalMic] = useState(false);
  const mics = useMicDevices();

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
    <div className="space-y-6">
      <PageHeader pageId="microphone" />

      <SettingItem id="mic-device">
        <Select
          value={settings.micDeviceId || '__default__'}
          onValueChange={(v) => onUpdate({ micDeviceId: v === '__default__' ? '' : v })}
        >
          <SelectTrigger className="h-8 text-xs" data-testid="select-mic-device">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__default__">System default{mics.defaultLabel ? ` (${mics.defaultLabel})` : ''}</SelectItem>
            {mics.devices.map((d) => (
              <SelectItem key={d.deviceId} value={d.deviceId}>
                {d.label} · {isBuiltInMic(d.label) ? 'built-in' : 'external'}
              </SelectItem>
            ))}
            {settings.micDeviceId && !mics.devices.some((d) => d.deviceId === settings.micDeviceId) && (
              <SelectItem value={settings.micDeviceId}>Saved microphone (not connected)</SelectItem>
            )}
          </SelectContent>
        </Select>
        {!mics.hasLabels && (
          <Note>Microphone names appear after you have started a recording once and allowed access.</Note>
        )}
      </SettingItem>

      <SettingItem id="raw-audio" layout="row" htmlFor="raw-audio-switch">
        <Switch
          id="raw-audio-switch"
          checked={settings.rawAudioCapture}
          onCheckedChange={(checked) => onUpdate({ rawAudioCapture: checked })}
        />
      </SettingItem>

      <SettingItem id="norm-gain" htmlFor="norm-gain-slider">
        <div className="flex items-center gap-3">
          <input
            id="norm-gain-slider"
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
      </SettingItem>

      <SettingItem id="device-profiles">
        <div className="space-y-3">
          {settings.deviceProfiles.length > 0 && (
            <div className="space-y-1">
              <Label className="text-xs font-medium">Active profile</Label>
              <Select
                value={settings.activeDeviceProfileId ?? '__none__'}
                onValueChange={(v) => {
                  const profileId = v === '__none__' ? null : v;
                  if (!profileId) { onUpdate({ activeDeviceProfileId: null }); return; }
                  const profile = settings.deviceProfiles.find((p) => p.id === profileId);
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
                        deviceProfiles: settings.deviceProfiles.filter((x) => x.id !== p.id),
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
        </div>
      </SettingItem>
    </div>
  );
}

// ── Local models (Ollama) ──

export function OllamaPage({ settings, onUpdate }: SettingsPageProps) {
  return (
    <div className="space-y-6">
      <PageHeader pageId="ollama" />
      <Note>
        These two fields apply wherever a provider is set to Ollama: the Sermon mode correction and
        translation providers, and Live mode translation. Ollama itself must be running on this machine.
      </Note>
      <SettingItem id="ollama-url" htmlFor="ollama-url-input">
        <Input
          id="ollama-url-input"
          type="text"
          value={settings.ollamaBaseUrl}
          onChange={(e) => onUpdate({ ollamaBaseUrl: e.target.value })}
          placeholder="http://localhost:11434"
          className="h-8 text-xs"
        />
      </SettingItem>
      <SettingItem id="ollama-model" htmlFor="ollama-model-input">
        <Input
          id="ollama-model-input"
          type="text"
          value={settings.ollamaModel}
          onChange={(e) => onUpdate({ ollamaModel: e.target.value })}
          placeholder="qwen3.6:latest"
          className="h-8 text-xs"
        />
      </SettingItem>
    </div>
  );
}

// ── Glossary ──

export function GlossaryPage({ settings, onUpdate, isOpen }: SettingsPageProps) {
  return (
    <div className="space-y-6">
      <PageHeader pageId="glossary" />
      <Note>
        There are two glossaries. <strong>Vocabulary hints</strong> is a short list you type here and
        is used in both modes. <strong>Glossary files</strong> are a CSV plus an instruction document
        on the server and are used only for Sermon translation; when they are on, they take the place
        of the vocabulary hints for that translation step.
      </Note>

      <SettingItem id="vocab-hints" htmlFor="vocab-hints-input">
        <Textarea
          id="vocab-hints-input"
          value={settings.theologicalGlossary}
          onChange={(e) => onUpdate({ theologicalGlossary: e.target.value })}
          placeholder={`sanctification = heiliging\natonement = verzoening\ncovenant = verbond\neschatology\nsoteriology\npneumatology`}
          rows={6}
          className="font-mono text-sm resize-y"
        />
      </SettingItem>

      <GlossaryPanel settings={settings} onUpdate={onUpdate} isOpen={isOpen} />
    </div>
  );
}

// ── Debug ──

export function DebugPage({ settings, onUpdate }: SettingsPageProps) {
  return (
    <div className="space-y-6">
      <PageHeader pageId="debug" />
      <SettingItem id="debug-mode" layout="row" htmlFor="debug-mode-switch">
        <Switch
          id="debug-mode-switch"
          checked={settings.debugMode}
          onCheckedChange={(checked) => onUpdate({ debugMode: checked })}
        />
      </SettingItem>
    </div>
  );
}

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { SermonBibleVersion, SermonScriptureFallback, SermonTranslationProvider } from '@/hooks/useSettings';
import CopyableUrlList from '@/components/CopyableUrlList';
import { useLanAddress } from '@/hooks/useLanAddress';
import { Note, PageHeader, SettingItem, Warning } from '../primitives';
import type { SettingsPageProps } from './types';

/**
 * A decimal number box that lets you type: the value is held as text while editing and only clamped to
 * [min, max] when you leave the box (a value already in range applies at once). Clamping on every keystroke
 * turned the first "0" of "0.3" into the minimum and made the rest impossible to type.
 */
function DecimalInput({ id, value, min, max, step, onCommit }: {
  id: string; value: number; min: number; max: number; step: number; onCommit: (v: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => { setDraft(String(value)); }, [value]);
  return (
    <Input
      id={id}
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        const v = parseFloat(e.target.value);
        if (!Number.isNaN(v) && v >= min && v <= max) onCommit(v);
      }}
      onBlur={() => {
        const v = parseFloat(draft);
        const next = Number.isNaN(v) ? value : Math.max(min, Math.min(max, v));
        setDraft(String(next));
        if (next !== value) onCommit(next);
      }}
      className="w-24 text-xs text-center"
    />
  );
}

function ProviderSelect({
  value,
  onChange,
  testId,
}: {
  value: SermonTranslationProvider;
  onChange: (v: SermonTranslationProvider) => void;
  testId: string;
}) {
  return (
    <Select value={value} onValueChange={(v) => onChange(v as SermonTranslationProvider)}>
      <SelectTrigger className="h-8 text-xs" data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="openai">OpenAI GPT-4o-mini</SelectItem>
        <SelectItem value="claude">Claude Haiku</SelectItem>
        <SelectItem value="ollama">Ollama (local)</SelectItem>
      </SelectContent>
    </Select>
  );
}

// ── Transcript correction ──

export function SermonCorrectionPage({ settings, onUpdate }: SettingsPageProps) {
  return (
    <div className="space-y-6">
      <PageHeader pageId="sermon-correction" />
      <Note>
        This step runs on each ~6–20 second chunk right after Whisper transcribes it, so a slow model
        here delays the transcript. Translation is a separate step with its own provider.
      </Note>

      <SettingItem id="sermon-asr-correction" layout="row" htmlFor="sermon-asr-correction-switch">
        <Switch
          id="sermon-asr-correction-switch"
          checked={settings.sermonAsrCorrection}
          onCheckedChange={(checked) => onUpdate({ sermonAsrCorrection: checked })}
          data-testid="switch-sermon-asr-correction"
        />
      </SettingItem>

      <div className={settings.sermonAsrCorrection ? '' : 'opacity-50 pointer-events-none'}>
        <SettingItem id="sermon-correction-provider">
          <ProviderSelect
            value={settings.sermonCorrectionProvider}
            onChange={(v) => onUpdate({ sermonCorrectionProvider: v })}
            testId="select-sermon-correction-provider"
          />
        </SettingItem>
        {!settings.sermonAsrCorrection && <Note>Not used while "Correct each chunk" is off.</Note>}
      </div>
    </div>
  );
}

// ── Translation ──

export function SermonTranslationPage({ settings, onUpdate }: SettingsPageProps) {
  const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(max, v));
  return (
    <div className="space-y-6">
      <PageHeader pageId="sermon-translation" />

      <SettingItem id="sermon-translation-provider">
        <ProviderSelect
          value={settings.sermonTranslationProvider}
          onChange={(v) => onUpdate({ sermonTranslationProvider: v })}
          testId="select-sermon-translation-provider"
        />
        {settings.sermonTranslationProvider === 'ollama' && (
          <Note>The Ollama address and model are set under General › Local models (Ollama).</Note>
        )}
      </SettingItem>

      {settings.sermonTranslationProvider === 'openai' && (
        <SettingItem id="sermon-model" htmlFor="sermon-model-input">
          <Input
            id="sermon-model-input"
            type="text"
            value={settings.sermonModel}
            onChange={(e) => onUpdate({ sermonModel: e.target.value })}
            placeholder="gpt-4o-mini"
            className="h-8 text-xs"
          />
        </SettingItem>
      )}

      <SettingItem id="sermon-auto-translate" layout="row" htmlFor="sermon-auto-translate-switch">
        <Switch
          id="sermon-auto-translate-switch"
          checked={settings.sermonAutoTranslate}
          onCheckedChange={(checked) => onUpdate({ sermonAutoTranslate: checked })}
        />
      </SettingItem>

      <SettingItem id="sermon-back-translation" layout="row" htmlFor="sermon-back-translation-switch">
        <Switch
          id="sermon-back-translation-switch"
          checked={settings.sermonBackTranslationCheck}
          onCheckedChange={(checked) => onUpdate({ sermonBackTranslationCheck: checked })}
        />
      </SettingItem>

      {settings.sermonBackTranslationCheck && (
        <SettingItem id="sermon-back-translation-threshold" htmlFor="sermon-back-translation-threshold-input">
          <DecimalInput
            id="sermon-back-translation-threshold-input"
            min={0.05}
            max={0.6}
            step={0.05}
            value={settings.sermonBackTranslationThreshold}
            onCommit={(v) => onUpdate({ sermonBackTranslationThreshold: v })}
          />
        </SettingItem>
      )}

      <SettingItem id="sermon-context">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
          <div className="flex items-center gap-2">
            <Label htmlFor="sermon-context-before" className="text-xs font-medium whitespace-nowrap">
              Before
            </Label>
            <Input
              id="sermon-context-before"
              type="number"
              min={0}
              max={5}
              value={settings.sermonContextBefore}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isNaN(v)) onUpdate({ sermonContextBefore: clamp(v, 0, 5) });
              }}
              className="w-16 text-xs text-center"
            />
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="sermon-context-after" className="text-xs font-medium whitespace-nowrap">
              After
            </Label>
            <Input
              id="sermon-context-after"
              type="number"
              min={0}
              max={3}
              value={settings.sermonContextAfter}
              onChange={(e) => {
                const v = parseInt(e.target.value, 10);
                if (!Number.isNaN(v)) onUpdate({ sermonContextAfter: clamp(v, 0, 3) });
              }}
              className="w-16 text-xs text-center"
            />
          </div>
        </div>
      </SettingItem>
    </div>
  );
}

// ── Timing ──

export function SermonTimingPage({ settings, onUpdate }: SettingsPageProps) {
  return (
    <div className="space-y-6">
      <PageHeader pageId="sermon-timing" />

      <SettingItem id="sermon-max-latency" htmlFor="sermon-max-latency-slider">
        <div className="flex items-center gap-3">
          <input
            id="sermon-max-latency-slider"
            type="range"
            min={3}
            max={20}
            step={1}
            value={settings.sermonMaxLatencySecs}
            onChange={(e) => onUpdate({ sermonMaxLatencySecs: Number(e.target.value) })}
            className="flex-1 accent-primary"
          />
          <span className="text-xs text-muted-foreground w-10 text-right">{settings.sermonMaxLatencySecs}s</span>
        </div>
      </SettingItem>

      <SettingItem id="sermon-stability" htmlFor="sermon-stability-slider">
        <div className="flex items-center gap-3">
          <input
            id="sermon-stability-slider"
            type="range"
            min={300}
            max={5000}
            step={100}
            value={settings.sermonStabilityMs}
            onChange={(e) => onUpdate({ sermonStabilityMs: Number(e.target.value) })}
            className="flex-1 accent-primary"
          />
          <span className="text-xs text-muted-foreground w-14 text-right">{settings.sermonStabilityMs} ms</span>
        </div>
      </SettingItem>

      <p className="text-xs text-muted-foreground italic">
        While recording, Sermon mode always uses voice-activity detection with no chunk overlap
        (ignoring the Live mode audio settings), so chunk boundaries fall between words.
      </p>
    </div>
  );
}

// ── Scripture quotes ──

export function SermonScripturePage({ settings, onUpdate }: SettingsPageProps) {
  return (
    <div className="space-y-6">
      <PageHeader pageId="sermon-scripture" />

      <SettingItem id="scripture-enabled" layout="row" htmlFor="scripture-enabled-switch">
        <Switch
          id="scripture-enabled-switch"
          checked={settings.sermonScriptureEnabled}
          onCheckedChange={(checked) => onUpdate({ sermonScriptureEnabled: checked })}
          data-testid="switch-scripture-enabled"
        />
      </SettingItem>

      {/* Always visible: the glossary's translation instructions use the version too. */}
      <SettingItem id="bible-version">
        <Select
          value={settings.sermonBibleVersion}
          onValueChange={(v) => onUpdate({ sermonBibleVersion: v as SermonBibleVersion })}
        >
          <SelectTrigger className="h-8 text-xs" data-testid="select-bible-version">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="KJV">KJV</SelectItem>
            <SelectItem value="ESV">ESV</SelectItem>
            <SelectItem value="LSB">LSB</SelectItem>
            <SelectItem value="NASB">NASB</SelectItem>
            <SelectItem value="NKJV">NKJV</SelectItem>
          </SelectContent>
        </Select>
      </SettingItem>

      {settings.sermonScriptureEnabled && (
        <>
          <SettingItem id="scripture-fallback">
            <Select
              value={settings.sermonScriptureFallback}
              onValueChange={(v) => onUpdate({ sermonScriptureFallback: v as SermonScriptureFallback })}
            >
              <SelectTrigger className="h-8 text-xs" data-testid="select-scripture-fallback">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="kjv">Fall back to King James Version (recommended)</SelectItem>
                <SelectItem value="none">Do not substitute — translate like normal speech</SelectItem>
              </SelectContent>
            </Select>
          </SettingItem>

          <Note>The ESV API key (only needed if the local ESV text is not built) is under General › API keys.</Note>

          <p className="text-xs text-muted-foreground italic">
            Scripture quotations marked ESV are from the ESV® Bible (The Holy Bible, English
            Standard Version®), copyright © 2001 by Crossway, a publishing ministry of Good
            News Publishers. Used by permission. All rights reserved. Legacy Standard Bible
            (LSB) © 2021 by The Lockman Foundation. The King James Version is public domain.
          </p>
        </>
      )}
    </div>
  );
}

// ── Listeners ──

export function SermonListenersPage({ isOpen }: SettingsPageProps) {
  // The page is only mounted while selected, so the lookup runs only when it is visible.
  const lan = useLanAddress(isOpen);
  return (
    <div className="space-y-6">
      <PageHeader pageId="sermon-listeners" />
      <SettingItem id="listener-address">
        {lan.error && <p className="text-xs text-destructive">Could not look up the address.</p>}
        {!lan.error && !lan.loaded && <Note>Looking up address…</Note>}
        {lan.loaded && lan.urls.length === 0 && (
          <Warning>No network address found — this computer doesn't seem to be on a network.</Warning>
        )}
        {lan.urls.length > 0 && <CopyableUrlList urls={lan.urls} />}
        <Button type="button" variant="outline" size="sm" onClick={lan.refresh}>
          Refresh
        </Button>
      </SettingItem>
      <Note>Include the <code>http://</code> and the port when typing it into a phone.</Note>
    </div>
  );
}

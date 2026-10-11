import { useState, useEffect, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { AppSettings } from '@/hooks/useSettings';
import { SettingItem } from './primitives';

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

/** The file-based sermon glossary: on/off switch, file pickers, load status. */
export default function GlossaryPanel({ settings, onUpdate, isOpen }: GlossaryPanelProps) {
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
      setFetchError('Could not load the glossary status.');
    }
  }, [settings.sermonGlossaryCsv, settings.sermonDisambiguationPrompt]);

  useEffect(() => {
    if (isOpen && settings.sermonGlossaryEnabled) fetchStatus();
  }, [isOpen, settings.sermonGlossaryEnabled, fetchStatus]);

  async function handleReload() {
    setIsReloading(true);
    try {
      const res = await fetch('/api/sermon/glossary/reload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: settings.sermonGlossaryCsv, prompt: settings.sermonDisambiguationPrompt }),
      });
      if (res.ok) { setStatus(await res.json()); setFetchError(''); }
      else setFetchError('Reload failed.');
    } catch {
      setFetchError('Reload failed.');
    } finally {
      setIsReloading(false);
    }
  }

  return (
    <div className="space-y-4">
      <SettingItem id="glossary-enabled" layout="row" htmlFor="glossary-enabled-switch">
        <Switch
          id="glossary-enabled-switch"
          checked={settings.sermonGlossaryEnabled}
          onCheckedChange={(checked) => onUpdate({ sermonGlossaryEnabled: checked })}
          data-testid="switch-glossary-enabled"
        />
      </SettingItem>

      {settings.sermonGlossaryEnabled && (
        <>
          <SettingItem id="glossary-csv">
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
          </SettingItem>

          <SettingItem id="glossary-prompt">
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
          </SettingItem>

          <SettingItem id="deity-capitals" layout="row" htmlFor="glossary-deity-capitals">
            <Switch
              id="glossary-deity-capitals"
              checked={settings.sermonDeityCapitals}
              onCheckedChange={(checked) => onUpdate({ sermonDeityCapitals: checked })}
            />
          </SettingItem>

          <SettingItem id="glossary-warnings" layout="row" htmlFor="glossary-warnings-switch">
            <Switch
              id="glossary-warnings-switch"
              checked={settings.sermonGlossaryWarnings}
              onCheckedChange={(checked) => onUpdate({ sermonGlossaryWarnings: checked })}
            />
          </SettingItem>

          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 space-y-1.5">
            {fetchError && <p className="text-xs text-destructive">{fetchError}</p>}
            {!fetchError && !status && <p className="text-xs text-muted-foreground">Loading status…</p>}
            {status && !status.loaded && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                No glossary loaded — translating without one.
                {status.errors[0] ? ` (${status.errors[0]})` : ''}
              </p>
            )}
            {status && status.loaded && (
              <>
                <p className="text-xs text-muted-foreground">
                  {status.csv.fixedRows} fixed terms · {status.csv.contextRows} context-dependent
                  {status.csv.repairedRows > 0 ? ` · ${status.csv.repairedRows} rows repaired` : ''}
                  {' · ~'}{status.estimatedTokens} tokens
                </p>
                {status.stale && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    The file changed on disk since it was last loaded — reload recommended.
                  </p>
                )}
                {status.warnings.length > 0 && (
                  <div>
                    <button
                      type="button"
                      className="text-xs text-amber-600 dark:text-amber-400 underline decoration-dotted"
                      onClick={() => setShowWarnings((v) => !v)}
                    >
                      ⚠ {status.warnings.length} {status.warnings.length === 1 ? 'inconsistency' : 'inconsistencies'} {showWarnings ? '▴' : '▾'}
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
              {isReloading ? 'Reloading…' : 'Reload files'}
            </Button>
          </div>

          <p className="text-xs text-muted-foreground italic">
            Files must be in the server's glossary folder (<code>data/</code> by default, set with
            the <code>GLOSSARY_DIR</code> environment variable). Arbitrary paths are not accepted, so
            the server cannot be made to read other files.
          </p>
        </>
      )}
    </div>
  );
}

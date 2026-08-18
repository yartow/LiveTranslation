// Contents of SermonToolbar's "Luisteraars" popover — CLAUDE.md "Listener
// mode". Shows the address(es) to read out to the congregation so their
// phones can reach /listen. Split out from SermonToolbar.tsx so the
// address-fetch/copy logic doesn't clutter the toolbar's layout code, same
// rationale as GlossaryPanel being its own file inside SettingsDialog.tsx.

import { useEffect, useState } from 'react';
import { Check, Copy } from 'lucide-react';

interface LanAddressResponse {
  addresses: string[];
  port: string;
}

interface ListenerAddressPanelProps {
  /** Only fetch while the popover is actually open — the MBP's LAN IP doesn't change while you're looking at it, so there's no reason to poll. */
  open: boolean;
  listenerCount: number;
}

export default function ListenerAddressPanel({ open, listenerCount }: ListenerAddressPanelProps) {
  const [data, setData] = useState<LanAddressResponse | null>(null);
  const [error, setError] = useState(false);
  const [copiedUrl, setCopiedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setError(false);
    fetch('/api/lan-address')
      .then(res => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((json: LanAddressResponse) => { if (!cancelled) setData(json); })
      .catch(() => { if (!cancelled) setError(true); });
    return () => { cancelled = true; };
  }, [open]);

  const urls = data ? data.addresses.map(addr => `http://${addr}:${data.port}`) : [];

  const copy = (url: string) => {
    navigator.clipboard?.writeText(url).then(() => {
      setCopiedUrl(url);
      setTimeout(() => setCopiedUrl(prev => (prev === url ? null : prev)), 2000);
    });
  };

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">Adres voor luisteraars</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Geef dit adres aan luisteraars op hetzelfde wifi-netwerk — ze zien alleen de Engelse vertaling.
        </p>
      </div>

      {error && (
        <p className="text-xs text-destructive">Kon het adres niet ophalen.</p>
      )}

      {!error && urls.length === 0 && (
        <p className="text-xs text-muted-foreground">Adres ophalen…</p>
      )}

      {urls.length > 0 && (
        <ul className="space-y-1.5">
          {urls.map(url => (
            <li key={url} className="flex items-center gap-2">
              <code className="flex-1 min-w-0 truncate text-xs bg-muted rounded px-2 py-1">{url}</code>
              <button
                onClick={() => copy(url)}
                aria-label={`Kopieer ${url}`}
                className="shrink-0 text-muted-foreground hover:text-foreground p-1.5 rounded-md transition-colors"
              >
                {copiedUrl === url ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="text-xs text-muted-foreground border-t border-border pt-2">
        {listenerCount === 0
          ? 'Nog geen luisteraars verbonden.'
          : `${listenerCount} ${listenerCount === 1 ? 'luisteraar' : 'luisteraars'} verbonden.`}
      </p>
    </div>
  );
}

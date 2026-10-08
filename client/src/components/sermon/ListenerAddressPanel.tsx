// Contents of SermonToolbar's "Luisteraars" popover — CLAUDE.md "Listener
// mode". Shows the address(es) to read out to the congregation so their
// phones can reach /listen. Split out from SermonToolbar.tsx so the
// address-fetch/copy logic doesn't clutter the toolbar's layout code, same
// rationale as GlossaryPanel being its own file inside SettingsDialog.tsx.

import CopyableUrlList from '@/components/CopyableUrlList';
import { useLanAddress } from '@/hooks/useLanAddress';

interface ListenerAddressPanelProps {
  /** Only fetch while the popover is actually open — the MBP's LAN IP doesn't change while you're looking at it, so there's no reason to poll. */
  open: boolean;
  listenerCount: number;
}

export default function ListenerAddressPanel({ open, listenerCount }: ListenerAddressPanelProps) {
  const { urls, error } = useLanAddress(open);

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

      {urls.length > 0 && <CopyableUrlList urls={urls} />}

      <p className="text-xs text-muted-foreground border-t border-border pt-2">
        {listenerCount === 0
          ? 'Nog geen luisteraars verbonden.'
          : `${listenerCount} ${listenerCount === 1 ? 'luisteraar' : 'luisteraars'} verbonden.`}
      </p>
    </div>
  );
}

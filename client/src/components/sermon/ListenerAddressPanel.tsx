// Contents of SermonToolbar's "Luisteraars" popover — CLAUDE.md "Listener
// mode". Shows the address(es) to read out to the congregation so their
// phones can reach /listen. Split out from SermonToolbar.tsx so the
// address-fetch/copy logic doesn't clutter the toolbar's layout code, same
// rationale as GlossaryPanel being its own file inside the settings dialog.

import CopyableUrlList from '@/components/CopyableUrlList';
import { useLanAddress } from '@/hooks/useLanAddress';
import { EXTRA_LISTENER_LANGUAGES, LISTENER_LANGUAGE_INFO } from '@/lib/listener-languages';

interface ListenerAddressPanelProps {
  /** Only fetch while the popover is actually open — the MBP's LAN IP doesn't change while you're looking at it, so there's no reason to poll. */
  open: boolean;
  listenerCount: number;
  /** Phones per language, as the hub counts them — shown when anyone reads something other than English. */
  listenersByLang?: Record<string, number>;
}

export default function ListenerAddressPanel({ open, listenerCount, listenersByLang }: ListenerAddressPanelProps) {
  const { urls, error } = useLanAddress(open);
  const otherLanguages = EXTRA_LISTENER_LANGUAGES
    .filter(lang => (listenersByLang?.[lang] ?? 0) > 0)
    .map(lang => `${LISTENER_LANGUAGE_INFO[lang].name} ${listenersByLang![lang]}`);

  return (
    <div className="space-y-3">
      <div>
        <p className="text-sm font-medium">Listener address</p>
        <p className="text-xs text-muted-foreground mt-0.5">
          Give this address to listeners on the same Wi-Fi network — they see the translation, never the Dutch.
        </p>
      </div>

      {error && (
        <p className="text-xs text-destructive">Could not look up the address.</p>
      )}

      {!error && urls.length === 0 && (
        <p className="text-xs text-muted-foreground">Looking up address…</p>
      )}

      {urls.length > 0 && <CopyableUrlList urls={urls} />}

      <p className="text-xs text-muted-foreground border-t border-border pt-2">
        {listenerCount === 0
          ? 'No listeners connected yet.'
          : `${listenerCount} ${listenerCount === 1 ? 'listener' : 'listeners'} connected.`}
        {otherLanguages.length > 0 && ` Also reading: ${otherLanguages.join(', ')}.`}
      </p>
    </div>
  );
}

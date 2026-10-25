import { History } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface RestoreBannerProps {
  rows: number;
  savedAt: number;
  onRestore: () => void;
  onDiscard: () => void;
}

// Offered after a reload or crash while the page is still empty: the segments live only in the page,
// and the autosave (session-db.ts) is the one copy left.
export default function RestoreBanner({ rows, savedAt, onRestore, onDiscard }: RestoreBannerProps) {
  const time = new Date(savedAt).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 border-b border-border bg-blue-500/10" role="status" data-testid="restore-banner">
      <History className="h-4 w-4 shrink-0 text-blue-600 dark:text-blue-400" aria-hidden />
      <p className="flex-1 min-w-[12rem] text-sm">
        A previous session was saved automatically: <strong>{rows} {rows === 1 ? 'row' : 'rows'}</strong>, last saved {time}.
      </p>
      <Button size="sm" onClick={onRestore} data-testid="restore-session">Restore</Button>
      <Button size="sm" variant="outline" onClick={onDiscard} data-testid="discard-session">Discard</Button>
    </div>
  );
}

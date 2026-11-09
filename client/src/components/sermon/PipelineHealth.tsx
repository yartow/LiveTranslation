import { useEffect, useState } from 'react';
import { Activity } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { PipelineStats, PipelineSnapshot, HealthLevel } from '@/lib/sermon/pipeline-stats';

const DOT: Record<HealthLevel, string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  bad: 'bg-red-500 animate-pulse motion-reduce:animate-none',
};

const secs = (ms: number | null) => (ms === null ? '—' : `${(ms / 1000).toFixed(1)} s`);

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular-nums font-medium">{value}</span>
    </div>
  );
}

// Polls the stats once a second (the oldest waiting chunk ages without any event to react to).
// Only this small component re-renders.
export default function PipelineHealth({ stats }: { stats: PipelineStats }) {
  const [snap, setSnap] = useState<PipelineSnapshot>(() => stats.snapshot(Date.now()));
  useEffect(() => {
    const timer = setInterval(() => setSnap(stats.snapshot(Date.now())), 1000);
    return () => clearInterval(timer);
  }, [stats]);

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-accent"
          title={snap.reason || 'Pipeline health: transcription and translation delays'}
          data-testid="button-pipeline-health"
        >
          <Activity className="h-3.5 w-3.5" />
          Pipeline
          <span className={`h-2 w-2 rounded-full ${DOT[snap.level]}`} aria-label={`Pipeline ${snap.level === 'ok' ? 'healthy' : snap.level === 'warn' ? 'slow' : 'in trouble'}`} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 space-y-2" data-testid="pipeline-health-panel">
        {snap.reason && <p className="text-xs font-medium text-amber-700 dark:text-amber-400">{snap.reason}</p>}
        <p className="text-[11px] uppercase tracking-wide text-muted-foreground">Transcription</p>
        <Row label="Delay of the last chunk" value={secs(snap.chunkDelayLastMs)} />
        <Row label="Typical delay (median)" value={secs(snap.chunkDelayMedianMs)} />
        <Row label="Chunks waiting" value={`${snap.backlog}${snap.backlog ? ` (oldest ${secs(snap.oldestPendingMs)})` : ''}`} />
        <Row label="Reconnects" value={String(snap.reconnects)} />
        <p className="pt-1 text-[11px] uppercase tracking-wide text-muted-foreground">Translation</p>
        <Row label="Last call" value={secs(snap.translateLastMs)} />
        <Row label="Typical (median)" value={secs(snap.translateMedianMs)} />
        <Row label="Errors, last 10 min" value={`${snap.translateErrors}${snap.rateLimited ? ` (${snap.rateLimited} rate-limited)` : ''}`} />
      </PopoverContent>
    </Popover>
  );
}

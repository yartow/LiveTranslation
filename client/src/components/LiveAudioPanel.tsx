import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

interface LiveAudioPanelProps {
  audioLevel: number;
  normalizationGain: number;
  vadSilenceThresholdMs: number;
  useVADChunking: boolean;
  onGainChange: (gain: number) => void;
  onVADThresholdChange: (ms: number) => void;
  onNormalizeClick: () => void;
}

// Smoothed VU meter: exponential moving average
const SMOOTH_ALPHA = 0.2;

export default function LiveAudioPanel({
  audioLevel,
  normalizationGain,
  vadSilenceThresholdMs,
  useVADChunking,
  onGainChange,
  onVADThresholdChange,
  onNormalizeClick,
}: LiveAudioPanelProps) {
  const [smoothed, setSmoothed] = useState(0);
  const smoothedRef = useRef(0);

  useEffect(() => {
    const next = smoothedRef.current + SMOOTH_ALPHA * (audioLevel - smoothedRef.current);
    smoothedRef.current = next;
    setSmoothed(next);
  }, [audioLevel]);

  const barPercent = Math.min(100, smoothed * 600);
  const dbApprox = smoothed > 0 ? Math.round(20 * Math.log10(smoothed)) : -Infinity;
  const dbLabel = isFinite(dbApprox) ? `${dbApprox} dB` : '–∞ dB';

  return (
    <div className="flex flex-wrap items-center gap-4 px-4 py-2 bg-muted/60 border-t border-border text-sm">
      {/* VU meter */}
      <div className="flex items-center gap-2 min-w-[160px] flex-1">
        <span className="text-xs text-muted-foreground whitespace-nowrap">Level</span>
        <div className="flex-1 h-3 bg-background rounded-full overflow-hidden border border-border">
          <div
            className={`h-full rounded-full transition-all duration-75 ${
              barPercent > 80 ? 'bg-destructive' : barPercent > 50 ? 'bg-yellow-400' : 'bg-green-500'
            }`}
            style={{ width: `${barPercent}%` }}
          />
        </div>
        <span className="text-xs text-muted-foreground w-14 text-right tabular-nums">{dbLabel}</span>
      </div>

      {/* Gain slider */}
      <div className="flex items-center gap-2">
        <Label htmlFor="live-gain" className="text-xs whitespace-nowrap">Gain</Label>
        <input
          id="live-gain"
          type="range"
          min={0.1}
          max={10}
          step={0.1}
          value={normalizationGain}
          onChange={(e) => onGainChange(Number(e.target.value))}
          className="w-24 accent-primary"
        />
        <span className="text-xs text-muted-foreground w-10 tabular-nums">
          {normalizationGain.toFixed(1)}×
        </span>
      </div>

      {/* VAD threshold */}
      {useVADChunking && (
        <div className="flex items-center gap-2">
          <Label htmlFor="live-vad" className="text-xs whitespace-nowrap">VAD silence</Label>
          <input
            id="live-vad"
            type="range"
            min={200}
            max={2000}
            step={100}
            value={vadSilenceThresholdMs}
            onChange={(e) => onVADThresholdChange(Number(e.target.value))}
            className="w-24 accent-primary"
          />
          <span className="text-xs text-muted-foreground w-14 tabular-nums">
            {vadSilenceThresholdMs} ms
          </span>
        </div>
      )}

      {/* Normalize button */}
      <Button variant="outline" size="sm" className="shrink-0" onClick={onNormalizeClick}>
        Normalize…
      </Button>
    </div>
  );
}

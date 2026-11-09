import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, ChevronDown, Mic, Usb } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { useMacInputVolume } from '@/hooks/useMacInputVolume';
import { isBuiltInMic, type MicDevice } from '@/hooks/useMicDevices';
import { dbToFraction, levelZone, type LevelStore, type LevelZone, type SpeechVerdict } from '@/lib/sermon/audio-level';
import type { PipelineStats } from '@/lib/sermon/pipeline-stats';
import PipelineHealth from './PipelineHealth';

const ZONE_BAR: Record<LevelZone, string> = {
  silent: 'bg-muted-foreground/30',
  low: 'bg-sky-400',
  good: 'bg-green-500',
  hot: 'bg-yellow-400',
  clipping: 'bg-destructive',
};

function LevelMeter({ store }: { store: LevelStore }) {
  const { db, clipping } = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const zone = levelZone(db, clipping);
  const label = zone === 'silent' ? '−∞ dB' : `${Math.round(db)} dB`;
  return (
    <div className="flex items-center gap-2 min-w-[150px] flex-1" data-testid="audio-level-meter">
      <span className="text-xs text-muted-foreground whitespace-nowrap">Level</span>
      <div
        className="relative flex-1 h-2.5 bg-muted rounded-full overflow-hidden"
        role="meter"
        aria-label="Microphone level"
        aria-valuemin={-60}
        aria-valuemax={0}
        aria-valuenow={Math.round(db)}
      >
        <div className={`h-full rounded-full transition-[width] duration-75 ${ZONE_BAR[zone]}`} style={{ width: `${dbToFraction(db) * 100}%` }} />
      </div>
      <span className={`text-xs tabular-nums w-14 text-right ${clipping ? 'text-destructive font-semibold' : 'text-muted-foreground'}`}>
        {clipping ? 'CLIPPING' : label}
      </span>
    </div>
  );
}

/** No sound at all for this long while recording (a receiver whose transmitter is off) reads as a dead microphone. */
const NO_SOUND_MS = 20_000;

// What to tell the operator about the level, in words (colour alone is not enough on a projector
// or for colour-blind eyes). `title` says what it was measured on and what to do.
const VERDICT_CHIP: Record<SpeechVerdict, { text: string; title: string; className: string }> = {
  'no-speech': {
    text: 'No speech heard — check the microphone',
    title: 'Only background noise in the last 10 s. If someone is speaking: is the transmitter on, the right input selected, and the Input volume up?',
    className: 'text-amber-600 dark:text-amber-400',
  },
  'too-quiet': {
    text: 'Too quiet — raise the microphone level',
    title: 'Speech peaks are below -20 dBFS after gain, which makes Whisper guess and invent text. Raise Input volume (or the transmitter/receiver gain).',
    className: 'text-amber-600 dark:text-amber-400',
  },
  ok: {
    text: 'Level good',
    title: 'Speech peaks sit in the range Whisper handles best (-20 to -3 dBFS after gain).',
    className: 'text-green-600 dark:text-green-400',
  },
  'too-loud': {
    text: 'Too loud — lower the microphone level',
    title: 'Speech peaks are above -3 dBFS after gain, or the input is clipping. Lower Input volume (or the transmitter/receiver gain).',
    className: 'text-destructive font-semibold',
  },
};

/** "0.5" not "0.50", "2" not "2.0". */
const formatGain = (gain: number) => String(Math.round(gain * 100) / 100);

interface AudioBarProps {
  levelStore: LevelStore;
  pipelineStats: PipelineStats;
  isRecording: boolean;
  /** Listening is paused: silence is expected then. */
  isPaused: boolean;
  /** Settings.micDeviceId — '' = system default. */
  micDeviceId: string;
  onChangeMicDeviceId: (deviceId: string) => void;
  devices: MicDevice[];
  /** Name of the macOS default input ("" if unknown). */
  defaultLabel: string;
  hasLabels: boolean;
  /** Device the running recording really opened; null when not recording. */
  activeLabel: string | null;
  /** Normalization gain the recording applies (settings.audioNormalizationGain at its start). */
  gain: number;
}

// Second toolbar row for sermon mode: which microphone is in use (the thing that
// went wrong on the day a service was recorded from the wrong input), how loud
// the signal is, and the macOS input volume as a number.
export default function AudioBar({
  levelStore, pipelineStats, isRecording, isPaused, micDeviceId, onChangeMicDeviceId, devices, defaultLabel, hasLabels, activeLabel, gain,
}: AudioBarProps) {
  const [open, setOpen] = useState(false);
  const { state: volume, setVolume } = useMacInputVolume();

  // Polled once a second rather than derived from the level snapshot, which only changes
  // when the meter visibly moves — and a dead microphone is exactly a meter that never moves.
  const listening = isRecording && !isPaused;
  const [noSound, setNoSound] = useState(false);
  useEffect(() => {
    setNoSound(false);
    if (!listening) return;
    levelStore.restartSilenceClock(); // also restarts after a switch to another microphone (activeLabel)
    const timer = setInterval(() => setNoSound(levelStore.silentForMs() >= NO_SOUND_MS), 1000);
    return () => clearInterval(timer);
  }, [listening, activeLabel, levelStore]);

  // Same cadence, same reason. Declared after the effect above: that one restarts the store's
  // measuring window (also on a microphone switch), this one then starts from "still listening".
  const [verdict, setVerdict] = useState<SpeechVerdict | null>(null);
  useEffect(() => {
    setVerdict(null);
    if (!listening) return;
    const timer = setInterval(() => setVerdict(levelStore.speechVerdict()), 1000);
    return () => clearInterval(timer);
  }, [listening, activeLabel, levelStore]);

  const selected = micDeviceId ? devices.find(d => d.deviceId === micDeviceId) : undefined;
  // A saved device that isn't plugged in right now: recording falls back to the system default.
  const selectedMissing = !!micDeviceId && devices.length > 0 && !selected;
  const shownLabel = (isRecording && activeLabel)
    ? activeLabel
    : selected?.label || defaultLabel || (hasLabels ? 'System default' : 'Microphone (allow access to see its name)');
  // Without microphone permission the browser gives no names, so there is nothing to classify.
  const nameKnown = !!((isRecording && activeLabel) || selected || defaultLabel);
  const builtIn = nameKnown && isBuiltInMic(shownLabel);
  // The slider is the macOS DEFAULT input; if recording from another device it doesn't apply to it.
  const volumeAppliesElsewhere = !!selected && !!defaultLabel && selected.label !== defaultLabel;

  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-3 py-1.5 border-b border-border bg-muted/30" data-testid="audio-bar">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="inline-flex items-center gap-1.5 max-w-full rounded-md border border-input bg-background px-2 py-1 text-xs hover:bg-accent"
            data-testid="button-mic-picker"
            title="Choose microphone"
          >
            {nameKnown && !builtIn ? <Usb className="h-3.5 w-3.5 shrink-0" /> : <Mic className="h-3.5 w-3.5 shrink-0" />}
            <span className="truncate max-w-[18rem]" data-testid="mic-active-label">{shownLabel}</span>
            {nameKnown && (
              <span className={`shrink-0 rounded px-1 text-[10px] font-medium ${builtIn ? 'bg-muted text-muted-foreground' : 'bg-blue-500/15 text-blue-600 dark:text-blue-400'}`}>
                {builtIn ? 'Built-in' : 'External'}
              </span>
            )}
            {isRecording && <span className="shrink-0 h-1.5 w-1.5 rounded-full bg-red-500 animate-pulse" aria-label="Recording from this microphone" />}
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-80 p-1">
          <MicOption
            checked={!micDeviceId}
            label={`System default${defaultLabel ? ` (${defaultLabel})` : ''}`}
            onSelect={() => { onChangeMicDeviceId(''); setOpen(false); }}
          />
          {devices.map(d => (
            <MicOption
              key={d.deviceId}
              checked={d.deviceId === micDeviceId}
              label={d.label}
              badge={isBuiltInMic(d.label) ? 'Built-in' : 'External'}
              onSelect={() => { onChangeMicDeviceId(d.deviceId); setOpen(false); }}
            />
          ))}
          {!hasLabels && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">Microphone names appear after you have started a recording once and allowed access.</p>
          )}
        </PopoverContent>
      </Popover>
      {selectedMissing && (
        <span className="text-xs text-amber-600 dark:text-amber-400" data-testid="mic-missing-warning">
          Selected microphone not found — the system default is used.
        </span>
      )}

      {noSound && (
        <span className="text-xs font-medium text-amber-600 dark:text-amber-400" role="status" data-testid="mic-no-sound">
          No sound from this microphone
        </span>
      )}

      <LevelMeter store={levelStore} />

      {/* "No sound at all" above is the more specific message, so it replaces the verdict. */}
      {listening && verdict && !noSound && (
        <span
          className={`text-xs font-medium ${VERDICT_CHIP[verdict].className}`}
          role="status"
          title={VERDICT_CHIP[verdict].title}
          data-testid="level-verdict"
        >
          {VERDICT_CHIP[verdict].text}
        </span>
      )}
      {Math.abs(gain - 1) > 0.05 && (
        <span
          className={`text-xs ${gain < 1 ? 'font-medium text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}
          title={`Settings → Microphone → Normalization gain. ${gain < 1 ? 'Below 1× this makes the signal Whisper hears quieter than the meter shows.' : 'Amplifies the signal before Whisper.'} Applies from the next recording.`}
          data-testid="gain-chip"
        >
          Gain {formatGain(gain)}×
        </span>
      )}

      <PipelineHealth stats={pipelineStats} />

      <div className="flex items-center gap-2" data-testid="mac-input-volume">
        <label htmlFor="mac-input-volume-slider" className="text-xs text-muted-foreground whitespace-nowrap">Input volume</label>
        {volume.status === 'ready' ? (
          <>
            <input
              id="mac-input-volume-slider"
              type="range"
              min={0}
              max={100}
              step={1}
              value={volume.volume}
              onChange={(e) => setVolume(Number(e.target.value))}
              className="w-32 accent-primary"
              aria-valuetext={`${volume.volume} percent`}
              title={volumeAppliesElsewhere ? `Controls the macOS default input (${defaultLabel}), not the selected microphone` : 'macOS system input volume'}
            />
            <span className="text-xs tabular-nums w-9 text-right font-medium">{volume.volume}%</span>
            {volumeAppliesElsewhere && <span className="text-[10px] text-amber-600 dark:text-amber-400">default input</span>}
          </>
        ) : (
          <span className="text-xs text-muted-foreground" title={volume.status === 'unsupported' ? volume.reason : undefined}>
            {volume.status === 'loading' ? '…' : 'not adjustable'}
          </span>
        )}
      </div>
    </div>
  );
}

function MicOption({ checked, label, badge, onSelect }: { checked: boolean; label: string; badge?: string; onSelect: () => void }) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent"
      data-testid="mic-option"
    >
      <Check className={`h-3.5 w-3.5 shrink-0 ${checked ? 'opacity-100' : 'opacity-0'}`} />
      <span className="flex-1 truncate">{label}</span>
      {badge && <span className="shrink-0 text-[10px] text-muted-foreground">{badge}</span>}
    </button>
  );
}

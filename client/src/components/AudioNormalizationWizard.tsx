import { useState, useRef, useCallback } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';

interface AudioNormalizationWizardProps {
  isOpen: boolean;
  currentGain: number;
  onClose: () => void;
  onApply: (gain: number) => void;
}

type Step = 'idle' | 'recording' | 'done' | 'error';

const RECORD_DURATION_S = 5;
const TARGET_RMS = 0.15; // −16 dBFS

export default function AudioNormalizationWizard({
  isOpen,
  currentGain,
  onClose,
  onApply,
}: AudioNormalizationWizardProps) {
  const [step, setStep] = useState<Step>('idle');
  const [countdown, setCountdown] = useState(RECORD_DURATION_S);
  const [measuredRms, setMeasuredRms] = useState<number | null>(null);
  const [suggestedGain, setSuggestedGain] = useState<number | null>(null);
  const [previewGain, setPreviewGain] = useState<number>(1.0);
  const [errorMsg, setErrorMsg] = useState('');

  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const frameCountRef = useRef(0);
  const sumSqRef = useRef(0);

  const cleanup = useCallback(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (ctxRef.current) { ctxRef.current.close().catch(() => {}); ctxRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
  }, []);

  async function startRecording() {
    setStep('recording');
    setCountdown(RECORD_DURATION_S);
    frameCountRef.current = 0;
    sumSqRef.current = 0;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;

      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext as typeof AudioContext;
      const ctx = new AudioCtx();
      ctxRef.current = ctx;

      const source = ctx.createMediaStreamSource(stream);
      const processor = ctx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        const data = e.inputBuffer.getChannelData(0);
        for (let i = 0; i < data.length; i++) sumSqRef.current += data[i] * data[i];
        frameCountRef.current += data.length;
      };
      source.connect(processor);
      processor.connect(ctx.destination);

      let elapsed = 0;
      timerRef.current = setInterval(() => {
        elapsed++;
        setCountdown(RECORD_DURATION_S - elapsed);
        if (elapsed >= RECORD_DURATION_S) {
          clearInterval(timerRef.current!);
          timerRef.current = null;
          const rms = frameCountRef.current > 0
            ? Math.sqrt(sumSqRef.current / frameCountRef.current)
            : 0;
          const suggested = rms > 0
            ? Math.max(0.1, Math.min(10, TARGET_RMS / rms))
            : 1.0;
          cleanup();
          setMeasuredRms(rms);
          setSuggestedGain(suggested);
          setPreviewGain(suggested);
          setStep('done');
        }
      }, 1000);
    } catch (err) {
      cleanup();
      setErrorMsg(err instanceof Error ? err.message : 'Could not access microphone');
      setStep('error');
    }
  }

  function handleClose() {
    cleanup();
    setStep('idle');
    setMeasuredRms(null);
    setSuggestedGain(null);
    setErrorMsg('');
    onClose();
  }

  function handleApply() {
    onApply(previewGain);
    handleClose();
  }

  const dbApprox = measuredRms && measuredRms > 0
    ? Math.round(20 * Math.log10(measuredRms))
    : null;

  return (
    <Dialog open={isOpen} onOpenChange={handleClose}>
      <DialogContent className="w-full max-w-sm">
        <DialogHeader>
          <DialogTitle>Normalize Audio</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {step === 'idle' && (
            <>
              <p className="text-sm text-muted-foreground">
                Speak at your normal volume for {RECORD_DURATION_S} seconds. The wizard will
                measure your microphone level and suggest a gain to target −16 dBFS.
              </p>
              <p className="text-xs text-muted-foreground">
                Current gain: <strong>{currentGain.toFixed(1)}×</strong>
              </p>
              <Button className="w-full" onClick={startRecording}>
                Start {RECORD_DURATION_S}-second recording
              </Button>
            </>
          )}

          {step === 'recording' && (
            <div className="text-center space-y-3">
              <p className="text-lg font-semibold text-foreground">Recording…</p>
              <p className="text-4xl font-mono font-bold">{countdown}</p>
              <p className="text-sm text-muted-foreground">Speak at your normal volume</p>
            </div>
          )}

          {step === 'done' && (
            <>
              <div className="space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Measured level</span>
                  <span>{dbApprox != null ? `${dbApprox} dBFS` : '—'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-muted-foreground">Suggested gain</span>
                  <span className="font-medium">{suggestedGain?.toFixed(1)}×</span>
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="preview-gain" className="text-xs font-medium">
                  Adjust gain
                </Label>
                <div className="flex items-center gap-3">
                  <input
                    id="preview-gain"
                    type="range"
                    min={0.1}
                    max={10}
                    step={0.1}
                    value={previewGain}
                    onChange={(e) => setPreviewGain(Number(e.target.value))}
                    className="flex-1 accent-primary"
                  />
                  <span className="text-xs text-muted-foreground w-10 text-right">
                    {previewGain.toFixed(1)}×
                  </span>
                </div>
              </div>
            </>
          )}

          {step === 'error' && (
            <p className="text-sm text-destructive">{errorMsg}</p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={handleClose}>
            {step === 'done' ? 'Discard' : 'Cancel'}
          </Button>
          {step === 'done' && (
            <Button onClick={handleApply}>
              Apply {previewGain.toFixed(1)}×
            </Button>
          )}
          {step === 'error' && (
            <Button onClick={() => setStep('idle')}>Try again</Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

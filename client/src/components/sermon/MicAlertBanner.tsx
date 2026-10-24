import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';

/** The microphone being recorded from stopped working and the recording moved on (see SermonMode's micAlert). */
export interface MicAlert {
  /** 'stopped': the device disappeared (unplugged, battery empty). 'default-changed': macOS moved its default input while recording on "System default". */
  reason: 'stopped' | 'default-changed';
  /** Name of the microphone that stopped. */
  from: string;
  /** Name of the microphone the recording moved to; null when no other microphone could be opened. */
  to: string | null;
  /** Its deviceId ('' = it was the system default), so it can be switched back to. */
  fromDeviceId: string;
}

interface MicAlertBannerProps {
  alert: MicAlert;
  /** The microphone that stopped is listed again (plugged back in / switched back on). */
  canSwitchBack: boolean;
  onSwitchBack: () => void;
  onAcknowledge: () => void;
}

// Deliberately loud and deliberately sticky: nobody is looking at the audio bar in the middle of a
// service. It stays, flickering, until the operator confirms with the button — no timeout, and no
// other event clears it. Motion-reduce users get the same red bar without the flicker.
export default function MicAlertBanner({ alert, canSwitchBack, onSwitchBack, onAcknowledge }: MicAlertBannerProps) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3 py-2 bg-red-600 text-white animate-pulse motion-reduce:animate-none"
      data-testid="mic-alert"
    >
      <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden />
      <p className="flex-1 min-w-[12rem] text-sm font-semibold">
        {alert.reason === 'default-changed'
          ? <>The system microphone changed from “{alert.from}”. Now recording from “{alert.to}”.</>
          : alert.to
            ? <>Microphone “{alert.from}” stopped. Now recording from “{alert.to}”.</>
            : <>Microphone “{alert.from}” stopped. No microphone available — nothing is being transcribed.</>}
      </p>
      {canSwitchBack && (
        <Button size="sm" variant="secondary" onClick={onSwitchBack} data-testid="mic-alert-switch-back">
          Switch back to “{alert.from}”
        </Button>
      )}
      <Button size="sm" variant="secondary" onClick={onAcknowledge} data-testid="mic-alert-ack">
        OK, I’ve seen this
      </Button>
    </div>
  );
}

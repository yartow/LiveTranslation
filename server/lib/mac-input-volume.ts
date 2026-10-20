// Reads/sets the macOS system input volume (System Settings → Sound → Input)
// through osascript. A browser can't do this: getUserMedia exposes no hardware
// gain, and the macOS slider has no number. Only the macOS *default* input
// device is affected.
//
// execFile with an argument array (no shell) and a validated integer 0-100 is
// what keeps this from being a command-injection surface.

import { execFile } from 'node:child_process';

export type InputVolumeResult =
  | { supported: true; volume: number }
  | { supported: false; reason: string };

/** Parses osascript's stdout for `input volume of (get volume settings)`. "missing value" = the device has no software-controllable gain. */
export function parseInputVolume(stdout: string): InputVolumeResult {
  const text = stdout.trim();
  if (text === 'missing value') {
    return { supported: false, reason: 'The current input device has no adjustable input volume' };
  }
  const n = Number(text);
  if (!Number.isFinite(n) || text === '') return { supported: false, reason: 'Unexpected response from macOS' };
  return { supported: true, volume: Math.max(0, Math.min(100, Math.round(n))) };
}

export function isValidInputVolume(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 100;
}

function runOsascript(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('osascript', ['-e', script], { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

const NOT_MAC: InputVolumeResult = { supported: false, reason: 'Only available on macOS' };

export async function getInputVolume(): Promise<InputVolumeResult> {
  if (process.platform !== 'darwin') return NOT_MAC;
  try {
    return parseInputVolume(await runOsascript('input volume of (get volume settings)'));
  } catch (err) {
    return { supported: false, reason: err instanceof Error ? err.message : 'Could not read input volume' };
  }
}

/** Caller must have validated `volume` with isValidInputVolume. */
export async function setInputVolume(volume: number): Promise<InputVolumeResult> {
  if (process.platform !== 'darwin') return NOT_MAC;
  if (!isValidInputVolume(volume)) return { supported: false, reason: 'Volume must be an integer from 0 to 100' };
  try {
    await runOsascript(`set volume input volume ${volume}`);
  } catch (err) {
    return { supported: false, reason: err instanceof Error ? err.message : 'Could not set input volume' };
  }
  return getInputVolume();
}

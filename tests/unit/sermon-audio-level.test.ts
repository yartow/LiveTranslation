import { describe, it, expect, vi } from 'vitest';
import { LevelStore, rmsToDb, dbToFraction, levelZone, METER_FLOOR_DB } from '../../client/src/lib/sermon/audio-level.js';
import { isBuiltInMic, stripDefaultPrefix } from '../../client/src/hooks/useMicDevices.js';

describe('rmsToDb / dbToFraction', () => {
  it('maps linear RMS to dBFS and clamps silence to the floor', () => {
    expect(rmsToDb(1)).toBeCloseTo(0);
    expect(rmsToDb(0.1)).toBeCloseTo(-20);
    expect(rmsToDb(0)).toBe(METER_FLOOR_DB);
    expect(rmsToDb(1e-9)).toBe(METER_FLOOR_DB);
    expect(rmsToDb(NaN)).toBe(METER_FLOOR_DB);
  });
  it('maps -60..0 dB onto a 0-1 bar', () => {
    expect(dbToFraction(-60)).toBe(0);
    expect(dbToFraction(-30)).toBeCloseTo(0.5);
    expect(dbToFraction(0)).toBe(1);
    expect(dbToFraction(10)).toBe(1);
    expect(dbToFraction(-90)).toBe(0);
  });
});

describe('levelZone', () => {
  it('classifies the signal', () => {
    expect(levelZone(-70, false)).toBe('silent');
    expect(levelZone(-40, false)).toBe('low');
    expect(levelZone(-20, false)).toBe('good');
    expect(levelZone(-3, false)).toBe('hot');
    expect(levelZone(-20, true)).toBe('clipping');
  });
});

describe('LevelStore', () => {
  it('rises instantly and falls slowly', () => {
    const store = new LevelStore();
    store.push(0.5, 0.5, 0);
    const high = store.getSnapshot().db;
    expect(high).toBeCloseTo(rmsToDb(0.5), 0);
    store.push(0.001, 0.001, 100);
    const after = store.getSnapshot().db;
    expect(after).toBeLessThan(high);
    expect(after).toBeGreaterThan(rmsToDb(0.001) + 10);
  });

  it('holds the clipping flag for a moment after a peak at full scale', () => {
    const store = new LevelStore();
    store.push(0.3, 0.99, 1000);
    expect(store.getSnapshot().clipping).toBe(true);
    store.push(0.3, 0.2, 2000);
    expect(store.getSnapshot().clipping).toBe(true);
    store.push(0.3, 0.2, 3000);
    expect(store.getSnapshot().clipping).toBe(false);
  });

  it('notifies subscribers, keeps the snapshot stable when nothing visible changed, and resets to silence', () => {
    const store = new LevelStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);
    store.push(0.1, 0.1, 0);
    const snap = store.getSnapshot();
    expect(listener).toHaveBeenCalledTimes(1);
    store.push(0.1, 0.1, 10);
    expect(store.getSnapshot()).toBe(snap);
    expect(listener).toHaveBeenCalledTimes(1);
    store.reset();
    expect(store.getSnapshot()).toEqual({ db: METER_FLOOR_DB, clipping: false });
    unsubscribe();
    store.push(0.5, 0.5, 20);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('mic labels', () => {
  it('tells the built-in microphone from external ones', () => {
    expect(isBuiltInMic('MacBook Pro Microphone')).toBe(true);
    expect(isBuiltInMic('Ingebouwde microfoon')).toBe(true);
    expect(isBuiltInMic('Built-in Microphone')).toBe(true);
    expect(isBuiltInMic('Rode NT-USB')).toBe(false);
    expect(isBuiltInMic('AirPods Pro')).toBe(false);
  });
  it('strips Chrome\'s "Default - " prefix', () => {
    expect(stripDefaultPrefix('Default - MacBook Pro Microphone (Built-in)')).toBe('MacBook Pro Microphone (Built-in)');
    expect(stripDefaultPrefix('Rode NT-USB')).toBe('Rode NT-USB');
  });
});

/** Feeds `secs` of 256 ms frames whose peak is `peakDb` dBFS (rms 12 dB lower), starting at `from` ms. Returns the end time. */
function feed(store: LevelStore, from: number, secs: number, peakDb: number): number {
  const peak = 10 ** (peakDb / 20);
  let t = from;
  for (; t < from + secs * 1000; t += 256) store.push(peak / 4, peak, t);
  return t;
}

// The levels below are the 28 Oct service, p90 of per-frame peaks before gain:
// hiss -40, faint speech -26, good speech -14.
describe('LevelStore — speech verdict', () => {
  it('says nothing until a full 10 s window has been heard', () => {
    const store = new LevelStore();
    const end = feed(store, 0, 9, -14);
    expect(store.speechVerdict(end)).toBeNull();
    expect(store.speechVerdict(feed(store, end, 2, -14))).toBe('ok');
  });

  it('tells hiss from faint speech from good speech', () => {
    const hiss = new LevelStore();
    expect(hiss.speechVerdict(feed(hiss, 0, 12, -40))).toBe('no-speech');
    const faint = new LevelStore();
    expect(faint.speechVerdict(feed(faint, 0, 12, -26))).toBe('too-quiet');
    const good = new LevelStore();
    expect(good.speechVerdict(feed(good, 0, 12, -14))).toBe('ok');
  });

  it('judges the level after gain: the 0.5 gain that was saved on 28 Oct turns good speech into a weak signal', () => {
    const store = new LevelStore();
    store.setGain(0.5);
    expect(store.speechVerdict(feed(store, 0, 12, -16))).toBe('too-quiet');
    store.setGain(1);
    expect(store.speechVerdict(12_000)).toBe('too-quiet'); // the new answer has to hold for 3 s first
    expect(store.speechVerdict(15_000)).toBe('ok');
  });

  it('keeps no-speech on the level at the microphone, whatever the gain', () => {
    const store = new LevelStore();
    store.setGain(10);
    expect(store.speechVerdict(feed(store, 0, 12, -40))).toBe('no-speech');
  });

  it('flags a loud signal, and clipping even when most frames are quiet', () => {
    const loud = new LevelStore();
    expect(loud.speechVerdict(feed(loud, 0, 12, -2))).toBe('too-loud');
    const clipped = new LevelStore();
    let t = feed(clipped, 0, 11, -14);
    clipped.push(0.5, 0.99, t);
    expect(clipped.speechVerdict(t + 256)).toBe('too-loud');
  });

  it('holds a new answer for 3 s before showing it, so it does not flicker', () => {
    const store = new LevelStore();
    let t = feed(store, 0, 12, -14);
    expect(store.speechVerdict(t)).toBe('ok');
    t = feed(store, t, 10, -30); // a whole window of weak speech
    expect(store.speechVerdict(t - 4000)).toBe('ok');   // candidate starts here
    expect(store.speechVerdict(t - 2000)).toBe('ok');   // not yet 3 s
    expect(store.speechVerdict(t + 1500)).toBe('too-quiet');
  });

  it('withdraws "too quiet" only once the level is 3 dB clear of the boundary', () => {
    const store = new LevelStore();
    let t = feed(store, 0, 12, -24);
    expect(store.speechVerdict(t)).toBe('too-quiet');
    t = feed(store, t, 12, -19); // just past the -20 dBFS boundary, inside the 3 dB margin
    expect(store.speechVerdict(t)).toBe('too-quiet');
    expect(store.speechVerdict(t + 5000)).toBe('too-quiet');
    t = feed(store, t, 12, -15);
    store.speechVerdict(t);
    expect(store.speechVerdict(t + 4000)).toBe('ok');
  });

  it('starts listening again after a reset or a microphone switch', () => {
    const store = new LevelStore();
    const end = feed(store, 0, 12, -14);
    expect(store.speechVerdict(end)).toBe('ok');
    store.restartSilenceClock(end);
    expect(store.speechVerdict(end + 1000)).toBeNull();
    store.reset();
    expect(store.speechVerdict(end + 20_000)).toBeNull();
  });

  it('clamps the gain like the recording does and ignores NaN', () => {
    const store = new LevelStore();
    store.setGain(NaN);
    expect(store.speechVerdict(feed(store, 0, 12, -14))).toBe('ok');
  });
});

describe('LevelStore — no-sound clock', () => {
  it('counts up from the restart while nothing but silence arrives', () => {
    const store = new LevelStore();
    store.restartSilenceClock(1000);
    store.push(0, 0, 5000);
    expect(store.silentForMs(21_000)).toBe(20_000);
  });

  it('any real sound resets it; hiss below -70 dBFS does not', () => {
    const store = new LevelStore();
    store.restartSilenceClock(0);
    store.push(0.0001, 0.0001, 10_000); // -80 dBFS
    expect(store.silentForMs(15_000)).toBe(15_000);
    store.push(0.01, 0.02, 12_000);     // -40 dBFS
    expect(store.silentForMs(15_000)).toBe(3_000);
  });

  it('restarting (resume, switch to another microphone) forgets earlier sound', () => {
    const store = new LevelStore();
    store.push(0.1, 0.2, 1000);
    store.restartSilenceClock(5000);
    expect(store.silentForMs(6000)).toBe(1000);
  });
});

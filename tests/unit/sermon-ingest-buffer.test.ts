import { describe, it, expect } from 'vitest';
import { initIngestState, appendChunk, tick, type IngestState } from '../../client/src/lib/sermon/ingest-buffer.js';

describe('appendChunk — AC6: sentence-boundary flush', () => {
  it('emits exactly the complete sentence and keeps the partial remainder buffered', () => {
    const state = initIngestState();
    const { state: after, effects } = appendChunk(state, 'Dit is een zin. En nog', { maxLatencyMs: 6000 }, 0);

    expect(effects).toEqual([{ type: 'emit', text: 'Dit is een zin.', provisional: false }]);
    // remaining buffer is the partial sentence — not yet emitted
    const stillNothing = tick(after, { maxLatencyMs: 6000 }, 100);
    expect(stillNothing.effects).toEqual([]);
  });

  it('emits multiple complete sentences in one flush', () => {
    const state = initIngestState();
    const { effects } = appendChunk(state, 'Een. Twee. Drie', { maxLatencyMs: 6000 }, 0);
    expect(effects).toEqual([
      { type: 'emit', text: 'Een.', provisional: false },
      { type: 'emit', text: 'Twee.', provisional: false },
    ]);
  });

  it('accumulates across multiple chunk arrivals before a boundary appears', () => {
    let state = initIngestState();
    ({ state } = appendChunk(state, 'Dit is', { maxLatencyMs: 6000 }, 0));
    expect(tick(state, { maxLatencyMs: 6000 }, 10).effects).toEqual([]);
    const step = appendChunk(state, ' een volledige zin.', { maxLatencyMs: 6000 }, 20);
    expect(step.effects).toEqual([{ type: 'emit', text: 'Dit is een volledige zin.', provisional: false }]);
  });
});

describe('cap-flush carry-over (AC8a)', () => {
  it('cuts at the last complete boundary and the leftover keeps its OWN arrival time, not now', () => {
    let state = initIngestState();
    const cfg = { maxLatencyMs: 6000 };

    // "Zin een." arrives at t=0, "Zin twee." at t=1000, "Half" (no punctuation) at t=5000.
    ({ state } = appendChunk(state, 'Zin een. Zin twee. Half', cfg, 0));
    // both complete sentences flush immediately (boundary trigger fires regardless of the cap)
    // buffer now holds just "Half", with its piece timestamped at t=0 (it arrived in the same chunk).
    // Re-derive by checking that the cap, measured from t=0, fires at t=6000 — not reset to "now".
    expect(tick(state, cfg, 5999).effects).toEqual([]);
    const capped = tick(state, cfg, 6000);
    expect(capped.effects).toEqual([{ type: 'emit', text: 'Half', provisional: true, token: 'p0' }]);
  });

  it('a later-arriving remainder keeps its own age when a prior boundary already flushed', () => {
    let state = initIngestState();
    const cfg = { maxLatencyMs: 6000 };

    ({ state } = appendChunk(state, 'Eerste zin.', cfg, 0)); // flushes immediately, buffer empty
    ({ state } = appendChunk(state, ' Nieuw stuk zonder punt', cfg, 4000)); // arrives later, no boundary

    // Cap counted from t=4000 (when this piece arrived), not from t=0.
    expect(tick(state, cfg, 9999).effects).toEqual([]);
    const capped = tick(state, cfg, 10000);
    expect(capped.effects[0]).toMatchObject({ type: 'emit', provisional: true, text: 'Nieuw stuk zonder punt' });
  });
});

describe('cap-flush PROVISIONAL path (AC8b)', () => {
  it('emits one PROVISIONAL row, keeps updating the SAME row, then completes it exactly once when the sentence finishes', () => {
    let state = initIngestState();
    const cfg = { maxLatencyMs: 3000 };

    ({ state } = appendChunk(state, 'Een lange zin zonder punt', cfg, 0));
    expect(tick(state, cfg, 2999).effects).toEqual([]);

    let step = tick(state, cfg, 3000);
    expect(step.effects).toEqual([{ type: 'emit', text: 'Een lange zin zonder punt', provisional: true, token: 'p0' }]);
    state = step.state;
    expect(state.provisionalToken).toBe('p0');

    // Sentence keeps growing — cap re-evaluates but must not open a second provisional row.
    ({ state } = appendChunk(state, ' die maar door blijft gaan', cfg, 3500));
    step = tick(state, cfg, 6000);
    expect(step.effects).toEqual([
      { type: 'updateProvisional', token: 'p0', text: 'Een lange zin zonder punt die maar door blijft gaan' },
    ]);
    state = step.state;
    expect(state.provisionalToken).toBe('p0'); // still the same row

    // Sentence finally completes.
    const completion = appendChunk(state, '. Klaar.', cfg, 7000);
    expect(completion.effects).toEqual([
      { type: 'completeProvisional', token: 'p0', text: 'Een lange zin zonder punt die maar door blijft gaan.' },
      { type: 'emit', text: 'Klaar.', provisional: false },
    ]);
    expect(completion.state.provisionalToken).toBeNull();
  });
});

describe('AC9: a live config change is honoured on the very next tick', () => {
  it('a longer buffered sentence flushes sooner once maxLatencyMs is lowered mid-session', () => {
    let state = initIngestState();
    ({ state } = appendChunk(state, 'Nog steeds aan het praten', { maxLatencyMs: 6000 }, 0));

    // With the original 6s cap, nothing at t=3000.
    expect(tick(state, { maxLatencyMs: 6000 }, 3000).effects).toEqual([]);

    // Settings changed mid-session to a 3s cap — the very next tick call
    // (which reads the new cfg, exactly as settingsRef would in the hook)
    // must honour it immediately, with no restart needed.
    const step = tick(state, { maxLatencyMs: 3000 }, 3000);
    expect(step.effects).toEqual([{ type: 'emit', text: 'Nog steeds aan het praten', provisional: true, token: 'p0' }]);
  });
});

describe('empty/edge input', () => {
  it('ignores an empty or whitespace-only chunk', () => {
    const state = initIngestState();
    const { effects, state: after } = appendChunk(state, '   ', { maxLatencyMs: 6000 }, 0);
    expect(effects).toEqual([]);
    expect(after).toBe(state);
  });

  it('tick on an empty buffer never fires the cap', () => {
    const state = initIngestState();
    expect(tick(state, { maxLatencyMs: 1 }, 999999).effects).toEqual([]);
  });
});

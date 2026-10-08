import { describe, it, expect } from 'vitest';
import { initIngestState, appendChunk, tick, releaseProvisional, type IngestState } from '../../client/src/lib/sermon/ingest-buffer.js';

describe('appendChunk — AC6: sentence-boundary flush gated on the block duration', () => {
  it('does not flush a complete sentence before the block duration is reached, then flushes it once due', () => {
    const state = initIngestState();
    const cfg = { maxLatencyMs: 6000 };
    const { state: after, effects } = appendChunk(state, 'Dit is een zin. En nog', cfg, 0);
    expect(effects).toEqual([]); // boundary exists, but the block hasn't reached maxLatencyMs yet

    const step = tick(after, cfg, 6000);
    expect(step.effects).toEqual([{ type: 'emit', text: 'Dit is een zin.', provisional: false }]);
    // The leftover "En nog" starts a FRESH block clock at the flush time (AC8a), so it is
    // held, not immediately cut, on the very next evaluation.
    expect(tick(step.state, cfg, 6100).effects).toEqual([]);
    // Only once its own full maxLatencyMs has elapsed does it get a provisional cut.
    const provisional = tick(step.state, cfg, 12000);
    expect(provisional.effects).toEqual([{ type: 'emit', text: 'En nog', provisional: true, token: 'p0' }]);
  });

  it('groups every complete sentence accumulated within one block into a single joined emit', () => {
    const state = initIngestState();
    const cfg = { maxLatencyMs: 6000 };
    const { state: after, effects } = appendChunk(state, 'Een. Twee. Drie', cfg, 0);
    expect(effects).toEqual([]);

    const step = tick(after, cfg, 6000);
    expect(step.effects).toEqual([{ type: 'emit', text: 'Een. Twee.', provisional: false }]);
  });

  it('accumulates across multiple chunk arrivals before a boundary appears, then still waits out the block duration', () => {
    let state = initIngestState();
    const cfg = { maxLatencyMs: 6000 };
    ({ state } = appendChunk(state, 'Dit is', cfg, 0));
    expect(tick(state, cfg, 10).effects).toEqual([]);
    let step = appendChunk(state, ' een volledige zin.', cfg, 20);
    expect(step.effects).toEqual([]); // boundary now exists, block duration still not reached
    step = tick(step.state, cfg, 6000);
    expect(step.effects).toEqual([{ type: 'emit', text: 'Dit is een volledige zin.', provisional: false }]);
  });
});

describe('cap-flush carry-over (AC8a) — the block clock restarts on flush', () => {
  it('flushes every complete sentence in the block together once due, and the leftover starts a FRESH block clock, not an already-expired one', () => {
    let state = initIngestState();
    const cfg = { maxLatencyMs: 6000 };

    // "Zin een." and "Zin twee." (both complete) plus "Half" (no punctuation) all arrive at t=0.
    ({ state } = appendChunk(state, 'Zin een. Zin twee. Half', cfg, 0));
    expect(tick(state, cfg, 5999).effects).toEqual([]);

    // At t=6000 the block is due: the two complete sentences flush together as one segment.
    const capped = tick(state, cfg, 6000);
    expect(capped.effects).toEqual([{ type: 'emit', text: 'Zin een. Zin twee.', provisional: false }]);

    // "Half" survives the flush with its clock RESTARTED at the flush time — this is the fix
    // for the bug where a leftover partial used to be cut into its own tiny segment on the
    // very next tick. It must be held, not cut, immediately after the flush...
    expect(tick(capped.state, cfg, 6000).effects).toEqual([]);
    expect(tick(capped.state, cfg, 11999).effects).toEqual([]);
    // ...and only forced into a provisional cut once its OWN full maxLatencyMs has elapsed.
    const provisional = tick(capped.state, cfg, 12000);
    expect(provisional.effects).toEqual([{ type: 'emit', text: 'Half', provisional: true, token: 'p0' }]);
  });

  it('a later-arriving remainder keeps its own age when a prior block already flushed', () => {
    let state = initIngestState();
    const cfg = { maxLatencyMs: 6000 };

    ({ state } = appendChunk(state, 'Eerste zin.', cfg, 0));
    const flushed = tick(state, cfg, 6000); // block due with only "Eerste zin." buffered
    expect(flushed.effects).toEqual([{ type: 'emit', text: 'Eerste zin.', provisional: false }]);
    ({ state } = appendChunk(flushed.state, 'Nieuw stuk zonder punt', cfg, 10000)); // arrives later, no boundary

    // Cap counted from t=10000 (when this piece arrived), not from t=0.
    expect(tick(state, cfg, 15999).effects).toEqual([]);
    const capped = tick(state, cfg, 16000);
    expect(capped.effects[0]).toMatchObject({ type: 'emit', provisional: true, text: 'Nieuw stuk zonder punt' });
  });

  it('regression: a leftover partial is absorbed into the NEXT block instead of becoming its own segment', () => {
    // This is the exact shape of the reported bug: a block flushes, leaving a trailing
    // partial sentence, and more speech arrives before the partial's own deadline — it
    // must join the next block's joined emit, not have already been cut out on its own.
    let state = initIngestState();
    const cfg = { maxLatencyMs: 6000 };

    ({ state } = appendChunk(state, 'Eerste zin. Nog een zin. En een derde', cfg, 0));
    const capped = tick(state, cfg, 6000);
    expect(capped.effects).toEqual([{ type: 'emit', text: 'Eerste zin. Nog een zin.', provisional: false }]);

    // More speech completes the leftover well within its own fresh 6s window.
    ({ state } = appendChunk(capped.state, 'zin.', cfg, 6500));
    expect(tick(state, cfg, 6600).effects).toEqual([]); // not due yet — held, not cut

    const next = tick(state, cfg, 12000);
    expect(next.effects).toEqual([{ type: 'emit', text: 'En een derde zin.', provisional: false }]);
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
    // The growth is surfaced as soon as it arrives (appendChunk evaluates too)...
    step = appendChunk(state, ' die maar door blijft gaan', cfg, 3500);
    expect(step.effects).toEqual([
      { type: 'updateProvisional', token: 'p0', text: 'Een lange zin zonder punt die maar door blijft gaan' },
    ]);
    state = step.state;
    expect(state.provisionalToken).toBe('p0'); // still the same row
    // ...and a later tick with nothing new stays quiet.
    expect(tick(state, cfg, 6000).effects).toEqual([]);

    // Sentence finally completes.
    const completion = appendChunk(state, '. Klaar.', cfg, 7000);
    // Only the provisional's own sentence is consumed. "Klaar." stays buffered
    // with a fresh block clock instead of becoming a lone extra row.
    expect(completion.effects).toEqual([
      { type: 'completeProvisional', token: 'p0', text: 'Een lange zin zonder punt die maar door blijft gaan.' },
    ]);
    expect(completion.state.provisionalToken).toBeNull();
    expect(tick(completion.state, cfg, 9999).effects).toEqual([]);
    expect(tick(completion.state, cfg, 10000).effects).toEqual([{ type: 'emit', text: 'Klaar.', provisional: false }]);
  });

  it('does not re-send an unchanged provisional text on every tick', () => {
    let state = initIngestState();
    const cfg = { maxLatencyMs: 3000 };
    ({ state } = appendChunk(state, 'Een lange zin zonder punt', cfg, 0));
    const opened = tick(state, cfg, 3000);
    expect(opened.effects).toHaveLength(1);
    expect(tick(opened.state, cfg, 3250).effects).toEqual([]);
    expect(tick(opened.state, cfg, 3500).effects).toEqual([]);
  });
});

describe('minBlockWords — a short block gets an extra half-window before flushing alone', () => {
  it('holds a lone short sentence past the deadline, then flushes it at 1.5x', () => {
    let state = initIngestState();
    const cfg = { maxLatencyMs: 6000, minBlockWords: 12 };
    ({ state } = appendChunk(state, 'Amen.', cfg, 0));
    expect(tick(state, cfg, 6000).effects).toEqual([]);
    expect(tick(state, cfg, 8999).effects).toEqual([]);
    expect(tick(state, cfg, 9000).effects).toEqual([{ type: 'emit', text: 'Amen.', provisional: false }]);
  });

  it('flushes at the normal deadline once the block is long enough', () => {
    let state = initIngestState();
    const cfg = { maxLatencyMs: 6000, minBlockWords: 5 };
    ({ state } = appendChunk(state, 'Dit is een heel nette zin.', cfg, 0));
    expect(tick(state, cfg, 6000).effects).toEqual([{ type: 'emit', text: 'Dit is een heel nette zin.', provisional: false }]);
  });

  it('a short sentence absorbs the next one that arrives during the extra window', () => {
    let state = initIngestState();
    const cfg = { maxLatencyMs: 6000, minBlockWords: 8 };
    ({ state } = appendChunk(state, 'Amen.', cfg, 0));
    expect(tick(state, cfg, 6000).effects).toEqual([]);
    const step = appendChunk(state, ' Laten we samen bidden voor de dienst.', cfg, 7000);
    expect(step.effects).toEqual([
      { type: 'emit', text: 'Amen. Laten we samen bidden voor de dienst.', provisional: false },
    ]);
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

describe('AC10: short sentences group into one ~maxLatencyMs block instead of one segment each', () => {
  it('several short, already-punctuated sentences spoken back to back become a single segment', () => {
    let state = initIngestState();
    const cfg = { maxLatencyMs: 5000 };

    // Mirrors real short-fragment ASR output arriving in separate chunks, well inside the block window.
    ({ state } = appendChunk(state, 'De tekst hoort waarschijnlijk per twee zinnen.', cfg, 0));
    expect(tick(state, cfg, 1000).effects).toEqual([]); // block not due yet — kept buffered, not emitted per-sentence

    ({ state } = appendChunk(state, ' Niet per vijf woorden.', cfg, 1500));
    expect(tick(state, cfg, 4999).effects).toEqual([]); // still accumulating

    const step = tick(state, cfg, 5000); // block due (anchor at t=0)
    expect(step.effects).toEqual([{
      type: 'emit',
      text: 'De tekst hoort waarschijnlijk per twee zinnen. Niet per vijf woorden.',
      provisional: false,
    }]);
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

describe('releaseProvisional — the human edited the open provisional row', () => {
  const cfg = { maxLatencyMs: 3000 };

  function openProvisional(): IngestState {
    let state = initIngestState();
    ({ state } = appendChunk(state, 'Een lange zin zonder punt', cfg, 0));
    ({ state } = tick(state, cfg, 3000));
    expect(state.provisionalToken).toBe('p0');
    return state;
  }

  it('drops the text the row already shows and emits nothing further for it', () => {
    const released = releaseProvisional(openProvisional(), 3500);
    expect(released.provisionalToken).toBeNull();
    expect(released.pieces.some(p => p.text.trim())).toBe(false);
    expect(released.anchorAt).toBeNull();
    expect(tick(released, cfg, 20000).effects).toEqual([]);
  });

  it('puts only the words that arrive afterwards into the next row (no duplicated block)', () => {
    const released = releaseProvisional(openProvisional(), 3500);
    let { state } = appendChunk(released, 'Nieuwe zin hier.', cfg, 4000);
    const step = tick(state, cfg, 7000);
    expect(step.effects).toEqual([{ type: 'emit', text: 'Nieuwe zin hier.', provisional: false }]);
  });

  it('still dedupes a chunk that repeats the tail of the handed-over text', () => {
    const released = releaseProvisional(openProvisional(), 3500);
    const { state } = appendChunk(released, 'zin zonder punt en verder.', cfg, 4000);
    const step = tick(state, cfg, 7000);
    expect(step.effects).toEqual([{ type: 'emit', text: 'en verder.', provisional: false }]);
  });

  it('is a no-op when no provisional row is open', () => {
    const { state } = appendChunk(initIngestState(), 'Half een zin', cfg, 0);
    expect(releaseProvisional(state, 1000)).toBe(state);
  });
});

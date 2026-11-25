import { describe, it, expect } from 'vitest';
import { PipelineStats } from '../../client/src/lib/sermon/pipeline-stats.js';

describe('PipelineStats — chunks', () => {
  it('measures the delay from sent to done, including chunks that produced no text', () => {
    const s = new PipelineStats();
    s.chunkSent(0, 1000);
    s.chunkSent(1, 2000); // will come back empty
    s.chunkSent(2, 3000);
    s.chunkProgress(3, 6000); // server: everything below 3 is handled
    const snap = s.snapshot(6000);
    expect(snap.backlog).toBe(0);
    expect(snap.chunkDelayLastMs).toBe(3000);
    expect(snap.chunkDelayMedianMs).toBe(4000); // delays 5000, 4000, 3000
    expect(snap.level).toBe('ok');
  });

  it('counts chunks still waiting and how long the oldest has been', () => {
    const s = new PipelineStats();
    s.chunkSent(0, 1000);
    s.chunkSent(1, 4000);
    s.chunkProgress(1, 5000);
    const snap = s.snapshot(9000);
    expect(snap.backlog).toBe(1);
    expect(snap.oldestPendingMs).toBe(5000);
  });

  it('warns when chunks pile up or take long, and calls it bad when far behind', () => {
    const s = new PipelineStats();
    for (let i = 0; i < 3; i++) s.chunkSent(i, 1000);
    expect(s.snapshot(2000).level).toBe('warn');
    expect(s.snapshot(2000).reason).toMatch(/3 chunks/);
    for (let i = 3; i < 6; i++) s.chunkSent(i, 1000);
    expect(s.snapshot(2000).level).toBe('bad');

    const slow = new PipelineStats();
    slow.chunkSent(0, 0);
    expect(slow.snapshot(13_000).level).toBe('warn');
    expect(slow.snapshot(26_000).level).toBe('bad');
  });

  it('keeps only the recent samples for the median', () => {
    const s = new PipelineStats();
    for (let i = 0; i < 30; i++) { s.chunkSent(i, 0); s.chunkProgress(i + 1, i < 10 ? 20_000 : 2000); }
    expect(s.snapshot(100).chunkDelayMedianMs).toBe(2000);
  });

  it('a new recording starts with nothing pending', () => {
    const s = new PipelineStats();
    s.chunkSent(0, 0);
    s.resetPending();
    expect(s.snapshot(60_000).backlog).toBe(0);
    expect(s.snapshot(60_000).level).toBe('ok');
  });

  it('counts reconnects', () => {
    const s = new PipelineStats();
    s.reconnecting(); s.reconnecting();
    expect(s.snapshot(0).reconnects).toBe(2);
  });
});

describe('PipelineStats — translation', () => {
  it('tracks call times', () => {
    const s = new PipelineStats();
    s.translateOk(800); s.translateOk(1200); s.translateOk(1000);
    const snap = s.snapshot(0);
    expect(snap.translateLastMs).toBe(1000);
    expect(snap.translateMedianMs).toBe(1000);
  });

  it('counts errors for ten minutes and flags a burst as bad', () => {
    const s = new PipelineStats();
    s.translateError(true, 1000);
    s.translateError(false, 2000);
    expect(s.snapshot(3000)).toMatchObject({ translateErrors: 2, rateLimited: 1, level: 'ok' });
    s.translateError(false, 3000);
    expect(s.snapshot(4000)).toMatchObject({ level: 'bad' });
    expect(s.snapshot(4000).reason).toMatch(/translation errors/);
    // two minutes later the burst no longer counts as "recent", ten minutes later it is gone
    expect(s.snapshot(200_000).level).toBe('ok');
    expect(s.snapshot(200_000).translateErrors).toBe(3);
    expect(s.snapshot(700_000).translateErrors).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { planRestart, hasRestartHeader } from '../../server/lib/restart-server.js';

const base = { nodeEnv: 'production', port: 3000, cwd: '/app', exists: () => true };

describe('planRestart', () => {
  it('refuses outside production (npm run dev has no supervisor)', () => {
    const r = planRestart({ ...base, nodeEnv: 'development' });
    expect(r).toMatchObject({ ok: false, status: 409 });
  });

  it('refuses when scripts/launch.sh is missing', () => {
    expect(planRestart({ ...base, exists: () => false })).toMatchObject({ ok: false, status: 501 });
  });

  it('refuses an unusable port', () => {
    expect(planRestart({ ...base, port: 0 })).toMatchObject({ ok: false, status: 500 });
    expect(planRestart({ ...base, port: 70000 })).toMatchObject({ ok: false, status: 500 });
  });

  it('waits for the port to free, then runs the launcher without opening a window', () => {
    const r = planRestart(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.args[0]).toBe('-c');
    expect(r.script).toContain('nc -z 127.0.0.1 "$1"');
    expect(r.script).toContain('NO_OPEN=1 exec "$2"');
    // Port and path travel as positional parameters, never inside the script text.
    expect(r.args.slice(3)).toEqual(['3000', '/app/scripts/launch.sh']);
    expect(r.script).not.toContain('/app');
  });
});

describe('hasRestartHeader — the cross-site guard', () => {
  it('accepts only the custom header the Settings button sends', () => {
    expect(hasRestartHeader({ 'x-ctt-restart': '1' })).toBe(true);
    expect(hasRestartHeader({})).toBe(false);
    expect(hasRestartHeader({ 'x-ctt-restart': '0' })).toBe(false);
    expect(hasRestartHeader({ 'content-type': 'text/plain' })).toBe(false);
  });
});

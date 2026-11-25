import { describe, it, expect } from 'vitest';
import { parseInputVolume, isValidInputVolume } from '../../server/lib/mac-input-volume.js';
import { isLoopbackAddress, isOperatorRequest } from '../../server/lib/loopback.js';

describe('parseInputVolume', () => {
  it('parses osascript output', () => {
    expect(parseInputVolume('50\n')).toEqual({ supported: true, volume: 50 });
    expect(parseInputVolume('100')).toEqual({ supported: true, volume: 100 });
  });
  it('reports a device without adjustable gain as unsupported', () => {
    expect(parseInputVolume('missing value\n')).toMatchObject({ supported: false });
  });
  it('rejects garbage', () => {
    expect(parseInputVolume('')).toMatchObject({ supported: false });
    expect(parseInputVolume('loud')).toMatchObject({ supported: false });
  });
});

describe('isValidInputVolume', () => {
  it('only accepts integers 0-100', () => {
    for (const ok of [0, 1, 50, 100]) expect(isValidInputVolume(ok)).toBe(true);
    for (const bad of [-1, 101, 50.5, NaN, '50', null, undefined, '50; do shell script "x"']) expect(isValidInputVolume(bad)).toBe(false);
  });
});

describe('loopback guard', () => {
  it('recognises the local machine only', () => {
    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('192.168.1.20')).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
  it('opens operator endpoints to the LAN only with ALLOW_REMOTE_OPERATOR', () => {
    delete process.env.ALLOW_REMOTE_OPERATOR;
    expect(isOperatorRequest('192.168.1.20')).toBe(false);
    process.env.ALLOW_REMOTE_OPERATOR = 'true';
    expect(isOperatorRequest('192.168.1.20')).toBe(true);
    delete process.env.ALLOW_REMOTE_OPERATOR;
  });
});

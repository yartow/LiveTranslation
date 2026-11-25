import { describe, it, expect } from 'vitest';
import { redactSecrets, buildEntry, formatArg } from '../../client/src/lib/client-log.js';

describe('redactSecrets', () => {
  it('removes API-key-shaped tokens', () => {
    expect(redactSecrets('key sk-abcdefghijklmnop1234 failed')).toBe('key sk-[redacted] failed');
    expect(redactSecrets('x-api-key sk-ant-api03-AbCdEfGhIjKlMnOp_1234')).toContain('sk-[redacted]');
    expect(redactSecrets('Authorization: Bearer abcdef0123456789xyz')).toBe('Authorization: Bearer [redacted]');
  });
  it('leaves ordinary text alone', () => {
    expect(redactSecrets('Segment sk-1 is fine, task-done')).toBe('Segment sk-1 is fine, task-done');
  });
});

describe('buildEntry', () => {
  it('joins arguments, redacts, caps the length and keeps the stack of an Error', () => {
    const err = new Error('boom sk-abcdefghijklmnop1234');
    const e = buildEntry('error', ['Translate failed:', err, { id: 3 }], 42);
    expect(e.t).toBe(42);
    expect(e.level).toBe('error');
    expect(e.message).toContain('Translate failed:');
    expect(e.message).toContain('Error: boom sk-[redacted]');
    expect(e.message).toContain('{"id":3}');
    expect(e.stack).toBeDefined();
    expect(e.stack).not.toContain('abcdefghijklmnop1234');
    expect(buildEntry('warn', ['x'.repeat(5000)], 1).message).toHaveLength(2000);
  });
  it('survives values that cannot be stringified', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatArg(circular)).not.toThrow();
    expect(formatArg(undefined)).toBe('undefined');
  });
});

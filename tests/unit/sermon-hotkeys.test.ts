import { describe, it, expect } from 'vitest';
import { isRefreshAllChord, isRefreshOneChord, isNextRowChord, type KeyChord } from '../../client/src/lib/sermon/hotkeys.js';

const chord = (overrides: Partial<KeyChord>): KeyChord => ({
  metaKey: false, ctrlKey: false, shiftKey: false, code: 'Enter', ...overrides,
});

describe('isRefreshAllChord (Cmd/Ctrl+Shift+Enter)', () => {
  it('matches Cmd+Shift+Enter', () => {
    expect(isRefreshAllChord(chord({ metaKey: true, shiftKey: true }))).toBe(true);
  });

  it('matches Ctrl+Shift+Enter', () => {
    expect(isRefreshAllChord(chord({ ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it('matches the numpad Enter code too', () => {
    expect(isRefreshAllChord(chord({ metaKey: true, shiftKey: true, code: 'NumpadEnter' }))).toBe(true);
  });

  it('rejects without Shift', () => {
    expect(isRefreshAllChord(chord({ metaKey: true, shiftKey: false }))).toBe(false);
  });

  it('rejects without Cmd/Ctrl', () => {
    expect(isRefreshAllChord(chord({ shiftKey: true }))).toBe(false);
  });

  it('rejects a non-Enter key', () => {
    expect(isRefreshAllChord(chord({ metaKey: true, shiftKey: true, code: 'KeyS' }))).toBe(false);
  });
});

describe('isRefreshOneChord (Cmd/Ctrl+Enter, no Shift)', () => {
  it('matches Cmd+Enter', () => {
    expect(isRefreshOneChord(chord({ metaKey: true }))).toBe(true);
  });

  it('matches Ctrl+Enter', () => {
    expect(isRefreshOneChord(chord({ ctrlKey: true }))).toBe(true);
  });

  it('rejects when Shift is also held (that is the refresh-all chord)', () => {
    expect(isRefreshOneChord(chord({ metaKey: true, shiftKey: true }))).toBe(false);
  });

  it('rejects without Cmd/Ctrl', () => {
    expect(isRefreshOneChord(chord({}))).toBe(false);
  });
});

describe('isNextRowChord (plain Enter)', () => {
  it('matches Enter and the numpad Enter', () => {
    expect(isNextRowChord(chord({}))).toBe(true);
    expect(isNextRowChord(chord({ code: 'NumpadEnter' }))).toBe(true);
  });

  it('rejects Enter with any modifier (Shift = newline, Cmd/Ctrl = refresh)', () => {
    expect(isNextRowChord(chord({ shiftKey: true }))).toBe(false);
    expect(isNextRowChord(chord({ metaKey: true }))).toBe(false);
    expect(isNextRowChord(chord({ ctrlKey: true }))).toBe(false);
    expect(isNextRowChord(chord({ altKey: true }))).toBe(false);
  });

  it('matches a soft-keyboard Enter that has key "Enter" but an empty code', () => {
    expect(isNextRowChord(chord({ code: '', key: 'Enter' }))).toBe(true);
    expect(isNextRowChord(chord({ code: '', key: 'Enter', shiftKey: true }))).toBe(false);
  });

  it('rejects other keys', () => {
    expect(isNextRowChord(chord({ code: 'Tab' }))).toBe(false);
    expect(isNextRowChord(chord({ code: '', key: 'a' }))).toBe(false);
  });
});

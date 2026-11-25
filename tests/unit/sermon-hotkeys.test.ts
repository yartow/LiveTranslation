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

import {
  isToggleSourceChord, isToggleTargetChord, isToggleHeaderChord, isTextBiggerChord, isTextSmallerChord,
} from '../../client/src/lib/sermon/hotkeys.js';

describe('layout chords', () => {
  const k = (o: Partial<KeyChord>): KeyChord => ({ metaKey: false, ctrlKey: true, shiftKey: false, code: '', ...o });

  it('Ctrl+1/2/3 and Ctrl+Alt+1/2/3 match their own toggle only', () => {
    expect(isToggleSourceChord(k({ code: 'Digit1' }))).toBe(true);
    expect(isToggleSourceChord(k({ code: 'Digit1', altKey: true, key: '¡' }))).toBe(true);
    expect(isToggleTargetChord(k({ code: 'Digit2' }))).toBe(true);
    expect(isToggleHeaderChord(k({ code: 'Digit3' }))).toBe(true);
    expect(isToggleHeaderChord(k({ code: 'Digit1' }))).toBe(false);
    expect(isToggleSourceChord(k({ code: '', key: '1' }))).toBe(true);
  });

  it('digits need Ctrl, and never Cmd or Shift', () => {
    expect(isToggleSourceChord(k({ code: 'Digit1', ctrlKey: false }))).toBe(false);
    expect(isToggleSourceChord(k({ code: 'Digit1', metaKey: true }))).toBe(false);
    expect(isToggleSourceChord(k({ code: 'Digit1', shiftKey: true }))).toBe(false);
  });

  it('ignores keys during IME composition', () => {
    expect(isToggleSourceChord(k({ code: 'Digit1', isComposing: true }))).toBe(false);
    expect(isTextBiggerChord(k({ code: 'Equal', isComposing: true }))).toBe(false);
  });

  it('Ctrl+= / Ctrl++ is bigger, Ctrl+- is smaller, Shift irrelevant', () => {
    expect(isTextBiggerChord(k({ code: 'Equal' }))).toBe(true);
    expect(isTextBiggerChord(k({ code: 'Equal', shiftKey: true, key: '+' }))).toBe(true);
    expect(isTextBiggerChord(k({ code: 'NumpadAdd' }))).toBe(true);
    expect(isTextSmallerChord(k({ code: 'Minus' }))).toBe(true);
    expect(isTextSmallerChord(k({ code: 'NumpadSubtract' }))).toBe(true);
    expect(isTextBiggerChord(k({ code: 'Minus' }))).toBe(false);
  });

  it('text size chords need Ctrl and reject Cmd/Alt', () => {
    expect(isTextBiggerChord(k({ code: 'Equal', ctrlKey: false }))).toBe(false);
    expect(isTextBiggerChord(k({ code: 'Equal', metaKey: true }))).toBe(false);
    expect(isTextSmallerChord(k({ code: 'Minus', altKey: true }))).toBe(false);
  });
});

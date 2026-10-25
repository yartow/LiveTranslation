import { describe, it, expect } from 'vitest';
import { sanitizeSettings } from '../../client/src/lib/settings-validate';
import { defaultSettings, type AppSettings } from '../../client/src/hooks/useSettings';

/** What loadSettings does: defaults overlaid with whatever storage held. */
const load = (stored: Record<string, unknown>): AppSettings =>
  sanitizeSettings({ ...defaultSettings, ...stored } as AppSettings, defaultSettings);

describe('sanitizeSettings', () => {
  it('leaves valid defaults untouched', () => {
    expect(load({})).toEqual(defaultSettings);
  });

  it('keeps valid stored values', () => {
    const s = load({ transcriptionProvider: 'mlx', sermonBibleVersion: 'LSB', sermonMaxLatencySecs: 9, chunkOverlapMs: 1000 });
    expect(s).toMatchObject({ transcriptionProvider: 'mlx', sermonBibleVersion: 'LSB', sermonMaxLatencySecs: 9, chunkOverlapMs: 1000 });
  });

  describe('enums fall back to the default', () => {
    it.each([
      ['transcriptionProvider', 'siri'],
      ['translationProvider', 'google'],
      ['improvementProvider', 'none'],
      ['localWhisperModel', 'huge'],
      ['sermonTranslationProvider', 'none'], // sermon mode never offers "none"
      ['sermonCorrectionProvider', 'none'],
      ['sermonBibleVersion', 'NIV'],
      ['sermonScriptureFallback', 'esv'],
    ] as const)('%s = %j', (key, bad) => {
      expect(load({ [key]: bad })[key]).toBe(defaultSettings[key]);
    });
  });

  describe('numbers are clamped into range', () => {
    it.each([
      ['vadSilenceThresholdMs', 5, 200],
      ['vadSilenceThresholdMs', 99_999, 2000],
      ['audioNormalizationGain', 0, 0.1],
      ['audioNormalizationGain', 50, 10],
      ['assemblyEndOfTurnThreshold', 0.1, 0.5],
      ['assemblyEndOfTurnThreshold', 3, 1],
      ['assemblyTurnSilenceMs', 10, 200],
      ['sermonMaxLatencySecs', 1, 3],
      ['sermonMaxLatencySecs', 100, 20],
      ['sermonStabilityMs', 0, 300],
      ['sermonStabilityMs', 99_999, 5000],
      ['sermonBackTranslationThreshold', 0, 0.05],
      ['sermonBackTranslationThreshold', 5, 0.6],
    ] as const)('%s %j -> %j', (key, value, expected) => {
      expect(load({ [key]: value })[key]).toBe(expected);
    });

    it('rounds the context-sentence counts before clamping', () => {
      expect(load({ sermonContextBefore: 2.6 }).sermonContextBefore).toBe(3);
      expect(load({ sermonContextBefore: 9 }).sermonContextBefore).toBe(5);
      expect(load({ sermonContextBefore: -2 }).sermonContextBefore).toBe(0);
      expect(load({ sermonContextAfter: 9 }).sermonContextAfter).toBe(3);
    });

    it.each(['12', null, true, {}, undefined])('a non-number (%j) becomes the default', (bad) => {
      const s = load({ sermonMaxLatencySecs: bad, audioNormalizationGain: bad, sermonContextAfter: bad });
      expect(s.sermonMaxLatencySecs).toBe(defaultSettings.sermonMaxLatencySecs);
      expect(s.audioNormalizationGain).toBe(defaultSettings.audioNormalizationGain);
      expect(s.sermonContextAfter).toBe(defaultSettings.sermonContextAfter);
    });
  });

  it('only accepts the three overlap values', () => {
    expect(load({ chunkOverlapMs: 500 }).chunkOverlapMs).toBe(500);
    expect(load({ chunkOverlapMs: 750 }).chunkOverlapMs).toBe(defaultSettings.chunkOverlapMs);
  });

  it('Improve lookback must be a number of at least 100', () => {
    expect(load({ defaultLookbackChars: 99 }).defaultLookbackChars).toBe(defaultSettings.defaultLookbackChars);
    expect(load({ defaultLookbackChars: '500' }).defaultLookbackChars).toBe(defaultSettings.defaultLookbackChars);
    expect(load({ defaultLookbackChars: 5000 }).defaultLookbackChars).toBe(5000); // no upper bound
  });

  it('booleans must be booleans', () => {
    const s = load({ sermonAutoTranslate: 'yes', sermonAsrCorrection: 0, sermonDeityCapitals: true });
    expect(s.sermonAutoTranslate).toBe(defaultSettings.sermonAutoTranslate);
    expect(s.sermonAsrCorrection).toBe(defaultSettings.sermonAsrCorrection);
    expect(s.sermonDeityCapitals).toBe(true);
  });

  describe('strings', () => {
    it('micDeviceId must be a string of at most 512 characters', () => {
      expect(load({ micDeviceId: 'abc' }).micDeviceId).toBe('abc');
      expect(load({ micDeviceId: 5 }).micDeviceId).toBe(defaultSettings.micDeviceId);
      expect(load({ micDeviceId: 'x'.repeat(513) }).micDeviceId).toBe(defaultSettings.micDeviceId);
    });

    it('sermonModel must be non-blank and at most 80 characters', () => {
      expect(load({ sermonModel: 'gpt-4o' }).sermonModel).toBe('gpt-4o');
      expect(load({ sermonModel: '   ' }).sermonModel).toBe(defaultSettings.sermonModel);
      expect(load({ sermonModel: 'm'.repeat(81) }).sermonModel).toBe(defaultSettings.sermonModel);
    });

    it('esvApiKey must be a string', () => {
      expect(load({ esvApiKey: 7 }).esvApiKey).toBe('');
    });
  });

  describe('glossary filenames (client-side guard; the server checks again)', () => {
    it.each([
      ['sermonGlossaryCsv', 'mijn-lijst.csv', true],
      ['sermonGlossaryCsv', 'LIJST.CSV', true],
      ['sermonGlossaryCsv', 'sub/lijst.csv', false],
      ['sermonGlossaryCsv', '..\\lijst.csv', false],
      ['sermonGlossaryCsv', '../lijst.csv', false],
      ['sermonGlossaryCsv', 'lijst.md', false],
      ['sermonGlossaryCsv', '', false],
      ['sermonGlossaryCsv', `${'a'.repeat(125)}.csv`, false], // > 128 chars
      ['sermonDisambiguationPrompt', 'regels.md', true],
      ['sermonDisambiguationPrompt', 'regels.csv', false],
    ] as const)('%s = %j accepted: %s', (key, value, accepted) => {
      expect(load({ [key]: value })[key]).toBe(accepted ? value : defaultSettings[key]);
    });
  });

  it('deviceProfiles must be an array', () => {
    expect(load({ deviceProfiles: 'nope' }).deviceProfiles).toEqual([]);
    expect(load({ deviceProfiles: [{ id: 'a' }] }).deviceProfiles).toEqual([{ id: 'a' }]);
  });

  it('normalizes the service context (strings only, length-capped)', () => {
    const s = load({ sermonServiceContext: { title: 'Preek', passages: 42, notes: 'n'.repeat(5000) } });
    expect(s.sermonServiceContext.title).toBe('Preek');
    expect(s.sermonServiceContext.passages).toBe('');
    expect(s.sermonServiceContext.notes.length).toBe(2000);
    expect(load({ sermonServiceContext: 'garbage' }).sermonServiceContext).toEqual({ title: '', passages: '', terms: '', notes: '' });
  });

  it('does not mutate its input', () => {
    const input = { ...defaultSettings, sermonMaxLatencySecs: 999 } as AppSettings;
    sanitizeSettings(input, defaultSettings);
    expect(input.sermonMaxLatencySecs).toBe(999);
  });
});

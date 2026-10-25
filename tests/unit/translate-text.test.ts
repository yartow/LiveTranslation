import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { translateRecognizedText, type TranslateTextConfig } from '../../client/src/lib/translate-text';

const config: TranslateTextConfig = {
  targetLanguage: 'nl',
  detectSpeakers: false,
  translationProvider: 'openai',
  openaiApiKey: 'ok',
  anthropicApiKey: '',
  glossary: 'Genade',
  sermonContext: 'Romeinen 8',
};

const fetchMock = vi.fn();
const events = { onTranslation: vi.fn(), onError: vi.fn() };

beforeEach(() => {
  fetchMock.mockReset();
  events.onTranslation.mockReset();
  events.onError.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('translateRecognizedText', () => {
  it('provider "none" reports the text untranslated without calling the server', async () => {
    await translateRecognizedText('hello', 4, { ...config, translationProvider: 'none' }, events);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.onTranslation).toHaveBeenCalledWith('hello', '', 4);
  });

  it('posts the text with glossary and service context, then reports the result', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ correctedText: 'Hello.', translatedText: 'Hallo.' }) });
    await translateRecognizedText('hello', 2, config, events);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/translate');
    expect(JSON.parse(init.body)).toEqual({
      text: 'hello',
      targetLanguage: 'nl',
      detectSpeakers: false,
      translationProvider: 'openai',
      openaiApiKey: 'ok',
      anthropicApiKey: '',
      glossary: 'Genade',
      sermonContext: 'Romeinen 8',
    });
    expect(events.onTranslation).toHaveBeenCalledWith('Hello.', 'Hallo.', 2);
    expect(events.onError).not.toHaveBeenCalled();
  });

  it('leaves out an empty glossary and context', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
    await translateRecognizedText('hello', 0, { ...config, glossary: '', sermonContext: '' }, events);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect('glossary' in body).toBe(false);
    expect('sermonContext' in body).toBe(false);
    // an empty reply falls back to the recognized text
    expect(events.onTranslation).toHaveBeenCalledWith('hello', '', 0);
  });

  it('a failed request still reports the text, plus an error', async () => {
    fetchMock.mockResolvedValue({ ok: false });
    await translateRecognizedText('hello', 1, config, events);
    expect(events.onError).toHaveBeenCalledWith('Translation request failed');
    expect(events.onTranslation).toHaveBeenCalledWith('hello', '', 1);
  });

  it('a network failure still reports the text, plus an error', async () => {
    fetchMock.mockRejectedValue(new Error('offline'));
    await translateRecognizedText('hello', 1, config, events);
    expect(events.onError).toHaveBeenCalledWith('Translation failed — check your API key in Settings.');
    expect(events.onTranslation).toHaveBeenCalledWith('hello', '', 1);
  });
});

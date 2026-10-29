import express from 'express';
import type { Express, Request, Response, NextFunction } from 'express';
import { createServer, type Server } from 'http';
import { storage } from './storage';
import multer from 'multer';
import {
  transcribeAudio,
  correctAndTranslateText,
  retroactiveCorrection,
  formatForExport,
} from './lib/openai';
import { correctAndTranslateWithClaude, retroactiveCorrectionWithClaude } from './lib/anthropic';
import { correctAndTranslateWithOllama, retroactiveCorrectionWithOllama, isValidOllamaBaseUrl, DEFAULT_OLLAMA_BASE_URL, DEFAULT_OLLAMA_MODEL } from './lib/ollama';
import { transcribeWithMlx } from './lib/mlx-whisper';
import { isAsrArtifact, stripAsrArtifacts } from './lib/asr-artifacts';
import { translateSegments, type TranslateItemResult, type SermonTranslationProvider } from './lib/sermon-translate';
import { parseSermonItems } from './lib/sermon-items';
import { parseCorrectionExamples } from './lib/sermon-prompt';
import { addToGlossary } from './lib/glossary-add';
import { applyLearnedCorrections } from './lib/asr-corrections';
import { getInputVolume, setInputVolume, isValidInputVolume } from './lib/mac-input-volume';
import { isOperatorRequest, isLoopbackAddress } from './lib/loopback';
import { getGlossaryStatus, reloadGlossary } from './lib/glossary-store';
import { isSafeGlossaryName } from './lib/glossary-file';
import { archiveEnabled, getCurrentArchiveDir } from './lib/chunk-transcription';
import { appendToArchive, logTranslation } from './lib/session-archive';
import { join as joinPath } from 'path';
import fs from 'fs';
import os from 'os';
import ffmpeg from 'fluent-ffmpeg';

const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 25 * 1024 * 1024 },
});

const VALID_TRANSLATION_PROVIDERS = new Set(['openai', 'claude', 'ollama', 'none']);
type TranslationProvider = 'openai' | 'claude' | 'ollama' | 'none';

// Simple per-IP rate limiter: 60 requests per minute on translation endpoints.
interface RateBucket { count: number; resetAt: number }
const rateBuckets = new Map<string, RateBucket>();
const RATE_LIMIT = 60;
const RATE_WINDOW_MS = 60_000;

function rateLimiter(req: Request, res: Response, next: NextFunction): void {
  const ip = (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim()
    ?? req.socket.remoteAddress
    ?? 'unknown';
  const now = Date.now();
  const bucket = rateBuckets.get(ip);

  if (!bucket || now >= bucket.resetAt) {
    rateBuckets.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return next();
  }

  bucket.count++;
  if (bucket.count > RATE_LIMIT) {
    res.status(429).json({ error: 'Rate limit exceeded. Please slow down.' });
    return;
  }
  next();
}

// Route translation/correction to the appropriate provider.
// Falls back to OpenAI if no provider is specified.
async function runCorrectAndTranslate(
  text: string,
  targetLanguage: string,
  detectSpeakers: boolean,
  provider: TranslationProvider,
  openaiApiKey?: string,
  anthropicApiKey?: string,
  glossary?: string,
  sermonContext?: string,
  ollamaModel?: string,
  ollamaBaseUrl?: string,
): Promise<{ correctedText: string; translatedText: string }> {
  if (provider === 'claude') {
    return correctAndTranslateWithClaude(text, targetLanguage, detectSpeakers, anthropicApiKey || '', glossary, sermonContext);
  }
  if (provider === 'ollama') {
    return correctAndTranslateWithOllama(text, targetLanguage, detectSpeakers, ollamaModel || DEFAULT_OLLAMA_MODEL, ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL, glossary, sermonContext);
  }
  if (provider === 'none') {
    return { correctedText: text, translatedText: '' };
  }
  return correctAndTranslateText(text, targetLanguage, detectSpeakers, openaiApiKey, glossary, sermonContext);
}

async function runRetroactiveCorrection(
  accumulatedText: string,
  targetLanguage: string,
  detectSpeakers: boolean,
  provider: TranslationProvider,
  openaiApiKey?: string,
  anthropicApiKey?: string,
  glossary?: string,
  sermonContext?: string,
  ollamaModel?: string,
  ollamaBaseUrl?: string,
): Promise<{ correctedText: string; translatedText: string }> {
  if (provider === 'claude') {
    return retroactiveCorrectionWithClaude(accumulatedText, targetLanguage, detectSpeakers, anthropicApiKey || '', glossary, sermonContext);
  }
  if (provider === 'ollama') {
    return retroactiveCorrectionWithOllama(accumulatedText, targetLanguage, detectSpeakers, ollamaModel || DEFAULT_OLLAMA_MODEL, ollamaBaseUrl || DEFAULT_OLLAMA_BASE_URL, glossary, sermonContext);
  }
  if (provider === 'none') {
    return { correctedText: accumulatedText, translatedText: '' };
  }
  return retroactiveCorrection(accumulatedText, targetLanguage, detectSpeakers, openaiApiKey, glossary, sermonContext);
}

// SSRF guard shared by every route that accepts a client-supplied
// ollamaBaseUrl — see ollama.ts's isValidOllamaBaseUrl for why this must be
// restricted to loopback. Absent/empty is fine (the callee falls back to the
// default); present-and-invalid is a 400, never silently ignored or passed
// through to a server-side HTTP client.
function isBadOllamaBaseUrl(value: unknown): boolean {
  return typeof value === 'string' && value.trim() !== '' && !isValidOllamaBaseUrl(value);
}

function parseProvider(value: unknown): TranslationProvider | null {
  if (typeof value === 'string' && VALID_TRANSLATION_PROVIDERS.has(value)) {
    return value as TranslationProvider;
  }
  return null;
}

// Sermon mode never accepts 'none' — a correction/translation call is always
// required (see client/src/hooks/useSettings.ts's SermonTranslationProvider).
const VALID_SERMON_TRANSLATION_PROVIDERS = new Set(['openai', 'claude', 'ollama']);
const VALID_BIBLE_VERSIONS = new Set(['KJV', 'ESV', 'LSB', 'NASB', 'NKJV']);
// null = absent (caller should fall back to the server default selection);
// 'invalid' = present but structurally unsafe — the caller must 400. Kept
// separate from throwing so a malicious/malformed name never even reaches
// isSafeGlossaryName's fs-touching sibling resolveGlossaryPath().
function parseGlossaryName(value: unknown, kind: 'csv' | 'md'): string | null | 'invalid' {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !isSafeGlossaryName(value, kind)) return 'invalid';
  return value;
}

export async function registerRoutes(app: Express): Promise<Server> {

  // Legacy file-upload transcription endpoint (used by tests / direct API consumers)
  app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
    let webmFilePath: string | null = null;
    let mp3FilePath: string | null = null;

    try {
      if (!req.file) {
        return res.status(400).json({ error: 'No audio file provided' });
      }

      const sourceLanguage = req.body.sourceLanguage || 'en';
      const targetLanguage = req.body.targetLanguage || 'en';
      const detectSpeakers = req.body.detectSpeakers === 'true';
      const provider = parseProvider(req.body.translationProvider) ?? 'openai';
      const openaiApiKey = req.body.openaiApiKey || undefined;
      const anthropicApiKey = req.body.anthropicApiKey || undefined;
      const previousTranscript = typeof req.body.previousTranscript === 'string' ? req.body.previousTranscript : undefined;
      // Optional: route transcription to the local MLX engine instead of OpenAI Whisper.
      // Used by the WER benchmark harness to compare engines on the same fixtures.
      const engine = req.body.engine === 'mlx' ? 'mlx' : 'openai';

      // Keep the original extension so ffmpeg can auto-detect the format.
      const originalExt = req.file.originalname.match(/\.[^.]+$/)?.[0]?.toLowerCase() ?? '.bin';
      const safeExt = /^\.[a-z0-9]{1,6}$/.test(originalExt) ? originalExt : '.bin';
      webmFilePath = req.file.path + safeExt;
      mp3FilePath = req.file.path + '.mp3';

      fs.renameSync(req.file.path, webmFilePath);

      const fileStats = fs.statSync(webmFilePath);
      if (fileStats.size === 0) throw new Error('Audio file is empty');

      await new Promise<void>((resolve, reject) => {
        ffmpeg(webmFilePath!)
          .inputOptions([
            '-err_detect', 'ignore_err',
            '-fflags', '+genpts+igndts+ignidx+discardcorrupt',
            '-analyzeduration', '0',
            '-probesize', '32',
            '-max_error_rate', '1.0',
          ])
          .toFormat('mp3')
          .audioCodec('libmp3lame')
          .audioBitrate('128k')
          .audioChannels(1)
          .audioFrequency(16000)
          .outputOptions(['-write_xing', '0', '-id3v2_version', '0'])
          .on('end', () => resolve())
          .on('error', (err, _stdout, stderr) => {
            console.error('FFmpeg error:', err.message, stderr);
            reject(new Error(`Audio conversion failed: ${err.message}`));
          })
          .save(mp3FilePath!);
      });

      const rawTranscript = engine === 'mlx'
        ? await transcribeWithMlx(mp3FilePath, sourceLanguage, previousTranscript)
        : await transcribeAudio(mp3FilePath, sourceLanguage, openaiApiKey, undefined, undefined, undefined, previousTranscript);

      // Whisper caption hallucination ("MUZIEK", "***", foreign-script
      // garbage) during silence/noise — see server/lib/asr-artifacts.ts.
      // This endpoint is a separate code path from the WebSocket chunk
      // pipeline (server/lib/chunk-transcription.ts) and shares none of its
      // filtering, so it needs its own check rather than inheriting one.
      const cleanedTranscript = isAsrArtifact(rawTranscript, sourceLanguage)
        ? ''
        : applyLearnedCorrections(stripAsrArtifacts(rawTranscript, sourceLanguage));
      const { correctedText, translatedText } = !cleanedTranscript
        ? { correctedText: '', translatedText: '' }
        : await runCorrectAndTranslate(
          cleanedTranscript, targetLanguage, detectSpeakers, provider, openaiApiKey, anthropicApiKey,
        );

      if (webmFilePath && fs.existsSync(webmFilePath)) fs.unlinkSync(webmFilePath);
      if (mp3FilePath && fs.existsSync(mp3FilePath)) fs.unlinkSync(mp3FilePath);

      res.json({ originalText: correctedText, translatedText });
    } catch (error) {
      console.error('Transcription error:', error);
      if (webmFilePath && fs.existsSync(webmFilePath)) fs.unlinkSync(webmFilePath);
      if (mp3FilePath && fs.existsSync(mp3FilePath)) fs.unlinkSync(mp3FilePath);
      if (req.file?.path && fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
      res.status(500).json({
        error: 'Failed to transcribe audio',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Text-only translation — used by browser SpeechRecognition mode, re-translation
  // and the "Improve" button. The three routes differ only in the name of the
  // text field, the provider call and the error wording.
  const textTranslationRoute = (
    textField: 'text' | 'originalText' | 'accumulatedText',
    run: typeof runCorrectAndTranslate,
    logLabel: string,
    failureMessage: string,
  ) => async (req: Request, res: Response) => {
    try {
      const { targetLanguage, detectSpeakers, translationProvider, openaiApiKey, anthropicApiKey, glossary, sermonContext, ollamaModel, ollamaBaseUrl } = req.body;
      const text = req.body[textField];

      if (!text) return res.status(400).json({ error: 'No text provided' });

      const provider = parseProvider(translationProvider);
      if (!provider) return res.status(400).json({ error: 'Invalid translationProvider' });
      if (isBadOllamaBaseUrl(ollamaBaseUrl)) return res.status(400).json({ error: 'Invalid ollamaBaseUrl' });

      const { correctedText, translatedText } = await run(
        text,
        targetLanguage || 'nl',
        detectSpeakers ?? false,
        provider,
        openaiApiKey || undefined,
        anthropicApiKey || undefined,
        glossary || undefined,
        sermonContext || undefined,
        ollamaModel || undefined,
        ollamaBaseUrl || undefined,
      );

      res.json({ correctedText, translatedText });
    } catch (error) {
      console.error(`${logLabel}:`, error);
      res.status(500).json({
        error: failureMessage,
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  };

  app.post('/api/translate', rateLimiter,
    textTranslationRoute('text', runCorrectAndTranslate, 'Translation error', 'Failed to translate text'));
  app.post('/api/retranslate', rateLimiter,
    textTranslationRoute('originalText', runCorrectAndTranslate, 'Re-translation error', 'Failed to re-translate text'));
  app.post('/api/retroactive-correct', rateLimiter,
    textTranslationRoute('accumulatedText', runRetroactiveCorrection, 'Retroactive correction error', 'Failed to perform retroactive correction'));

  // Sermon mode: translate a batch of dirty segments in one request (see
  // client/src/hooks/useTranslationQueue.ts). Deliberately batched rather
  // than one call per segment — the rateLimiter below is shared with the
  // other translation endpoints, and a client-side fan-out of dozens of
  // dirty segments after a bulk edit would trip it immediately.
  app.post('/api/sermon/translate', rateLimiter, async (req, res) => {
    try {
      const {
        targetLanguage, translationProvider, model,
        openaiApiKey, anthropicApiKey, ollamaBaseUrl, ollamaModel,
        glossary, items, serviceContext, examples, backTranslationCheck, backTranslationThreshold,
        glossaryCsv, disambiguationPrompt, bibleVersion, deityCapitals, glossaryWarnings,
        scriptureEnabled, esvApiKey, scriptureFallback,
      } = req.body;

      if (typeof translationProvider !== 'string' || !VALID_SERMON_TRANSLATION_PROVIDERS.has(translationProvider)) {
        return res.status(400).json({ error: 'Invalid translationProvider — must be openai, claude, or ollama' });
      }
      if (isBadOllamaBaseUrl(ollamaBaseUrl)) {
        return res.status(400).json({ error: 'Invalid ollamaBaseUrl' });
      }
      const parsedItems = parseSermonItems(items);
      if (!parsedItems) {
        return res.status(400).json({
          error: 'Invalid items — expected a non-empty array of at most 100 { id, text, before?, after?, readingCandidate?, referenceHint? } objects',
        });
      }
      const parsedGlossaryCsv = parseGlossaryName(glossaryCsv, 'csv');
      if (parsedGlossaryCsv === 'invalid') {
        return res.status(400).json({ error: 'Invalid glossaryCsv — must be a plain filename ending in .csv' });
      }
      const parsedDisambiguationPrompt = parseGlossaryName(disambiguationPrompt, 'md');
      if (parsedDisambiguationPrompt === 'invalid') {
        return res.status(400).json({ error: 'Invalid disambiguationPrompt — must be a plain filename ending in .md' });
      }
      if (scriptureFallback !== undefined && scriptureFallback !== 'kjv' && scriptureFallback !== 'none') {
        return res.status(400).json({ error: 'Invalid scriptureFallback — must be "kjv" or "none"' });
      }

      // Aborts in-flight provider calls if the client disconnects (e.g. the
      // translator navigates away mid-Refresh) rather than leaking them.
      // Deliberately on `res`, not `req`: IncomingMessage is a Readable
      // stream with emitClose:true, so req's 'close' fires the instant
      // express.json() finishes reading the body — almost immediately,
      // long before the response is written — which aborted every single
      // call here. res only closes prematurely on a real client
      // disconnect; writableEnded guards against the normal post-response
      // 'close' that always follows a successful res.json() below.
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      const translated = await translateSegments(parsedItems.items, {
        targetLanguage: targetLanguage || 'en',
        translationProvider: translationProvider as SermonTranslationProvider,
        model: model || undefined,
        openaiApiKey: openaiApiKey || undefined,
        anthropicApiKey: anthropicApiKey || undefined,
        ollamaBaseUrl: ollamaBaseUrl || undefined,
        ollamaModel: ollamaModel || undefined,
        glossaryOverride: glossary || undefined,
        serviceContext: typeof serviceContext === 'string' ? serviceContext.slice(0, 8000) : undefined, // buildServiceContextBlock applies the real cap
        examples: parseCorrectionExamples(examples),
        backTranslationCheck: backTranslationCheck === true,
        backTranslationThreshold: typeof backTranslationThreshold === 'number' && backTranslationThreshold > 0 && backTranslationThreshold < 1 ? backTranslationThreshold : undefined,
        glossaryCsv: parsedGlossaryCsv || undefined,
        disambiguationPrompt: parsedDisambiguationPrompt || undefined,
        bibleVersion: VALID_BIBLE_VERSIONS.has(bibleVersion) ? bibleVersion : undefined,
        deityCapitals: deityCapitals === true,
        glossaryWarningsEnabled: glossaryWarnings !== false,
        scriptureEnabled: scriptureEnabled !== false,
        esvApiKey: esvApiKey || undefined,
        scriptureFallback: scriptureFallback === 'none' ? 'none' : 'kjv',
        signal: controller.signal,
      }, { log: logTranslation });

      // A blank cell fails alone instead of taking the whole batch down with a 400.
      const blank: TranslateItemResult[] = parsedItems.blankIds.map(id => ({ id, status: 'error', error: 'Nothing to translate — the source text is empty' }));
      res.json({ results: [...translated, ...blank] });
    } catch (error) {
      console.error('Sermon translate error:', error);
      res.status(500).json({
        error: 'Failed to translate sermon segments',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Glossary status/reload — both use the same response shape. A missing or
  // corrupt glossary is a normal 200 with loaded:false, NOT a 400/500: the
  // app must keep working (translating without a glossary) rather than
  // treat an absent file as an error. 400 is reserved for a structurally
  // unsafe filename, which is rejected before any filesystem access.
  app.get('/api/sermon/glossary/status', rateLimiter, (req, res) => {
    try {
      const csv = parseGlossaryName(req.query.csv, 'csv');
      if (csv === 'invalid') return res.status(400).json({ error: 'Invalid csv — must be a plain filename ending in .csv' });
      const prompt = parseGlossaryName(req.query.prompt, 'md');
      if (prompt === 'invalid') return res.status(400).json({ error: 'Invalid prompt — must be a plain filename ending in .md' });

      // GlossaryDiagnostics only ever carries basenames (see glossary-store.ts),
      // never resolved/absolute paths, so this is safe to return unconditionally.
      res.json(getGlossaryStatus({ csv: csv || undefined, prompt: prompt || undefined }));
    } catch (error) {
      console.error('Sermon glossary status error:', error);
      res.status(500).json({ error: 'Failed to read glossary status', details: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  // Operator-only: appends one term to the selected glossary CSV and/or the
  // ASR corrections file (server/lib/glossary-add.ts). Loopback-only like the
  // mic-volume endpoints — it writes into GLOSSARY_DIR, so another device on
  // the LAN must not be able to reach it (unless ALLOW_REMOTE_OPERATOR=true).
  app.post('/api/sermon/glossary/add', rateLimiter, (req, res) => {
    if (!isOperatorRequest(req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'Only available from the operator machine' });
    }
    const { csv, heard, dutch, english, category, force } = req.body ?? {};
    const parsedCsv = parseGlossaryName(csv, 'csv');
    if (parsedCsv === 'invalid' || parsedCsv === null) {
      return res.status(400).json({ error: 'Invalid csv — must be a plain filename ending in .csv' });
    }
    const result = addToGlossary({
      csv: parsedCsv,
      heard: typeof heard === 'string' ? heard : undefined,
      dutch: typeof dutch === 'string' ? dutch : '',
      english: typeof english === 'string' ? english : undefined,
      category: typeof category === 'string' ? category : undefined,
      force: force === true,
    });
    if (!result.ok) {
      return res.status(result.status).json({ error: result.error, existingEnglish: result.existingEnglish });
    }
    reloadGlossary({ csv: parsedCsv });
    res.json({ ok: true, glossaryRowAdded: result.glossaryRowAdded, correctionAdded: result.correctionAdded });
  });

  // macOS system input volume (see server/lib/mac-input-volume.ts). Operator
  // machine only: it changes the Mac's actual microphone gain.
  app.get('/api/mac/input-volume', async (req, res) => {
    if (!isOperatorRequest(req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'Only available from the operator machine' });
    }
    res.json(await getInputVolume());
  });

  app.put('/api/mac/input-volume', rateLimiter, async (req, res) => {
    if (!isOperatorRequest(req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'Only available from the operator machine' });
    }
    const volume = req.body?.volume;
    if (!isValidInputVolume(volume)) {
      return res.status(400).json({ error: 'volume must be an integer from 0 to 100' });
    }
    res.json(await setInputVolume(volume));
  });

  app.post('/api/sermon/glossary/reload', rateLimiter, (req, res) => {
    try {
      const { csv, prompt } = req.body ?? {};
      const parsedCsv = parseGlossaryName(csv, 'csv');
      if (parsedCsv === 'invalid') return res.status(400).json({ error: 'Invalid csv — must be a plain filename ending in .csv' });
      const parsedPrompt = parseGlossaryName(prompt, 'md');
      if (parsedPrompt === 'invalid') return res.status(400).json({ error: 'Invalid prompt — must be a plain filename ending in .md' });

      const selection = { csv: parsedCsv || undefined, prompt: parsedPrompt || undefined };
      reloadGlossary(selection);
      res.json(getGlossaryStatus(selection));
    } catch (error) {
      console.error('Sermon glossary reload error:', error);
      res.status(500).json({ error: 'Failed to reload glossary', details: error instanceof Error ? error.message : 'Unknown error' });
    }
  });

  app.post('/api/export-format', async (req, res) => {
    try {
      const { originalText, translatedText, targetLanguage, exportType, fileFormat, openaiApiKey } = req.body;

      if (!originalText && !translatedText) {
        return res.status(400).json({ error: 'No text provided' });
      }

      const formattedContent = await formatForExport(
        originalText || '',
        translatedText || '',
        targetLanguage,
        exportType,
        fileFormat,
        openaiApiKey || undefined,
      );

      res.json({ formattedContent });
    } catch (error) {
      console.error('Export formatting error:', error);
      res.status(500).json({
        error: 'Failed to format export',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  // Session archive (ASR_DEBUG_DIR — see server/lib/chunk-transcription.ts). The sermon page
  // asks whether it is on, then posts its on-screen segments so a transcript gap can be traced
  // to the stage that lost it. text/plain because the global JSON parser caps bodies at 100 KB,
  // which a whole sermon's segments exceed.
  app.get('/api/asr-debug/status', (_req, res) => {
    res.json({ enabled: archiveEnabled(), dir: getCurrentArchiveDir() });
  });

  app.post('/api/asr-debug/transcript', express.text({ type: '*/*', limit: '20mb' }), (req, res) => {
    const dir = getCurrentArchiveDir();
    if (!archiveEnabled() || !dir) return res.status(404).json({ error: 'archive not active' });
    if (typeof req.body !== 'string' || !req.body) return res.status(400).json({ error: 'empty body' });
    fs.writeFile(joinPath(dir, 'transcript.json'), req.body, (err) => {
      if (err) return res.status(500).json({ error: 'write failed' });
      res.json({ ok: true });
    });
  });

  // Session archive extras: the page batches the operator's edits and its own errors and posts
  // them as JSON lines. Each line is parsed and re-serialised so the .jsonl files stay well-formed;
  // text/plain for the same reason as /transcript above. Operator-only, like the other writers.
  const archiveLines = (fileName: string) => [
    express.text({ type: '*/*', limit: '2mb' }),
    (req: Request, res: Response) => {
      if (!isOperatorRequest(req.socket.remoteAddress)) return res.status(403).json({ error: 'Only available to the operator' });
      if (!archiveEnabled() || !getCurrentArchiveDir()) return res.status(404).json({ error: 'archive not active' });
      if (typeof req.body !== 'string' || !req.body) return res.status(400).json({ error: 'empty body' });
      const lines: string[] = [];
      for (const line of req.body.split('\n')) {
        if (!line.trim()) continue;
        try { lines.push(JSON.stringify(JSON.parse(line))); } catch { /* drop a malformed line */ }
      }
      if (lines.length) appendToArchive(fileName, lines.join('\n') + '\n');
      res.json({ ok: true, lines: lines.length });
    },
  ];
  app.post('/api/asr-debug/edit-log', ...archiveLines('edits.jsonl'));
  app.post('/api/asr-debug/client-log', ...archiveLines('client-errors.jsonl'));

  // Listener mode (CLAUDE.md "Listener mode"): the address(es) the operator
  // reads out to the congregation, shown in SermonToolbar's "Luisteraars"
  // popover. The MBP's LAN IP changes with the network (home vs. church), so
  // this is looked up live rather than baked into a QR code or config value.
  // Not a secret — same non-auth posture as the rest of listener mode.
  app.get('/api/lan-address', (req, res) => {
    const port = process.env.PORT || '5001';
    const addresses: string[] = [];
    for (const iface of Object.values(os.networkInterfaces())) {
      for (const addr of iface ?? []) {
        if (addr.family === 'IPv4' && !addr.internal) addresses.push(addr.address);
      }
    }
    res.json({ addresses, port });
  });

  // Dev-only: expose server-side API keys so the browser can auto-fill them.
  // Returns 403 in production so keys are never leaked in deployed builds,
  // and also 403s any non-loopback caller even in development — a dev server
  // reachable from the LAN (e.g. listener-mode testing, see CLAUDE.md) must
  // not hand its API keys to anyone else on the network.
  app.get('/api/dev-config', (req, res) => {
    if (process.env.NODE_ENV !== 'development') {
      return res.status(403).json({ error: 'Not available in production' });
    }
    if (!isLoopbackAddress(req.socket.remoteAddress)) {
      return res.status(403).json({ error: 'Only available to local requests' });
    }
    res.json({
      openaiApiKey: process.env.OPENAI_API_KEY || '',
      anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
      esvApiKey: process.env.ESV_API_KEY || '',
    });
  });

  const httpServer = createServer(app);
  return httpServer;
}

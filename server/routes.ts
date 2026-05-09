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
import { uploadFileToDrive, listDriveFolders } from './lib/google-drive';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';

const upload = multer({
  dest: '/tmp/uploads/',
  limits: { fileSize: 25 * 1024 * 1024 },
});

const VALID_TRANSLATION_PROVIDERS = new Set(['openai', 'claude', 'none']);
type TranslationProvider = 'openai' | 'claude' | 'none';

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
): Promise<{ correctedText: string; translatedText: string }> {
  if (provider === 'claude') {
    return correctAndTranslateWithClaude(text, targetLanguage, detectSpeakers, anthropicApiKey || '', glossary, sermonContext);
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
): Promise<{ correctedText: string; translatedText: string }> {
  if (provider === 'claude') {
    return retroactiveCorrectionWithClaude(accumulatedText, targetLanguage, detectSpeakers, anthropicApiKey || '', glossary, sermonContext);
  }
  if (provider === 'none') {
    return { correctedText: accumulatedText, translatedText: '' };
  }
  return retroactiveCorrection(accumulatedText, targetLanguage, detectSpeakers, openaiApiKey, glossary, sermonContext);
}

function parseProvider(value: unknown): TranslationProvider | null {
  if (typeof value === 'string' && VALID_TRANSLATION_PROVIDERS.has(value)) {
    return value as TranslationProvider;
  }
  return null;
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

      webmFilePath = req.file.path + '.webm';
      mp3FilePath = req.file.path + '.mp3';

      fs.renameSync(req.file.path, webmFilePath);

      const fileStats = fs.statSync(webmFilePath);
      if (fileStats.size === 0) throw new Error('Audio file is empty');

      await new Promise<void>((resolve, reject) => {
        ffmpeg(webmFilePath!)
          .inputFormat('webm')
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

      const rawTranscript = await transcribeAudio(mp3FilePath, sourceLanguage, openaiApiKey);
      const { correctedText, translatedText } = await runCorrectAndTranslate(
        rawTranscript, targetLanguage, detectSpeakers, provider, openaiApiKey, anthropicApiKey,
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

  // Text-only translation — used by browser SpeechRecognition mode and re-translation
  app.post('/api/translate', rateLimiter, async (req, res) => {
    try {
      const { text, targetLanguage, detectSpeakers, translationProvider, openaiApiKey, anthropicApiKey, glossary, sermonContext } = req.body;

      if (!text) return res.status(400).json({ error: 'No text provided' });

      const provider = parseProvider(translationProvider);
      if (!provider) return res.status(400).json({ error: 'Invalid translationProvider' });

      const { correctedText, translatedText } = await runCorrectAndTranslate(
        text,
        targetLanguage || 'nl',
        detectSpeakers ?? false,
        provider,
        openaiApiKey || undefined,
        anthropicApiKey || undefined,
        glossary || undefined,
        sermonContext || undefined,
      );

      res.json({ correctedText, translatedText });
    } catch (error) {
      console.error('Translation error:', error);
      res.status(500).json({
        error: 'Failed to translate text',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  app.post('/api/retranslate', rateLimiter, async (req, res) => {
    try {
      const { originalText, targetLanguage, detectSpeakers, translationProvider, openaiApiKey, anthropicApiKey, glossary, sermonContext } = req.body;

      if (!originalText) return res.status(400).json({ error: 'No text provided' });

      const provider = parseProvider(translationProvider);
      if (!provider) return res.status(400).json({ error: 'Invalid translationProvider' });

      const { correctedText, translatedText } = await runCorrectAndTranslate(
        originalText,
        targetLanguage || 'nl',
        detectSpeakers ?? false,
        provider,
        openaiApiKey || undefined,
        anthropicApiKey || undefined,
        glossary || undefined,
        sermonContext || undefined,
      );

      res.json({ correctedText, translatedText });
    } catch (error) {
      console.error('Re-translation error:', error);
      res.status(500).json({
        error: 'Failed to re-translate text',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  app.post('/api/retroactive-correct', rateLimiter, async (req, res) => {
    try {
      const { accumulatedText, targetLanguage, detectSpeakers, translationProvider, openaiApiKey, anthropicApiKey, glossary, sermonContext } = req.body;

      if (!accumulatedText) return res.status(400).json({ error: 'No text provided' });

      const provider = parseProvider(translationProvider);
      if (!provider) return res.status(400).json({ error: 'Invalid translationProvider' });

      const { correctedText, translatedText } = await runRetroactiveCorrection(
        accumulatedText,
        targetLanguage || 'nl',
        detectSpeakers ?? false,
        provider,
        openaiApiKey || undefined,
        anthropicApiKey || undefined,
        glossary || undefined,
        sermonContext || undefined,
      );

      res.json({ correctedText, translatedText });
    } catch (error) {
      console.error('Retroactive correction error:', error);
      res.status(500).json({
        error: 'Failed to perform retroactive correction',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
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

  app.post('/api/upload-to-drive', async (req, res) => {
    try {
      const { fileName, fileContent, mimeType, folderId } = req.body;

      if (!fileName || !fileContent || typeof fileName !== 'string' || typeof fileContent !== 'string') {
        return res.status(400).json({ error: 'Missing or invalid required fields' });
      }
      if (mimeType && typeof mimeType !== 'string') {
        return res.status(400).json({ error: 'Invalid MIME type' });
      }
      if (fileContent.length > 10 * 1024 * 1024) {
        return res.status(400).json({ error: 'File content too large (max 10MB)' });
      }

      const result = await uploadFileToDrive(fileName, fileContent, mimeType, folderId);
      res.json(result);
    } catch (error) {
      console.error('Google Drive upload error:', error);
      res.status(500).json({
        error: 'Failed to upload to Google Drive',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  app.get('/api/drive-folders', async (req, res) => {
    try {
      const folders = await listDriveFolders();
      res.json({ folders });
    } catch (error) {
      console.error('Google Drive folders error:', error);
      res.status(500).json({
        error: 'Failed to fetch Google Drive folders',
        details: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  });

  const httpServer = createServer(app);
  return httpServer;
}

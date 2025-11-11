import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import { transcribeAudio, correctAndTranslateText } from "./lib/openai";
import fs from "fs";
import path from "path";
import ffmpeg from "fluent-ffmpeg";

const upload = multer({
  dest: "/tmp/uploads/",
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

export async function registerRoutes(app: Express): Promise<Server> {
  app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
    let webmFilePath: string | null = null;
    let wavFilePath: string | null = null;
    
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No audio file provided" });
      }

      const sourceLanguage = req.body.sourceLanguage || "en";
      const targetLanguage = req.body.targetLanguage || "en";

      webmFilePath = req.file.path + '.webm';
      wavFilePath = req.file.path + '.wav';
      
      fs.renameSync(req.file.path, webmFilePath);

      const fileStats = fs.statSync(webmFilePath);
      console.log(`Processing audio file: ${fileStats.size} bytes`);

      if (fileStats.size === 0) {
        throw new Error('Audio file is empty');
      }

      await new Promise<void>((resolve, reject) => {
        ffmpeg(webmFilePath!)
          .inputOptions([
            '-f', 'webm',
            '-fflags', '+genpts+igndts',
            '-err_detect', 'ignore_err',
            '-use_wallclock_as_timestamps', '1'
          ])
          .audioFrequency(16000)
          .audioChannels(1)
          .audioCodec('pcm_s16le')
          .format('wav')
          .outputOptions([
            '-loglevel', 'warning',
            '-y'
          ])
          .on('start', (cmd) => {
            console.log('FFmpeg command:', cmd);
          })
          .on('end', () => {
            console.log('FFmpeg conversion completed');
            resolve();
          })
          .on('error', (err, stdout, stderr) => {
            console.error('FFmpeg error:', err.message);
            console.error('FFmpeg stderr:', stderr);
            reject(err);
          })
          .save(wavFilePath!);
      });

      const rawTranscript = await transcribeAudio(wavFilePath, sourceLanguage);

      const { correctedText, translatedText } = await correctAndTranslateText(
        rawTranscript,
        targetLanguage
      );

      if (webmFilePath && fs.existsSync(webmFilePath)) {
        fs.unlinkSync(webmFilePath);
      }
      if (wavFilePath && fs.existsSync(wavFilePath)) {
        fs.unlinkSync(wavFilePath);
      }

      res.json({
        originalText: correctedText,
        translatedText,
      });
    } catch (error) {
      console.error("Transcription error:", error);
      
      if (webmFilePath && fs.existsSync(webmFilePath)) {
        fs.unlinkSync(webmFilePath);
      }
      if (wavFilePath && fs.existsSync(wavFilePath)) {
        fs.unlinkSync(wavFilePath);
      }
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      res.status(500).json({
        error: "Failed to transcribe audio",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}

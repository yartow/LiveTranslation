import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import { transcribeAudio, correctAndTranslateText } from "./lib/openai";
import fs from "fs";

const upload = multer({
  dest: "/tmp/uploads/",
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
});

export async function registerRoutes(app: Express): Promise<Server> {
  app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
    let webmFilePath: string | null = null;
    
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No audio file provided" });
      }

      const sourceLanguage = req.body.sourceLanguage || "en";
      const targetLanguage = req.body.targetLanguage || "en";
      const detectSpeakers = req.body.detectSpeakers === 'true';

      webmFilePath = req.file.path + '.webm';
      
      fs.renameSync(req.file.path, webmFilePath);

      const fileStats = fs.statSync(webmFilePath);
      console.log(`Processing audio file: ${fileStats.size} bytes`);

      if (fileStats.size === 0) {
        throw new Error('Audio file is empty');
      }

      const rawTranscript = await transcribeAudio(webmFilePath, sourceLanguage);

      const { correctedText, translatedText } = await correctAndTranslateText(
        rawTranscript,
        targetLanguage,
        detectSpeakers
      );

      if (webmFilePath && fs.existsSync(webmFilePath)) {
        fs.unlinkSync(webmFilePath);
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
      if (req.file?.path && fs.existsSync(req.file.path)) {
        fs.unlinkSync(req.file.path);
      }

      res.status(500).json({
        error: "Failed to transcribe audio",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  app.post("/api/retranslate", async (req, res) => {
    try {
      const { originalText, targetLanguage, detectSpeakers } = req.body;

      if (!originalText) {
        return res.status(400).json({ error: "No text provided" });
      }

      const languageNames: Record<string, string> = {
        en: "English",
        es: "Spanish",
        fr: "French",
        de: "German",
        nl: "Dutch",
        pt: "Portuguese",
        it: "Italian",
        zh: "Chinese (Simplified)",
        "zh-TW": "Chinese (Traditional)",
        ar: "Arabic",
        fa: "Farsi",
        hi: "Hindi",
        ru: "Russian",
        ja: "Japanese",
        ko: "Korean",
      };

      const targetLanguageName = languageNames[targetLanguage] || "English";

      const { translatedText } = await correctAndTranslateText(
        originalText,
        targetLanguage,
        detectSpeakers
      );

      res.json({ translatedText });
    } catch (error) {
      console.error("Re-translation error:", error);
      res.status(500).json({
        error: "Failed to re-translate text",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  const httpServer = createServer(app);

  return httpServer;
}

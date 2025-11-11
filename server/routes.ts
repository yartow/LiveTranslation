import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import multer from "multer";
import { transcribeAudio, correctAndTranslateText } from "./lib/openai";
import fs from "fs";
import path from "path";

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
        targetLanguage
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

  const httpServer = createServer(app);

  return httpServer;
}

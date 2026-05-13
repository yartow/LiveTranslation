import { AssemblyAI } from 'assemblyai';
import type { TurnEvent } from 'assemblyai';
import { WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import { correctAndTranslateText } from './openai';

const ASSEMBLYAI_API_KEY = process.env.ASSEMBLYAI_API_KEY;

const client = ASSEMBLYAI_API_KEY
  ? new AssemblyAI({ apiKey: ASSEMBLYAI_API_KEY })
  : null;

interface TranscriptionSession {
  streamingWs: any;
  clientWs: WsWebSocket;
  targetLanguage: string;
  detectSpeakers: boolean;
  finalizedText: string;
  pendingTranslation: string;
  lastTranslationTime: number;
  sentenceCount: number;
  pendingTranslationTimer: NodeJS.Timeout | null;
  debugMode: boolean;
  audioFramesSent: number;
  audioDebugTimer: NodeJS.Timeout | null;
  firstTurnReceived: boolean;
}

const activeSessions = new Map<WsWebSocket, TranscriptionSession>();

const TRANSLATION_DEBOUNCE_MS = 500;

function sendDebug(clientWs: WsWebSocket, message: string, debugMode: boolean): void {
  if (!debugMode || clientWs.readyState !== WsWebSocket.OPEN) return;
  clientWs.send(JSON.stringify({ type: 'debug', message }));
}

function sendError(clientWs: WsWebSocket, message: string): void {
  if (clientWs.readyState !== WsWebSocket.OPEN) return;
  clientWs.send(JSON.stringify({ type: 'error', message }));
}

function countSentences(text: string): number {
  if (!text.trim()) return 0;
  return (text.match(/[.!?]+/g) ?? []).length;
}

async function translateAndSend(session: TranscriptionSession, text: string, isFinal: boolean) {
  if (!text.trim()) return;
  sendDebug(session.clientWs, `Translating: "${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`, session.debugMode);
  try {
    const { correctedText, translatedText } = await correctAndTranslateText(
      text,
      session.targetLanguage,
      session.detectSpeakers,
    );
    if (session.clientWs.readyState === WsWebSocket.OPEN) {
      session.clientWs.send(JSON.stringify({
        type: 'translation',
        original: correctedText,
        translated: translatedText,
        isFinal,
      }));
    }
    sendDebug(session.clientWs, `Translation sent: "${translatedText.slice(0, 60)}${translatedText.length > 60 ? '…' : ''}"`, session.debugMode);

    const newSentenceCount = countSentences(session.finalizedText + text);
    if (newSentenceCount >= 5 && Math.floor(newSentenceCount / 5) > Math.floor(session.sentenceCount / 5)) {
      session.sentenceCount = newSentenceCount;
    }
  } catch (error) {
    console.error('Translation error:', error);
    const msg = error instanceof Error ? error.message : 'Unknown error';
    sendDebug(session.clientWs, `Translation failed: ${msg}`, session.debugMode);
    sendError(session.clientWs, 'Translation failed');
  }
}

function flushPendingTranslation(session: TranscriptionSession) {
  if (session.pendingTranslationTimer) {
    clearTimeout(session.pendingTranslationTimer);
    session.pendingTranslationTimer = null;
  }
  if (session.pendingTranslation) {
    const textToTranslate = session.pendingTranslation;
    session.pendingTranslation = '';
    session.lastTranslationTime = Date.now();
    translateAndSend(session, textToTranslate, true);
  }
}

function schedulePendingTranslation(session: TranscriptionSession) {
  if (session.pendingTranslationTimer) clearTimeout(session.pendingTranslationTimer);
  session.pendingTranslationTimer = setTimeout(() => flushPendingTranslation(session), TRANSLATION_DEBOUNCE_MS);
}

export function setupStreamingWebSocket(wss: WebSocketServer) {
  wss.on('connection', (clientWs: WsWebSocket) => {
    console.log('Client connected for streaming transcription');
    let session: TranscriptionSession | null = null;

    clientWs.on('message', async (data: Buffer | string, isBinary: boolean) => {
      try {
        if (!isBinary) {
          // ws delivers text frames as Buffer on some versions — normalise to string
          const text = Buffer.isBuffer(data) ? (data as Buffer).toString('utf8') : (data as string);
          const message = JSON.parse(text);

          if (message.type === 'start') {
            const debugMode: boolean = message.debugMode ?? false;
            console.log('Starting AssemblyAI streaming session (debug:', debugMode, ')');
            sendDebug(clientWs, 'Server received start — checking AssemblyAI API key…', debugMode);

            if (!client) {
              sendError(clientWs, 'AssemblyAI API key is not configured on the server. Set ASSEMBLYAI_API_KEY in your .env file.');
              sendDebug(clientWs, '✗ ASSEMBLYAI_API_KEY is missing from server environment', debugMode);
              return;
            }

            sendDebug(clientWs, 'Creating AssemblyAI streaming transcriber…', debugMode);

            let streamingWs: any;
            try {
              streamingWs = client.streaming.transcriber({
                sampleRate: 16000,
                keytermsPrompt: ['sermon', 'scripture', 'bible', 'gospel', 'faith', 'prayer', 'amen'],
                formatTurns: true,
              });
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Unknown error';
              sendError(clientWs, `Failed to create AssemblyAI transcriber: ${msg}`);
              sendDebug(clientWs, `✗ Transcriber creation failed: ${msg}`, debugMode);
              return;
            }

            session = {
              streamingWs,
              clientWs,
              targetLanguage: message.targetLanguage || 'nl',
              detectSpeakers: message.detectSpeakers || false,
              finalizedText: '',
              pendingTranslation: '',
              lastTranslationTime: 0,
              sentenceCount: 0,
              pendingTranslationTimer: null,
              debugMode,
              audioFramesSent: 0,
              audioDebugTimer: null,
              firstTurnReceived: false,
            };

            activeSessions.set(clientWs, session);

            streamingWs.on('turn', async (turn: TurnEvent) => {
              if (!session) return;

              const turnText = turn.transcript;

              if (!session.firstTurnReceived && turnText) {
                session.firstTurnReceived = true;
                sendDebug(session.clientWs, '✓ First turn received from AssemblyAI', session.debugMode);
              }

              if (turn.end_of_turn) {
                // Final turn — send as final and trigger translation
                if (turnText) {
                  sendDebug(session.clientWs, `Final turn: "${turnText.slice(0, 60)}${turnText.length > 60 ? '…' : ''}"`, session.debugMode);
                  session.finalizedText += (session.finalizedText ? ' ' : '') + turnText;
                  if (session.clientWs.readyState === WsWebSocket.OPEN) {
                    session.clientWs.send(JSON.stringify({ type: 'final', text: turnText }));
                  }
                  const now = Date.now();
                  if (now - session.lastTranslationTime >= TRANSLATION_DEBOUNCE_MS) {
                    session.lastTranslationTime = now;
                    const textToTranslate = session.pendingTranslation
                      ? session.pendingTranslation + ' ' + turnText
                      : turnText;
                    session.pendingTranslation = '';
                    if (session.pendingTranslationTimer) {
                      clearTimeout(session.pendingTranslationTimer);
                      session.pendingTranslationTimer = null;
                    }
                    translateAndSend(session, textToTranslate, true);
                  } else {
                    session.pendingTranslation += (session.pendingTranslation ? ' ' : '') + turnText;
                    schedulePendingTranslation(session);
                  }
                }
              } else {
                // Partial turn — send live text to UI
                if (turnText && session.clientWs.readyState === WsWebSocket.OPEN) {
                  session.clientWs.send(JSON.stringify({ type: 'partial', text: turnText }));
                }
              }
            });

            streamingWs.on('error', (error: Error) => {
              console.error('AssemblyAI streaming error:', error);
              if (session) {
                sendDebug(session.clientWs, `✗ AssemblyAI error: ${error.message}`, session.debugMode);
                sendError(session.clientWs, error.message);
              }
            });

            streamingWs.on('close', (code: number, reason: string) => {
              console.log('AssemblyAI streaming connection closed:', code, reason);
              if (session) {
                sendDebug(session.clientWs, `AssemblyAI connection closed (code ${code})`, session.debugMode);
              }
            });

            sendDebug(clientWs, 'Connecting to AssemblyAI streaming…', debugMode);
            try {
              await streamingWs.connect();
              sendDebug(clientWs, '✓ AssemblyAI streaming connected — sending ready', debugMode);
            } catch (err) {
              const msg = err instanceof Error ? err.message : 'Unknown error';
              console.error('AssemblyAI streaming connect failed:', err);
              sendError(clientWs, `AssemblyAI connection failed: ${msg}. Check your ASSEMBLYAI_API_KEY.`);
              sendDebug(clientWs, `✗ AssemblyAI connect failed: ${msg}`, debugMode);
              activeSessions.delete(clientWs);
              session = null;
              return;
            }

            clientWs.send(JSON.stringify({ type: 'ready' }));

          } else if (message.type === 'stop') {
            if (session) {
              sendDebug(clientWs, 'Stop received — flushing pending translation…', session.debugMode);
              if (session.pendingTranslationTimer) {
                clearTimeout(session.pendingTranslationTimer);
                session.pendingTranslationTimer = null;
              }
              if (session.audioDebugTimer) {
                clearTimeout(session.audioDebugTimer);
                session.audioDebugTimer = null;
              }
              if (session.pendingTranslation) {
                await translateAndSend(session, session.pendingTranslation, true);
                session.pendingTranslation = '';
              }
              if (session.streamingWs) {
                await session.streamingWs.close().catch(() => {});
              }
            }
            activeSessions.delete(clientWs);
            session = null;

          } else if (message.type === 'config') {
            if (session) {
              session.targetLanguage = message.targetLanguage || session.targetLanguage;
              session.detectSpeakers = message.detectSpeakers ?? session.detectSpeakers;
              sendDebug(clientWs, `Config updated: lang=${session.targetLanguage}`, session.debugMode);
            }
          }

        } else {
          // Binary audio frame — forward to AssemblyAI
          if (!session?.streamingWs) return;

          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as unknown as ArrayBuffer);
          session.streamingWs.sendAudio(buf);
          session.audioFramesSent++;

          // Log audio activity every 5 seconds in debug mode
          if (session.debugMode && !session.audioDebugTimer) {
            session.audioDebugTimer = setTimeout(() => {
              if (session) {
                sendDebug(session.clientWs, `Audio pipeline: ${session.audioFramesSent} frames sent to AssemblyAI in last 5s`, session.debugMode);
                session.audioFramesSent = 0;
                session.audioDebugTimer = null;
              }
            }, 5000);
          }
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
        if (session) sendDebug(session.clientWs, `Server error: ${error instanceof Error ? error.message : error}`, session.debugMode);
      }
    });

    clientWs.on('close', async () => {
      console.log('Client disconnected');
      const s = activeSessions.get(clientWs);
      if (s) {
        if (s.pendingTranslationTimer) clearTimeout(s.pendingTranslationTimer);
        if (s.audioDebugTimer) clearTimeout(s.audioDebugTimer);
        if (s.streamingWs) await s.streamingWs.close().catch(() => {});
      }
      activeSessions.delete(clientWs);
    });

    clientWs.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });
}

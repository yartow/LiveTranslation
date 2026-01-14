import { AssemblyAI, RealtimeTranscript } from 'assemblyai';
import { WebSocket as WsWebSocket, WebSocketServer } from 'ws';
import { correctAndTranslateText } from './openai';

const client = new AssemblyAI({
  apiKey: process.env.ASSEMBLYAI_API_KEY!,
});

interface TranscriptionSession {
  assemblyWs: any;
  clientWs: WsWebSocket;
  targetLanguage: string;
  detectSpeakers: boolean;
  accumulatedText: string;
  finalizedText: string;
  pendingTranslation: string;
  lastTranslationTime: number;
  sentenceCount: number;
  pendingTranslationTimer: NodeJS.Timeout | null;
}

const activeSessions = new Map<WsWebSocket, TranscriptionSession>();

const TRANSLATION_DEBOUNCE_MS = 500;
const RETROACTIVE_CORRECTION_SENTENCES = 5;

function countSentences(text: string): number {
  if (!text.trim()) return 0;
  const sentences = text.match(/[.!?]+/g);
  return sentences ? sentences.length : 0;
}

async function translateAndSend(session: TranscriptionSession, text: string, isFinal: boolean) {
  if (!text.trim()) return;
  
  try {
    const { correctedText, translatedText } = await correctAndTranslateText(
      text,
      session.targetLanguage,
      session.detectSpeakers
    );
    
    if (session.clientWs.readyState === WsWebSocket.OPEN) {
      session.clientWs.send(JSON.stringify({
        type: 'translation',
        original: correctedText,
        translated: translatedText,
        isFinal,
      }));
    }
    
    const newSentenceCount = countSentences(session.finalizedText + text);
    if (newSentenceCount >= RETROACTIVE_CORRECTION_SENTENCES && 
        Math.floor(newSentenceCount / RETROACTIVE_CORRECTION_SENTENCES) > 
        Math.floor(session.sentenceCount / RETROACTIVE_CORRECTION_SENTENCES)) {
      session.sentenceCount = newSentenceCount;
    }
  } catch (error) {
    console.error('Translation error:', error);
    if (session.clientWs.readyState === WsWebSocket.OPEN) {
      session.clientWs.send(JSON.stringify({
        type: 'error',
        message: 'Translation failed',
      }));
    }
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
  if (session.pendingTranslationTimer) {
    clearTimeout(session.pendingTranslationTimer);
  }
  
  session.pendingTranslationTimer = setTimeout(() => {
    flushPendingTranslation(session);
  }, TRANSLATION_DEBOUNCE_MS);
}

export function setupStreamingWebSocket(wss: WebSocketServer) {
  wss.on('connection', async (clientWs: WsWebSocket) => {
    console.log('Client connected for streaming transcription');
    
    let session: TranscriptionSession | null = null;
    
    clientWs.on('message', async (data: Buffer | string, isBinary: boolean) => {
      try {
        if (!isBinary && typeof data === 'string') {
          const message = JSON.parse(data);
          
          if (message.type === 'start') {
            console.log('Starting AssemblyAI real-time session');
            
            const assemblyWs = await client.realtime.transcriber({
              sampleRate: 16000,
              wordBoost: ['sermon', 'scripture', 'bible', 'gospel', 'faith', 'prayer', 'amen'],
            });
            
            session = {
              assemblyWs,
              clientWs,
              targetLanguage: message.targetLanguage || 'nl',
              detectSpeakers: message.detectSpeakers || false,
              accumulatedText: '',
              finalizedText: '',
              pendingTranslation: '',
              lastTranslationTime: 0,
              sentenceCount: 0,
              pendingTranslationTimer: null,
            };
            
            activeSessions.set(clientWs, session);
            
            assemblyWs.on('transcript', async (transcript: RealtimeTranscript) => {
              if (!session) return;
              
              if (transcript.message_type === 'PartialTranscript') {
                const partialText = transcript.text;
                if (partialText && session.clientWs.readyState === WsWebSocket.OPEN) {
                  session.clientWs.send(JSON.stringify({
                    type: 'partial',
                    text: partialText,
                  }));
                }
              } else if (transcript.message_type === 'FinalTranscript') {
                const finalText = transcript.text;
                if (finalText) {
                  session.finalizedText += (session.finalizedText ? ' ' : '') + finalText;
                  
                  if (session.clientWs.readyState === WsWebSocket.OPEN) {
                    session.clientWs.send(JSON.stringify({
                      type: 'final',
                      text: finalText,
                    }));
                  }
                  
                  const now = Date.now();
                  if (now - session.lastTranslationTime >= TRANSLATION_DEBOUNCE_MS) {
                    session.lastTranslationTime = now;
                    
                    const textToTranslate = session.pendingTranslation 
                      ? session.pendingTranslation + ' ' + finalText 
                      : finalText;
                    session.pendingTranslation = '';
                    
                    if (session.pendingTranslationTimer) {
                      clearTimeout(session.pendingTranslationTimer);
                      session.pendingTranslationTimer = null;
                    }
                    
                    translateAndSend(session, textToTranslate, true);
                  } else {
                    session.pendingTranslation += (session.pendingTranslation ? ' ' : '') + finalText;
                    schedulePendingTranslation(session);
                  }
                }
              }
            });
            
            assemblyWs.on('error', (error: Error) => {
              console.error('AssemblyAI error:', error);
              if (session?.clientWs.readyState === WsWebSocket.OPEN) {
                session.clientWs.send(JSON.stringify({
                  type: 'error',
                  message: error.message,
                }));
              }
            });
            
            assemblyWs.on('close', (code: number, reason: string) => {
              console.log('AssemblyAI connection closed:', code, reason);
            });
            
            await assemblyWs.connect();
            
            clientWs.send(JSON.stringify({ type: 'ready' }));
            
          } else if (message.type === 'stop') {
            if (session) {
              if (session.pendingTranslationTimer) {
                clearTimeout(session.pendingTranslationTimer);
                session.pendingTranslationTimer = null;
              }
              
              if (session.pendingTranslation) {
                await translateAndSend(session, session.pendingTranslation, true);
                session.pendingTranslation = '';
              }
              
              if (session.assemblyWs) {
                await session.assemblyWs.close();
              }
            }
            activeSessions.delete(clientWs);
            session = null;
            
          } else if (message.type === 'config') {
            if (session) {
              session.targetLanguage = message.targetLanguage || session.targetLanguage;
              session.detectSpeakers = message.detectSpeakers ?? session.detectSpeakers;
            }
          }
        } else if (isBinary || data instanceof Buffer) {
          if (session?.assemblyWs) {
            session.assemblyWs.sendAudio(data);
          }
        }
      } catch (error) {
        console.error('WebSocket message error:', error);
      }
    });
    
    clientWs.on('close', async () => {
      console.log('Client disconnected');
      const closingSession = activeSessions.get(clientWs);
      if (closingSession) {
        if (closingSession.pendingTranslationTimer) {
          clearTimeout(closingSession.pendingTranslationTimer);
        }
        if (closingSession.assemblyWs) {
          try {
            await closingSession.assemblyWs.close();
          } catch (error) {
            console.error('Error closing AssemblyAI session:', error);
          }
        }
      }
      activeSessions.delete(clientWs);
    });
    
    clientWs.on('error', (error) => {
      console.error('WebSocket error:', error);
    });
  });
}

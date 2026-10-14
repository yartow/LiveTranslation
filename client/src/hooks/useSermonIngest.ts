import { useCallback, useEffect, useRef, useState } from 'react';
import { ChunkBasedTranscription, type ChunkTranscriptionEvents, type TranscriptionEngine } from '@/lib/chunk-based-transcription';
import { initIngestState, appendChunk, finalizeBuffer, releaseProvisional, tick as ingestTick, type IngestConfig, type IngestEffect } from '@/lib/sermon/ingest-buffer';
import { canWriteLive, type SegmentAction, type SegmentStoreState } from '@/lib/sermon/segment-store';
import { SERMON_VAD_SILENCE_MS, SERMON_MIN_CHUNK_MS, SERMON_MAX_CHUNK_MS } from '@/lib/sermon/chunk-limits';
import type { SermonTranslationProvider } from '@/hooks/useSettings';

export interface SermonIngestArgs {
  dispatch: React.Dispatch<SegmentAction>;
  /** Current store state, read synchronously before UPDATE_PROVISIONAL/
   *  COMPLETE_PROVISIONAL to decide whether the target row would refuse the
   *  write (see applyEffects below). */
  stateRef: React.MutableRefObject<SegmentStoreState>;
  ingestConfigRef: React.MutableRefObject<IngestConfig>;
  sourceLanguage: string;
  targetLanguage: string;
  engine: TranscriptionEngine;
  correctionProvider: SermonTranslationProvider;
  /** false = skip the per-chunk LLM correction and use Whisper's text as-is. */
  asrCorrection?: boolean;
  openaiApiKey: string;
  anthropicApiKey: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  glossary: string;
  debugMode: boolean;
  chunkDurationSecs?: number;
  /** User's configured mic gain (settings.audioNormalizationGain). Sermon
   *  mode used to hardcode this to 1.0 regardless of the setting, which
   *  left a quiet mic under-amplified and more likely to fall under the
   *  speech-presence gate in chunk-based-transcription.ts. */
  normalizationGain?: number;
  /** Settings.rawAudioCapture — see chunk-based-transcription.ts's setRawAudioCapture. */
  rawAudioCapture?: boolean;
  onError: (message: string) => void;
}

const CAP_TICK_MS = 250;
// How much of the already-transcribed text is fed back to Whisper as its
// prompt for the next chunk (server trims further, see buildWhisperPrompt).
const WHISPER_CONTEXT_CHARS = 300;

/**
 * Wires ChunkBasedTranscription (outputMode:'correct-only', VAD chunking,
 * zero overlap — see plan §1/§3) into the ingest-buffer flush state machine
 * and dispatches the resulting segments into the store.
 *
 * Segment ids for live-arriving text are generated HERE, not by the
 * reducer's own counter — see the comment on SegmentAction's APPEND_SEGMENT
 * in segment-store.ts for why: a PROVISIONAL segment's real id must be known
 * synchronously so later UPDATE_PROVISIONAL/COMPLETE_PROVISIONAL calls can
 * target the same row, and React's batching makes peeking the reducer's
 * counter between two dispatches in one tick unsafe.
 */
export function useSermonIngest(args: SermonIngestArgs) {
  const argsRef = useRef(args);
  useEffect(() => { argsRef.current = args; });

  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isPaused, setIsPaused] = useState(false);

  const backendRef = useRef<ChunkBasedTranscription | null>(null);
  const ingestStateRef = useRef(initIngestState());
  const tokenToIdRef = useRef(new Map<string, string>());
  const liveSeqRef = useRef(0);
  // Bumped on every start() and folded into every live id — this is what
  // stops a stop/restart within the same page load from re-emitting `live-0`
  // and colliding with (silently overwriting) the previous session's rows.
  // See the APPEND_SEGMENT duplicate-id guard in segment-store.ts, which is
  // the defense-in-depth backstop if this ever collides anyway.
  const liveSessionRef = useRef(0);
  const lastChunkIndexRef = useRef(0);
  const recentTextRef = useRef('');

  const approxTiming = useCallback(() => {
    const durationMs = (argsRef.current.chunkDurationSecs ?? 5) * 1000;
    const end = lastChunkIndexRef.current * durationMs + durationMs;
    return { startTime: Math.max(0, end - durationMs), endTime: end };
  }, []);

  const nextLiveId = useCallback(() => `live-${liveSessionRef.current}-${liveSeqRef.current++}`, []);

  // If the human has taken over the open provisional row (edited it), hand it
  // over in the ingest buffer too, so the text that row already shows isn't
  // re-sent in a brand-new row. Must run before every evaluation.
  const releaseIfTakenOver = useCallback((now: number) => {
    const token = ingestStateRef.current.provisionalToken;
    if (!token) return;
    const id = tokenToIdRef.current.get(token);
    if (!id) return; // no row was ever bound — applyEffects' missing-row fallback handles it
    if (canWriteLive(argsRef.current.stateRef.current.byId[id])) return;
    tokenToIdRef.current.delete(token);
    ingestStateRef.current = releaseProvisional(ingestStateRef.current, now);
  }, []);

  const applyEffects = useCallback((effects: IngestEffect[], now: number) => {
    const { dispatch, stateRef } = argsRef.current;
    for (const effect of effects) {
      if (effect.type === 'emit') {
        const id = nextLiveId();
        const { startTime, endTime } = approxTiming();
        if (effect.provisional) tokenToIdRef.current.set(effect.token, id);
        dispatch({
          type: 'APPEND_SEGMENT', id, sourceText: effect.text, startTime, endTime,
          approximateTiming: true, status: effect.provisional ? 'PROVISIONAL' : undefined, now,
        });
      } else if (effect.type === 'updateProvisional') {
        const id = tokenToIdRef.current.get(effect.token);
        const seg = id ? stateRef.current.byId[id] : undefined;
        // No row is bound to this token (token-miss): nothing on screen shows
        // this text, so open a row for it. A row the human has taken over is
        // NOT handled here — releaseIfTakenOver() hands it over before every
        // evaluation, and re-sending the full buffer into a new row is what
        // used to duplicate the block.
        if (!id || !seg) {
          const newId = nextLiveId();
          const { startTime, endTime } = approxTiming();
          tokenToIdRef.current.set(effect.token, newId);
          dispatch({
            type: 'APPEND_SEGMENT', id: newId, sourceText: effect.text, startTime, endTime,
            approximateTiming: true, status: 'PROVISIONAL', now,
          });
          continue;
        }
        dispatch({ type: 'UPDATE_PROVISIONAL', id, sourceText: effect.text, endTime: approxTiming().endTime, now });
      } else if (effect.type === 'completeProvisional') {
        const id = tokenToIdRef.current.get(effect.token);
        const seg = id ? stateRef.current.byId[id] : undefined;
        tokenToIdRef.current.delete(effect.token);
        if (!id || !seg) {
          // Same reasoning as above: no row shows this sentence, so append it
          // as its own new segment.
          const newId = nextLiveId();
          const { startTime, endTime } = approxTiming();
          dispatch({
            type: 'APPEND_SEGMENT', id: newId, sourceText: effect.text, startTime, endTime,
            approximateTiming: true, now,
          });
          continue;
        }
        dispatch({ type: 'COMPLETE_PROVISIONAL', id, sourceText: effect.text, endTime: approxTiming().endTime, now });
      }
    }
  }, [approxTiming, nextLiveId]);

  const handleCorrected = useCallback((text: string, chunkIndex: number) => {
    if (!text.trim()) return;
    lastChunkIndexRef.current = chunkIndex;
    // Give Whisper the end of what it just produced as the prompt for the next
    // chunk (continuity across the cut). Sermon chunks used to be transcribed
    // cold; only Home.tsx did this.
    recentTextRef.current = (recentTextRef.current + ' ' + text).slice(-WHISPER_CONTEXT_CHARS);
    backendRef.current?.setPreviousTranscript(recentTextRef.current.trim());
    const now = Date.now();
    releaseIfTakenOver(now);
    const step = appendChunk(ingestStateRef.current, text, argsRef.current.ingestConfigRef.current, now);
    ingestStateRef.current = step.state;
    applyEffects(step.effects, now);
  }, [applyEffects, releaseIfTakenOver]);

  // The cap-flush trigger must fire even when no new audio is arriving
  // (a speaker mid-sentence, or silence) — see plan §3. Runs for the whole
  // lifetime of the hook; harmless (a no-op) when the buffer is empty.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      releaseIfTakenOver(now);
      const step = ingestTick(ingestStateRef.current, argsRef.current.ingestConfigRef.current, now);
      ingestStateRef.current = step.state;
      if (step.effects.length > 0) applyEffects(step.effects, now);
    }, CAP_TICK_MS);
    return () => clearInterval(interval);
  }, [applyEffects, releaseIfTakenOver]);

  // End the current block now: whatever is buffered becomes a finished segment
  // (the open row is completed, so it gets translated at once instead of
  // waiting out the idle heuristic in selectTranslatable).
  const finalizeIngest = useCallback(() => {
    const now = Date.now();
    releaseIfTakenOver(now);
    const step = finalizeBuffer(ingestStateRef.current);
    ingestStateRef.current = step.state;
    applyEffects(step.effects, now);
  }, [applyEffects, releaseIfTakenOver]);

  const start = useCallback(async () => {
    const a = argsRef.current;
    setIsProcessing(true);
    setIsPaused(false);
    // A previous session that ended without stop() (e.g. a transport error)
    // may still have an open row — finalize it before the state is reset and
    // its token is forgotten.
    finalizeIngest();
    ingestStateRef.current = initIngestState();
    tokenToIdRef.current.clear();
    liveSeqRef.current = 0;
    liveSessionRef.current += 1;
    lastChunkIndexRef.current = 0;
    recentTextRef.current = '';

    const events: ChunkTranscriptionEvents = {
      onReady: () => {},
      // Sermon mode doesn't surface the pre-correction partial as its own UI
      // element — the corrected text (onTranslation, outputMode:'correct-only')
      // is the only thing that becomes a segment.
      onRawTranscript: () => {},
      onTranslation: (original, _translated, chunkIndex) => handleCorrected(original, chunkIndex),
      onError: (message) => {
        argsRef.current.onError(message);
        setIsRecording(false);
        setIsPaused(false);
        setIsProcessing(false);
      },
      onClose: () => { setIsRecording(false); setIsPaused(false); },
      onDebug: (message) => { if (argsRef.current.debugMode) console.debug('[sermon-ingest]', message); },
    };

    const backend = new ChunkBasedTranscription(events, (a.chunkDurationSecs ?? 5) * 1000);
    backend.setOutputMode('correct-only');
    backend.setChunkLimits(SERMON_MIN_CHUNK_MS, SERMON_MAX_CHUNK_MS);
    backend.setRawAudioCapture(a.rawAudioCapture ?? true);
    backendRef.current = backend;

    try {
      await backend.start(
        a.sourceLanguage,
        a.targetLanguage,
        false, // detectSpeakers — not meaningful for a single-speaker sermon
        a.asrCorrection === false ? 'none' : a.correctionProvider,
        a.openaiApiKey,
        a.anthropicApiKey,
        a.glossary,
        '', // sermonContext — sermon mode carries context per-sentence at translate time, not per-chunk
        a.debugMode,
        a.normalizationGain ?? 1.0,
        0,   // chunkOverlapMs forced to 0 — VAD cuts land between words, and
             // overlap-dedupe.ts is the belt-and-braces cleanup (plan §3)
        true, // useVADChunking forced on
        SERMON_VAD_SILENCE_MS,
        a.engine,
        a.ollamaBaseUrl,
        a.ollamaModel,
      );
      setIsRecording(true);
    } catch (err) {
      argsRef.current.onError(err instanceof Error ? err.message : 'Could not start recording');
      backendRef.current = null;
    } finally {
      setIsProcessing(false);
    }
  }, [handleCorrected, finalizeIngest]);

  const stop = useCallback(async () => {
    const backend = backendRef.current;
    backendRef.current = null;
    setIsRecording(false);
    setIsPaused(false);
    // backend.stop() drains in-flight chunks, so their text is in the buffer
    // by the time it resolves — only then finalize the last block.
    if (backend) await backend.stop();
    finalizeIngest();
  }, [finalizeIngest]);

  // Pause keeps the session (mic, socket, open block) alive: the last words are
  // still transcribed and land in the ingest buffer, which flushes them on its
  // normal block deadline — no finalize here, the final chunk hasn't arrived yet.
  const pause = useCallback(() => {
    if (!backendRef.current) return;
    backendRef.current.pause();
    setIsPaused(true);
  }, []);

  const resume = useCallback(() => {
    if (!backendRef.current) return;
    backendRef.current.resume();
    setIsPaused(false);
  }, []);

  // Stop any active mic/WebSocket session on unmount (e.g. navigating away
  // from SermonMode mid-recording) — otherwise the backend keeps running
  // with nothing left to dispatch its results into.
  useEffect(() => {
    return () => { backendRef.current?.stop(); };
  }, []);

  return { isRecording, isProcessing, isPaused, start, stop, pause, resume };
}

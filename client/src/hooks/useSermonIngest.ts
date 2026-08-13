import { useCallback, useEffect, useRef, useState } from 'react';
import { ChunkBasedTranscription, type ChunkTranscriptionEvents, type TranscriptionEngine } from '@/lib/chunk-based-transcription';
import { initIngestState, appendChunk, tick as ingestTick, type IngestConfig, type IngestEffect } from '@/lib/sermon/ingest-buffer';
import { canWriteLive, type SegmentAction, type SegmentStoreState } from '@/lib/sermon/segment-store';
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
  openaiApiKey: string;
  anthropicApiKey: string;
  ollamaBaseUrl: string;
  ollamaModel: string;
  glossary: string;
  debugMode: boolean;
  chunkDurationSecs?: number;
  onError: (message: string) => void;
}

const CAP_TICK_MS = 250;
// VAD-silence threshold for sermon mode's forced VAD chunking — see the
// "Gevolg voor chunk-overlap" note in the plan: cutting on silence (rather
// than a fixed duration) means chunk boundaries land between words, which
// is what makes chunkOverlapMs:0 safe to use here.
const SERMON_VAD_SILENCE_MS = 700;

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

  const approxTiming = useCallback(() => {
    const durationMs = (argsRef.current.chunkDurationSecs ?? 5) * 1000;
    const end = lastChunkIndexRef.current * durationMs + durationMs;
    return { startTime: Math.max(0, end - durationMs), endTime: end };
  }, []);

  const nextLiveId = useCallback(() => `live-${liveSessionRef.current}-${liveSeqRef.current++}`, []);

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
        // The human has taken over this row (edited it) since it was opened,
        // or it's gone missing (token-miss) — UPDATE_PROVISIONAL would be a
        // silent no-op in either case (segment-store.ts's canWriteLive guard,
        // or "no such id"), which used to just drop the live text on the
        // floor. Open a fresh row for it instead so nothing is lost, and stop
        // tracking the old token under the row we're no longer allowed to touch.
        if (!id || !canWriteLive(seg)) {
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
        if (!id || !canWriteLive(seg)) {
          // Same reasoning as above: COMPLETE_PROVISIONAL would refuse the
          // write and the completed sentence would vanish. Append it as its
          // own new segment instead.
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
    const now = Date.now();
    const step = appendChunk(ingestStateRef.current, text, argsRef.current.ingestConfigRef.current, now);
    ingestStateRef.current = step.state;
    applyEffects(step.effects, now);
  }, [applyEffects]);

  // The cap-flush trigger must fire even when no new audio is arriving
  // (a speaker mid-sentence, or silence) — see plan §3. Runs for the whole
  // lifetime of the hook; harmless (a no-op) when the buffer is empty.
  useEffect(() => {
    const interval = setInterval(() => {
      const now = Date.now();
      const step = ingestTick(ingestStateRef.current, argsRef.current.ingestConfigRef.current, now);
      ingestStateRef.current = step.state;
      if (step.effects.length > 0) applyEffects(step.effects, now);
    }, CAP_TICK_MS);
    return () => clearInterval(interval);
  }, [applyEffects]);

  const start = useCallback(async () => {
    const a = argsRef.current;
    setIsProcessing(true);
    ingestStateRef.current = initIngestState();
    tokenToIdRef.current.clear();
    liveSeqRef.current = 0;
    liveSessionRef.current += 1;
    lastChunkIndexRef.current = 0;

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
        setIsProcessing(false);
      },
      onClose: () => { setIsRecording(false); },
      onDebug: (message) => { if (argsRef.current.debugMode) console.debug('[sermon-ingest]', message); },
    };

    const backend = new ChunkBasedTranscription(events, (a.chunkDurationSecs ?? 5) * 1000);
    backend.setOutputMode('correct-only');
    backendRef.current = backend;

    try {
      await backend.start(
        a.sourceLanguage,
        a.targetLanguage,
        false, // detectSpeakers — not meaningful for a single-speaker sermon
        a.correctionProvider,
        a.openaiApiKey,
        a.anthropicApiKey,
        a.glossary,
        '', // sermonContext — sermon mode carries context per-sentence at translate time, not per-chunk
        a.debugMode,
        1.0, // normalizationGain
        0,   // chunkOverlapMs forced to 0 — VAD cuts land between words, and
             // overlap-dedupe.ts is the belt-and-braces cleanup (plan §3)
        true, // useVADChunking forced on
        SERMON_VAD_SILENCE_MS,
        a.engine,
      );
      // ChunkBasedTranscription.start() has no ollama parameters — those are
      // only settable post-connect via updateConfig(), same as Home.tsx does.
      if (a.correctionProvider === 'ollama') {
        backend.updateConfig(
          a.sourceLanguage, a.targetLanguage, false, 'ollama',
          a.openaiApiKey, a.anthropicApiKey, a.glossary, '',
          a.ollamaBaseUrl, a.ollamaModel,
        );
      }
      setIsRecording(true);
    } catch (err) {
      argsRef.current.onError(err instanceof Error ? err.message : 'Kon opname niet starten');
      backendRef.current = null;
    } finally {
      setIsProcessing(false);
    }
  }, [handleCorrected]);

  const stop = useCallback(async () => {
    const backend = backendRef.current;
    backendRef.current = null;
    setIsRecording(false);
    if (backend) await backend.stop();
  }, []);

  return { isRecording, isProcessing, start, stop };
}

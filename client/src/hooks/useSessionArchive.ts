import { useCallback, useEffect, useRef, useState } from 'react';
import { createEditLog } from '@/lib/sermon/edit-log';
import { installClientLog } from '@/lib/client-log';
import type { SegmentStoreState } from '@/lib/sermon/segment-store';

/**
 * Session archive, sermon-mode side (the server records one when it runs with
 * ASR_DEBUG_DIR — see server/lib/chunk-transcription.ts). Nothing is sent
 * unless the server says the archive is on.
 *
 * Split in two because the segment store needs the edit log before the
 * recording state (which the snapshots depend on) exists.
 */

/** The operator's edits batched to <session>/edits.jsonl, plus browser errors to client-errors.jsonl. */
export function useEditArchive() {
  // Whether the server is recording a session archive — see the status fetch below.
  const archiveActiveRef = useRef(false);
  const [editLog] = useState(() => createEditLog((body) => {
    fetch('/api/asr-debug/edit-log', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: body.length < 60_000 }).catch(() => {});
  }));

  useEffect(() => {
    fetch('/api/asr-debug/status').then(r => r.json()).then(j => { archiveActiveRef.current = !!j.enabled; }).catch(() => {});
  }, []);

  // Edits are flushed every few seconds (also while stopped — corrections typed after Stop count),
  // and when the page is closed. Browser errors/warnings go to the archive the same way.
  useEffect(() => {
    const timer = setInterval(() => editLog.flush(), 5000);
    const onHide = () => {
      if (!archiveActiveRef.current) return;
      editLog.flush();
    };
    window.addEventListener('pagehide', onHide);
    const uninstall = installClientLog(
      () => archiveActiveRef.current,
      (body) => { fetch('/api/asr-debug/client-log', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body, keepalive: body.length < 60_000 }).catch(() => {}); },
    );
    return () => { clearInterval(timer); window.removeEventListener('pagehide', onHide); uninstall(); editLog.flush(); };
  }, [editLog]);

  return { archiveActiveRef, editLog };
}

export type EditArchive = ReturnType<typeof useEditArchive>;

/**
 * While recording, snapshots what is on screen every minute and once more after
 * stop, so a gap in the transcript can be traced to the stage that lost it.
 */
export function useTranscriptSnapshots(
  stateRef: React.MutableRefObject<SegmentStoreState>,
  isRecording: boolean,
  { archiveActiveRef, editLog }: EditArchive,
) {
  const postTranscriptSnapshot = useCallback(() => {
    if (!archiveActiveRef.current) return;
    const s = stateRef.current;
    // An empty page (e.g. just reloaded) must not overwrite the previous session's snapshot.
    if (!s.ids.length) return;
    const segments = s.ids.map(id => {
      const g = s.byId[id];
      return {
        id, index: g.index, startTime: g.startTime, endTime: g.endTime, status: g.status,
        sourceText: g.sourceText, translatedText: g.translatedText,
        asrText: g.asrText, machineText: g.machineText,
        manualOverride: g.manualOverride, lastSourceChangeAt: g.lastSourceChangeAt, error: g.error,
      };
    });
    fetch('/api/asr-debug/transcript', {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ savedAt: Date.now(), sessionId: s.sessionId, segments }),
    }).catch(() => {});
  }, [archiveActiveRef, stateRef]);

  useEffect(() => {
    if (!isRecording) {
      // After stop the last ingest flush / translations may still land a moment later.
      postTranscriptSnapshot();
      editLog.flush();
      const late = setTimeout(() => { postTranscriptSnapshot(); editLog.flush(); }, 4000);
      return () => clearTimeout(late);
    }
    const timer = setInterval(postTranscriptSnapshot, 60_000);
    return () => clearInterval(timer);
  }, [isRecording, postTranscriptSnapshot, editLog]);
}

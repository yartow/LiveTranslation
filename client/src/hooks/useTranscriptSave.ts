// Saves the English of the service as markdown (transcript-markdown.ts) to the operator's machine:
// POST /api/sermon/transcript-md -> server/lib/transcript-file.ts, one file per page session,
// overwritten in place.
//  - When recording stops: at once (with a toast naming the file) and again 4 s later, since the last
//    chunk and its translation land after Stop (same timing as useSessionArchive's snapshot).
//  - After a stop, while not recording: every later change re-saves, debounced, silently.
//  - saveNow(): the toolbar's "Save .md" — saves and also downloads the file in the browser.
// Never blocks or fails a Stop: errors are a toast (or a console warning for the silent saves).

import { useCallback, useEffect, useRef } from 'react';
import type { SegmentStoreState } from '@/lib/sermon/segment-store';
import type { ServiceContext } from '@/lib/sermon/service-context';
import { buildTranscriptMarkdown } from '@/lib/sermon/transcript-markdown';
import { useLatest } from './useLatest';
import type { useToast } from './use-toast';

const AFTER_STOP_MS = 4000;
const EDIT_DEBOUNCE_MS = 5000;

type Toast = ReturnType<typeof useToast>['toast'];

async function postTranscript(sessionId: string, markdown: string): Promise<string> {
  const res = await fetch(`/api/sermon/transcript-md?session=${encodeURIComponent(sessionId)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body: markdown,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || typeof body.file !== 'string') throw new Error(body.error || `HTTP ${res.status}`);
  return body.file;
}

function download(markdown: string, name: string) {
  const url = URL.createObjectURL(new Blob([markdown], { type: 'text/markdown;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function useTranscriptSave(opts: {
  state: SegmentStoreState;
  stateRef: React.MutableRefObject<SegmentStoreState>;
  isRecording: boolean;
  serviceContext: ServiceContext;
  toast: Toast;
}): { saveNow: () => void } {
  const { state, stateRef, isRecording, toast } = opts;
  const serviceRef = useLatest(opts.serviceContext);
  const toastRef = useLatest(toast);
  // The day the service started, so a file saved after midnight still carries the service's date.
  const dateRef = useRef<Date | null>(null);
  const lastSavedRef = useRef('');
  const stoppedOnceRef = useRef(false);
  const wasRecordingRef = useRef(false);

  const build = useCallback(() => {
    const ctx = serviceRef.current;
    return buildTranscriptMarkdown(stateRef.current, {
      title: ctx.title,
      passages: ctx.passages.split('\n'),
      date: dateRef.current ?? new Date(),
    });
  }, [serviceRef, stateRef]);

  /** Returns the file path, null when there was nothing (new) to save; throws on a failed write. */
  const save = useCallback(async (force: boolean): Promise<string | null> => {
    const markdown = build();
    if (!markdown || (!force && markdown === lastSavedRef.current)) return null;
    const file = await postTranscript(stateRef.current.sessionId, markdown);
    lastSavedRef.current = markdown;
    return file;
  }, [build, stateRef]);

  const saveQuietly = useCallback(() => {
    save(false).catch(err => console.warn('[transcript] save failed:', err instanceof Error ? err.message : err));
  }, [save]);

  // Recording stopped -> save now (announced) and once more when the last words have arrived.
  useEffect(() => {
    if (isRecording) {
      wasRecordingRef.current = true;
      dateRef.current ??= new Date();
      return;
    }
    if (!wasRecordingRef.current) return;
    wasRecordingRef.current = false;
    stoppedOnceRef.current = true;
    save(true).then(
      file => { if (file) toastRef.current({ title: 'Transcript saved', description: file }); },
      err => toastRef.current({
        title: 'Transcript not saved',
        description: err instanceof Error ? err.message : 'Could not write the markdown file',
        variant: 'destructive',
      }),
    );
    const late = setTimeout(saveQuietly, AFTER_STOP_MS);
    return () => clearTimeout(late);
  }, [isRecording, save, saveQuietly, toastRef]);

  // Edits made after a stop update the same file.
  useEffect(() => {
    if (isRecording || !stoppedOnceRef.current) return;
    const timer = setTimeout(saveQuietly, EDIT_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [state, isRecording, saveQuietly]);

  const saveNow = useCallback(() => {
    const markdown = build();
    if (!markdown) {
      toastRef.current({ title: 'Nothing to save yet', description: 'No translated text so far.' });
      return;
    }
    const d = dateRef.current ?? new Date();
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    download(markdown, `sermon-${day}.md`);
    save(true).then(
      file => { if (file) toastRef.current({ title: 'Transcript saved', description: file }); },
      err => console.warn('[transcript] save failed:', err instanceof Error ? err.message : err),
    );
  }, [build, save, toastRef]);

  return { saveNow };
}

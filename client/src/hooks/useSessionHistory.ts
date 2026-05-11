import { useState, useCallback } from 'react';
import { listSessions, deleteSession, type SessionRecord } from '@/lib/session-db';

export type { SessionRecord };

export function useSessionHistory() {
  const [sessions, setSessions] = useState<SessionRecord[]>([]);

  const load = useCallback(async () => {
    try {
      setSessions(await listSessions());
    } catch {
      setSessions([]);
    }
  }, []);

  const remove = useCallback(async (id: string) => {
    try {
      await deleteSession(id);
      setSessions((prev) => prev.filter((s) => s.id !== id));
    } catch {}
  }, []);

  return { sessions, load, remove };
}

export interface SessionRecord {
  id: string;
  createdAt: number;
  sourceLanguage: string;
  targetLanguage: string;
  originalText: string;
  translatedText: string;
  sessionCost: number;
  transcriptionProvider: string;
  translationProvider: string;
}

const DB_NAME = 'sermonscribe';
const DB_VERSION = 2;
const STORE = 'sessions';
const AUTOSAVE_STORE = 'autosave';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt');
      }
      // v2: one record holding the sermon-mode segment store, see saveAutosave.
      if (!db.objectStoreNames.contains(AUTOSAVE_STORE)) {
        db.createObjectStore(AUTOSAVE_STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function saveSession(record: SessionRecord): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  // Prune records older than 30 days
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE, 'readwrite');
    const range = IDBKeyRange.upperBound(Date.now() - MAX_AGE_MS);
    const req = tx.objectStore(STORE).index('createdAt').openCursor(range);
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
    tx.oncomplete = () => resolve();
  });
}

export async function listSessions(): Promise<SessionRecord[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).index('createdAt').getAll();
    req.onsuccess = () => resolve((req.result as SessionRecord[]).reverse());
    req.onerror = () => reject(req.error);
  });
}

export async function deleteSession(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Sermon mode keeps the segments only in the page, so a crash or reload would lose the service. The
// store is saved here every few seconds and offered back on the next load (SermonMode.tsx).
export interface AutosaveRecord {
  id: 'current';
  savedAt: number;
  /** A SegmentStoreState (kept untyped here — restoredState() validates it on the way back). */
  state: unknown;
  /** Row count, for the "Restore (N rows)" banner without reading the whole state. */
  rows: number;
}

export async function saveAutosave(state: unknown, rows: number): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(AUTOSAVE_STORE, 'readwrite');
    const record: AutosaveRecord = { id: 'current', savedAt: Date.now(), state, rows };
    tx.objectStore(AUTOSAVE_STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadAutosave(): Promise<AutosaveRecord | null> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const req = db.transaction(AUTOSAVE_STORE, 'readonly').objectStore(AUTOSAVE_STORE).get('current');
    req.onsuccess = () => resolve((req.result as AutosaveRecord | undefined) ?? null);
    req.onerror = () => reject(req.error);
  });
}

export async function clearAutosave(): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(AUTOSAVE_STORE, 'readwrite');
    tx.objectStore(AUTOSAVE_STORE).delete('current');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

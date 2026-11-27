/**
 * Local-only IndexedDB storage for genuine .wav studio recordings.
 * Enforces strict 30-minute automatic expiration (persisted across reloads and sessions).
 * No data ever leaves the user's browser.
 */

export const RECORDING_TTL_MS = 30 * 60 * 1000; // 30 minutes

const DB_NAME = "midi-controller-studio-recordings";
const DB_VERSION = 1;
const STORE_NAME = "recordings";

export interface StoredRecording {
  id: string;
  name: string;
  fileName: string;
  mode: "piano" | "oscillator";
  mimeType: "audio/wav";
  blob: Blob;
  sizeBytes: number;
  durationSec: number;
  sampleRate: number;
  createdAt: number;
  expiresAt: number;
}

export interface NewRecordingInput {
  mode: "piano" | "oscillator";
  blob: Blob;
  durationSec: number;
  sampleRate: number;
  sizeBytes: number;
}

export function isIndexedDBSupported(): boolean {
  return typeof window !== "undefined" && typeof window.indexedDB !== "undefined";
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!isIndexedDBSupported()) {
      reject(new Error("Local browser storage (IndexedDB) is not available in this browser."));
      return;
    }

    const request = window.indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: "id" });
        store.createIndex("expiresAt", "expiresAt", { unique: false });
        store.createIndex("createdAt", "createdAt", { unique: false });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to open local recordings database."));
  });
}

function formatTimestampParts(ts: number) {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  const datePart = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
  const timePart = `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  const clockLabel = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  return { datePart, timePart, clockLabel };
}

function generateRecordingId(now: number): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `rec-${now}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Deletes every recording whose 30-minute validity window has elapsed.
 * Returns the list of deleted recording IDs.
 */
export async function purgeExpiredRecordings(now = Date.now()): Promise<string[]> {
  if (!isIndexedDBSupported()) return [];

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const deletedIds: string[] = [];
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    const request = store.openCursor();

    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const item = cursor.value as StoredRecording;
      const expired = !item || typeof item.expiresAt !== "number" || item.expiresAt <= now;
      if (expired) {
        deletedIds.push(item?.id ?? String(cursor.key));
        cursor.delete();
      }
      cursor.continue();
    };

    tx.oncomplete = () => {
      db.close();
      resolve(deletedIds);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Failed to clean up expired recordings."));
    };
  });
}

/**
 * Saves a genuine .wav recording locally in IndexedDB with a strict 30-minute TTL.
 */
export async function saveRecording(input: NewRecordingInput): Promise<StoredRecording> {
  const now = Date.now();
  await purgeExpiredRecordings(now);

  const { datePart, timePart, clockLabel } = formatTimestampParts(now);
  const modeTitle = input.mode === "piano" ? "Grand Piano" : "Analog Synth";
  const modeSlug = input.mode === "piano" ? "piano" : "synth";

  const record: StoredRecording = {
    id: generateRecordingId(now),
    name: `${modeTitle} Take · ${clockLabel}`,
    fileName: `midi-studio-${modeSlug}-${datePart}-${timePart}.wav`,
    mode: input.mode,
    mimeType: "audio/wav",
    blob: input.blob,
    sizeBytes: input.sizeBytes,
    durationSec: input.durationSec,
    sampleRate: input.sampleRate,
    createdAt: now,
    expiresAt: now + RECORDING_TTL_MS,
  };

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    const store = tx.objectStore(STORE_NAME);
    store.put(record);

    tx.oncomplete = () => {
      db.close();
      resolve(record);
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Failed to store .wav recording locally."));
    };
  });
}

/**
 * Purges expired recordings first, then returns all currently valid recordings (newest first).
 */
export async function listValidRecordings(now = Date.now()): Promise<{
  recordings: StoredRecording[];
  purgedCount: number;
}> {
  if (!isIndexedDBSupported()) {
    return { recordings: [], purgedCount: 0 };
  }

  const purgedIds = await purgeExpiredRecordings(now);
  const db = await openDatabase();

  const recordings = await new Promise<StoredRecording[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const store = tx.objectStore(STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const items = ((request.result as StoredRecording[]) || [])
        .filter((r) => r && r.expiresAt > now)
        .sort((a, b) => b.createdAt - a.createdAt);
      resolve(items);
    };
    request.onerror = () =>
      reject(request.error ?? new Error("Failed to read local recordings."));
    tx.oncomplete = () => db.close();
  });

  return { recordings, purgedCount: purgedIds.length };
}

/**
 * Retrieves a single recording only if still within its 30-minute window;
 * otherwise deletes it immediately and returns null.
 */
export async function getValidRecording(id: string, now = Date.now()): Promise<StoredRecording | null> {
  if (!isIndexedDBSupported()) return null;

  const db = await openDatabase();
  const record = await new Promise<StoredRecording | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const request = tx.objectStore(STORE_NAME).get(id);
    request.onsuccess = () => resolve(request.result as StoredRecording | undefined);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });

  if (!record) return null;
  if (record.expiresAt <= now) {
    await deleteRecording(id);
    return null;
  }
  return record;
}

export async function deleteRecording(id: string): Promise<void> {
  if (!isIndexedDBSupported()) return;

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Failed to delete recording."));
    };
  });
}

export async function clearAllRecordings(): Promise<void> {
  if (!isIndexedDBSupported()) return;

  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).clear();
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => {
      db.close();
      reject(tx.error ?? new Error("Failed to clear recordings."));
    };
  });
}

export function formatRemainingTime(expiresAt: number, now = Date.now()): string {
  const remainingMs = Math.max(0, expiresAt - now);
  const totalSec = Math.ceil(remainingMs / 1000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  if (mins <= 0) {
    return `${secs}s left`;
  }
  return `${mins}m ${String(secs).padStart(2, "0")}s left`;
}

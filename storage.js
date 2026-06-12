// IndexedDB helper for storing captured frames and recording metadata.
// Frames are stored as Blobs (WebP) keyed by their sequential index so the
// recorder, editor, and popup pages (all same-origin extension pages) can
// share a single capture session.

const DB_NAME = "gif-creator";
const DB_VERSION = 1;
const FRAME_STORE = "frames";
const META_STORE = "meta";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(FRAME_STORE)) {
        db.createObjectStore(FRAME_STORE); // keyed by integer index
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        db.createObjectStore(META_STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, store, mode) {
  return db.transaction(store, mode).objectStore(store);
}

function reqToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Wipe any previous session so a new recording starts clean.
export async function clearSession() {
  const db = await openDB();
  await Promise.all([
    reqToPromise(tx(db, FRAME_STORE, "readwrite").clear()),
    reqToPromise(tx(db, META_STORE, "readwrite").clear()),
  ]);
  db.close();
}

export async function addFrame(index, blob) {
  const db = await openDB();
  await reqToPromise(tx(db, FRAME_STORE, "readwrite").put(blob, index));
  db.close();
}

export async function getFrame(index) {
  const db = await openDB();
  const blob = await reqToPromise(tx(db, FRAME_STORE, "readonly").get(index));
  db.close();
  return blob;
}

export async function getFrameCount() {
  const db = await openDB();
  const count = await reqToPromise(tx(db, FRAME_STORE, "readonly").count());
  db.close();
  return count;
}

export async function setMeta(meta) {
  const db = await openDB();
  await reqToPromise(tx(db, META_STORE, "readwrite").put(meta, "recording"));
  db.close();
}

export async function getMeta() {
  const db = await openDB();
  const meta = await reqToPromise(tx(db, META_STORE, "readonly").get("recording"));
  db.close();
  return meta;
}

// Settings persist in chrome.storage.local so the popup and recorder agree.
const DEFAULT_SETTINGS = {
  fps: 15,
  quality: "medium", // low | medium | high -> scale + gif quality
  maxDuration: 30, // seconds
};

export async function getSettings() {
  const stored = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(stored.settings || {}) };
}

export async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

export { DEFAULT_SETTINGS };

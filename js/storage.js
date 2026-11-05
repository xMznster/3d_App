// Speichert importierte Modelle lokal im iPhone (IndexedDB),
// damit sie später auch offline wieder geöffnet werden können.
const DB_NAME = '3d-studio';
const STORE = 'models';
let dbPromise;

function openDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB nicht verfügbar'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    const result = fn(store);
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

/** files: Array<{name, type, data: ArrayBuffer}> */
export function saveModel(name, files) {
  const size = files.reduce((s, f) => s + f.data.byteLength, 0);
  return tx('readwrite', (s) => s.add({ name, files, size, date: Date.now() }));
}

export function listModels() {
  return openDB().then((db) => new Promise((resolve, reject) => {
    const out = [];
    const req = db.transaction(STORE).objectStore(STORE).openCursor(null, 'prev');
    req.onsuccess = () => {
      const c = req.result;
      if (c) {
        const { id, name, size, date } = c.value;
        out.push({ id, name, size, date });
        c.continue();
      } else resolve(out);
    };
    req.onerror = () => reject(req.error);
  }));
}

export function getModel(id) {
  return tx('readonly', (s) => s.get(id));
}

export function deleteModel(id) {
  return tx('readwrite', (s) => s.delete(id));
}

export async function requestPersistence() {
  try {
    if (navigator.storage && navigator.storage.persist) await navigator.storage.persist();
  } catch { /* optional */ }
}

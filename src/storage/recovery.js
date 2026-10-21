/**
 * Automatische Wiederherstellung (wie „AutoWiederherstellen“ in Office): Solange die geöffnete
 * PDF ungespeicherte Änderungen hat, liegt kurz nach jeder Änderung eine Kopie in einer eigenen
 * IndexedDB („plantpdf-recovery“). Die Originaldatei bleibt unverändert, bis gespeichert wird.
 * Nach dem Speichern, Verwerfen oder Schließen wird die Kopie gelöscht – bleibt eine übrig, wurde
 * PlantPDF unerwartet beendet, und der nächste Start bietet sie an.
 *
 * Jedes Fenster sichert unter einer eigenen Kennung und hält dazu eine Web Lock; Kopien, deren
 * Lock noch gehalten wird, gehören zu einem laufenden Fenster (Browser mit mehreren Tabs).
 * Stores: `meta` (Kennung → { id, name, time, size }) für den Hinweis, `data` (Kennung → { id, bytes, handle }).
 */
const DB_NAME = 'plantpdf-recovery';
const DB_VERSION = 1;
const LOCK = 'plantpdf-recovery:';
/** Nicht abgeholte Kopien werden nach 14 Tagen gelöscht. */
const MAX_AGE = 14 * 24 * 3600 * 1000;

let dbPromise = null;

function db() {
  if (!dbPromise)
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const d = request.result;
        for (const name of ['meta', 'data']) if (!d.objectStoreNames.contains(name)) d.createObjectStore(name, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
      request.onblocked = () => {
        dbPromise = null;
        reject(new Error('Datenbank blockiert'));
      };
    });
  return dbPromise;
}

function run(mode, fn) {
  return db().then(
    (d) =>
      new Promise((resolve, reject) => {
        const tx = d.transaction(['meta', 'data'], mode);
        let result;
        fn(tx, (r) => (result = r));
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

const req = (r) => new Promise((resolve, reject) => ((r.onsuccess = () => resolve(r.result)), (r.onerror = () => reject(r.error))));

/** Kennung dieses Fensters; die Lock gilt, solange das Fenster offen ist. */
export const windowId = 'w' + Date.now().toString(36) + crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
try {
  navigator.locks?.request(LOCK + windowId, () => new Promise(() => {}));
} catch {}

/** Kopie schreiben bzw. ersetzen. Ein Datei-Handle lässt sich nicht immer ablegen – dann ohne. */
export async function putCopy(id, { name, bytes, handle }) {
  const write = (h) =>
    run('readwrite', (tx) => {
      tx.objectStore('meta').put({ id, name, time: Date.now(), size: bytes.length });
      tx.objectStore('data').put({ id, bytes, handle: h || null });
    });
  try {
    await write(handle);
  } catch (err) {
    if (!handle || (err && err.name !== 'DataCloneError')) throw err;
    await write(null);
  }
}

export function deleteCopy(id) {
  return run('readwrite', (tx) => {
    tx.objectStore('meta').delete(id);
    tx.objectStore('data').delete(id);
  });
}

export function loadCopy(id) {
  return run('readonly', (tx, done) => {
    req(tx.objectStore('data').get(id)).then(done);
  });
}

/**
 * Kopien aus beendeten Fenstern, neueste zuerst (ohne Inhalt). Zu alte werden dabei gelöscht.
 * `except`: eigene Kennung (gehört zum laufenden Fenster).
 */
export async function orphanCopies(except = windowId) {
  const all = await run('readonly', (tx, done) => {
    req(tx.objectStore('meta').getAll()).then(done);
  });
  let live = new Set();
  try {
    const state = navigator.locks ? await navigator.locks.query() : null;
    if (state) live = new Set(state.held.map((l) => l.name));
  } catch {}
  const now = Date.now();
  const out = [];
  for (const m of all || []) {
    if (m.id === except || live.has(LOCK + m.id)) continue;
    if (now - m.time > MAX_AGE) deleteCopy(m.id).catch(() => {});
    else out.push(m);
  }
  return out.sort((a, b) => b.time - a.time);
}

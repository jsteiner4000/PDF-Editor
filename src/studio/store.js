/**
 * Entwürfe von „Dokumentation erstellen“ (eigene IndexedDB „pdfix-studio“, unabhängig von der
 * Datenbank des PDF-Bearbeitens). Jede Änderung wird kurz danach gesichert; die Startseite listet
 * die Entwürfe unter „Dokumentationen“.
 *
 * Stores: `meta` (Kennung → { id, name, sub, modified }) für die Liste, `data` (Kennung → Projekt
 * samt Bildern) – so lädt die Liste keine Bilder.
 */
const DB_NAME = 'pdfix-studio';
const DB_VERSION = 1;

let dbPromise = null;

function db() {
  if (!dbPromise)
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const d = request.result;
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('data')) d.createObjectStore('data', { keyPath: 'id' });
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
        Promise.resolve(fn(tx, (r) => (result = r))).catch(reject);
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      }),
  );
}

const req = (r) => new Promise((resolve, reject) => ((r.onsuccess = () => resolve(r.result)), (r.onerror = () => reject(r.error))));

/** Sichert ein Projekt (Kennung = project.id). `info`: { name, sub } für die Liste. */
export function saveDraft(project, info) {
  return run('readwrite', (tx) => {
    tx.objectStore('meta').put({ id: project.id, name: info.name, sub: info.sub || '', modified: project.modified || Date.now() });
    tx.objectStore('data').put({ id: project.id, project });
  });
}

/** Alle Entwürfe, zuletzt bearbeitete zuerst (ohne Projektinhalt). */
export async function listDrafts() {
  try {
    const all = await run('readonly', (tx, done) => req(tx.objectStore('meta').getAll()).then(done));
    return (all || []).sort((a, b) => b.modified - a.modified);
  } catch {
    return [];
  }
}

export function loadDraft(id) {
  return run('readonly', (tx, done) => req(tx.objectStore('data').get(id)).then((r) => done(r && r.project)));
}

export function deleteDraft(id) {
  return run('readwrite', (tx) => {
    tx.objectStore('meta').delete(id);
    tx.objectStore('data').delete(id);
  });
}

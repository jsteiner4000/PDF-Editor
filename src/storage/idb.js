/**
 * IndexedDB-Speicher "pdf-editor" (Stores: fonts, recent, signatures).
 */

/**
 * Datenbank „pdf-editor“ (Version 2). Stores:
 *   - `fonts`:      Schlüssel = PostScript-Name, Wert = ArrayBuffer der Schriftdatei   (seit v1)
 *   - `recent`:     Schlüssel = Dateiname, Wert = { name, handle (FileSystemFileHandle), time } (seit v1)
 *   - `signatures`: Schlüssel = ID, Wert = gespeicherte Unterschrift (PNG + Metadaten,
 *                   siehe src/signature/signature-store.js)                            (seit v2)
 * Die Migration ist schrittweise (`oldVersion`), vorhandene Daten aus v1 bleiben erhalten.
 * localStorage wird nicht verwendet.
 */
const DB_NAME = 'pdf-editor';
const DB_VERSION = 2;

/** Höchstens so lange auf die Datenbank warten, bevor ein Fehler gemeldet wird (ms). */
const OPEN_TIMEOUT = 10000;

export const IDB_BLOCKED_MESSAGE =
  'Der PDF-Editor ist noch in einem anderen Fenster oder Tab geöffnet (ältere Version). Bitte die anderen Fenster des PDF-Editors schließen.';

/** Fehler, wenn die Umstellung der Datenbank durch ein anderes geöffnetes Fenster blockiert ist. */
export class IdbBlockedError extends Error {
  constructor() {
    super(IDB_BLOCKED_MESSAGE);
    this.name = 'IdbBlockedError';
  }
}

let dbRequest = null;
let blocked = false;
const blockedListeners = new Set();

/** Meldet, wenn die Datenbank blockiert ist (`true`) bzw. wieder frei (`false`). */
export function onIdbBlocked(fn) {
  blockedListeners.add(fn);
  return () => blockedListeners.delete(fn);
}

function setBlocked(value) {
  if (blocked === value) return;
  blocked = value;
  for (const fn of blockedListeners) fn(value);
}

function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    db.createObjectStore('fonts');
    db.createObjectStore('recent');
  }
  if (oldVersion < 2) db.createObjectStore('signatures');
}

/** Eine einzige Öffnungsanfrage; sie bleibt bestehen, bis sie gelingt oder fehlschlägt. */
function requestDb() {
  if (!dbRequest)
    dbRequest = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (ev) => upgrade(request.result, ev.oldVersion);
      // Ein anderes Fenster hält noch Version 1 offen (z. B. PDF-Editor 1.0): Die Umstellung
      // wartet, bis es geschlossen wird. Bis dahin schlagen Zugriffe mit einem Hinweis fehl.
      request.onblocked = () => setBlocked(true);
      request.onsuccess = () => {
        const db = request.result;
        setBlocked(false);
        // Öffnet ein anderes Fenster eine neuere Version, Verbindung freigeben (sonst blockiert es).
        db.onversionchange = () => {
          db.close();
          dbRequest = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        dbRequest = null;
        setBlocked(false);
        reject(request.error);
      };
    });
  return dbRequest;
}

/** Datenbank öffnen; schlägt fehl, solange sie blockiert ist, spätestens nach OPEN_TIMEOUT. */
function openDb() {
  const pending = requestDb();
  let timer = 0;
  let unsubscribe = null;
  const fail = new Promise((_, reject) => {
    if (blocked) return reject(new IdbBlockedError());
    unsubscribe = onIdbBlocked((value) => value && reject(new IdbBlockedError()));
    timer = setTimeout(
      () => reject(blocked ? new IdbBlockedError() : new Error('IndexedDB antwortet nicht')),
      OPEN_TIMEOUT,
    );
  });
  fail.catch(() => {});
  return Promise.race([pending, fail]).finally(() => {
    clearTimeout(timer);
    if (unsubscribe) unsubscribe();
  });
}

/** Alle Werte eines Stores; wirft bei Fehlern (anders als `idbList`), z. B. `IdbBlockedError`. */
export async function idbGetAll(store) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const request = db.transaction(store, 'readonly').objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Ändert alle Datensätze eines Stores in EINER Transaktion: `fn(value)` gibt den neuen Wert zurück
 * oder `undefined` (unverändert). Rückgabe: true bei Erfolg.
 */
export async function idbUpdateAll(store, fn) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      const cursorRequest = tx.objectStore(store).openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        const next = fn(cursor.value);
        if (next !== undefined) cursor.update(next);
        cursor.continue();
      };
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

export async function idbGet(store, key) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const request = db.transaction(store, 'readonly').objectStore(store).get(key);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(undefined);
    });
  } catch {
    return undefined;
  }
}

export async function idbPut(store, key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).put(value, key);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    return true;
  } catch {
    return false;
  }
}

export async function idbDelete(store, key) {
  try {
    const db = await openDb();
    await new Promise((i) => {
      const tx = db.transaction(store, 'readwrite');
      tx.objectStore(store).delete(key);
      tx.oncomplete = i;
      tx.onerror = i;
    });
  } catch {}
}

export async function idbList(store) {
  try {
    const db = await openDb();
    return await new Promise((resolve) => {
      const items = [];
      const cursorRequest = db.transaction(store, 'readonly').objectStore(store).openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          items.push({ key: cursor.key, value: cursor.value });
          cursor.continue();
        } else resolve(items);
      };
      cursorRequest.onerror = () => resolve(items);
    });
  } catch {
    return [];
  }
}

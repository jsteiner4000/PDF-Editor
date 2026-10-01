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

let dbPromise = null;

function upgrade(db, oldVersion) {
  if (oldVersion < 1) {
    db.createObjectStore('fonts');
    db.createObjectStore('recent');
  }
  if (oldVersion < 2) db.createObjectStore('signatures');
}

function openDb() {
  if (!dbPromise)
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = (ev) => upgrade(request.result, ev.oldVersion);
      request.onsuccess = () => {
        const db = request.result;
        // Öffnet ein anderes Fenster eine neuere Version, Verbindung freigeben (sonst blockiert es).
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      request.onerror = () => {
        dbPromise = null;
        reject(request.error);
      };
    });
  return dbPromise;
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

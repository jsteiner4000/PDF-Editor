/**
 * IndexedDB-Speicher "pdf-editor" (Stores: fonts, recent).
 */

/**
 * Datenbank „pdf-editor“ (Version 1). Stores:
 *   - `fonts`:  Schlüssel = PostScript-Name, Wert = ArrayBuffer der Schriftdatei
 *   - `recent`: Schlüssel = Dateiname, Wert = { name, handle (FileSystemFileHandle), time }
 * localStorage wird nicht verwendet.
 */
let dbPromise = null;

function openDb() {
  if (!dbPromise)
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open('pdf-editor', 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('fonts');
        request.result.createObjectStore('recent');
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  return dbPromise;
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

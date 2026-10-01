/**
 * Gespeicherte Unterschriften und Initialen (IndexedDB-Store „signatures“, nur lokal).
 *
 * Datensatz (Schlüssel = `id`):
 *   {
 *     id:       'sig-…',
 *     name:     Anzeigename,
 *     kind:     'signature' | 'initials',
 *     source:   'document' | 'image' | 'drawn',
 *     created:  Zeitstempel (ms),
 *     png:      ArrayBuffer – PNG mit Alphakanal, auf die Tinte zugeschnitten,
 *     width, height:   Pixelmaße des PNG,
 *     aspect:   width / height,
 *     widthMm, heightMm: natürliche Größe in mm (aus der Auflösung der Quelle; geschätzt bei
 *               Bilddateien und Zeichnungen),
 *     isDefault: true bei genau einem Datensatz (Standard-Unterschrift)
 *   }
 * Die Daten verlassen den Rechner nicht; es gibt keine Abhängigkeit von der Herkunft (file://,
 * Desktop-App): alles läuft über die gemeinsame Datenbank aus storage/idb.js.
 */
import { idbDelete, idbGet, idbList, idbPut } from '../storage/idb.js';

const STORE = 'signatures';
const listeners = new Set();

function emit() {
  for (const fn of listeners) {
    try {
      fn();
    } catch (err) {
      console.warn(err);
    }
  }
}

function newId() {
  return 'sig-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}

/** Alle gespeicherten Unterschriften: Standard zuerst, dann Unterschriften vor Initialen, neueste zuerst. */
export async function listSignatures() {
  const items = (await idbList(STORE)).map((item) => item.value).filter((v) => v && v.png);
  return items.sort(
    (a, b) =>
      (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) ||
      (a.kind === 'initials' ? 1 : 0) - (b.kind === 'initials' ? 1 : 0) ||
      b.created - a.created,
  );
}

export function getSignature(id) {
  return idbGet(STORE, id);
}

/** Standard-Unterschrift (oder die neueste, falls keine markiert ist). */
export async function getDefaultSignature() {
  const items = await listSignatures();
  return (
    items.find((s) => s.isDefault && s.kind !== 'initials') ||
    items.find((s) => s.isDefault) ||
    items[0] ||
    null
  );
}

/**
 * Speichert eine neue Unterschrift. Die erste gespeicherte wird automatisch Standard.
 * @returns {Promise<object|null>} der Datensatz, `null` wenn das Speichern fehlschlug
 */
export async function addSignature({
  name,
  kind = 'signature',
  source,
  png,
  width,
  height,
  widthMm,
  heightMm,
}) {
  const existing = await listSignatures();
  const record = {
    id: newId(),
    name: (name || '').trim() || (kind === 'initials' ? 'Initialen' : 'Unterschrift'),
    kind,
    source,
    created: Date.now(),
    png,
    width,
    height,
    aspect: width / height,
    widthMm,
    heightMm,
    isDefault: !existing.some((s) => s.isDefault),
  };
  if (!(await idbPut(STORE, record.id, record))) return null;
  emit();
  return record;
}

export async function renameSignature(id, name) {
  const record = await getSignature(id);
  if (!record || !name.trim()) return false;
  record.name = name.trim();
  const ok = await idbPut(STORE, id, record);
  emit();
  return ok;
}

export async function setDefaultSignature(id) {
  for (const record of await listSignatures()) {
    const isDefault = record.id === id;
    if (!!record.isDefault !== isDefault) {
      record.isDefault = isDefault;
      await idbPut(STORE, record.id, record);
    }
  }
  emit();
}

export async function deleteSignature(id) {
  const record = await getSignature(id);
  await idbDelete(STORE, id);
  // War es die Standard-Unterschrift, wird die nächste zum Standard.
  if (record && record.isDefault) {
    const rest = await listSignatures();
    if (rest.length) {
      rest[0].isDefault = true;
      await idbPut(STORE, rest[0].id, rest[0]);
    }
  }
  emit();
}

/** Meldet Änderungen (Speichern, Umbenennen, Löschen, Standard). Rückgabe: Abmeldefunktion. */
export function onSignaturesChanged(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

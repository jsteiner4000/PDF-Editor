/**
 * Aufnahmedatum aus den EXIF-Daten eines JPEG-Fotos (DateTimeOriginal, sonst DateTime).
 * Ergebnis „JJJJ-MM-TT“ oder ‚‘, wenn das Foto kein Datum enthält.
 */

const DATE_ORIGINAL = 0x9003;
const DATE_DIGITIZED = 0x9004;
const DATE_TIME = 0x0132;
const EXIF_POINTER = 0x8769;

/** Liest den Wert einer ASCII-Marke an Position `at`. */
function ascii(view, tiff, entry, little) {
  const count = view.getUint32(entry + 4, little);
  if (count < 10 || count > 40) return '';
  const offset = count > 4 ? tiff + view.getUint32(entry + 8, little) : entry + 8;
  if (offset + count > view.byteLength) return '';
  let s = '';
  for (let i = 0; i < count - 1; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

/** Marken eines IFD: Map Tag → Eintragsposition. */
function entries(view, tiff, ifd, little) {
  const out = new Map();
  if (ifd < 8 || tiff + ifd + 2 > view.byteLength) return out;
  const count = view.getUint16(tiff + ifd, little);
  for (let i = 0; i < Math.min(count, 200); i++) {
    const at = tiff + ifd + 2 + i * 12;
    if (at + 12 > view.byteLength) break;
    out.set(view.getUint16(at, little), at);
  }
  return out;
}

function toIso(value) {
  const m = /^(\d{4}):(\d{2}):(\d{2})/.exec(value || '');
  if (!m || m[1] === '0000' || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31) return '';
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** EXIF-Datum aus den Bytes (Anfang der Datei genügt). */
export function exifDate(bytes) {
  try {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (view.getUint16(0) !== 0xffd8) return '';
    let pos = 2;
    while (pos + 4 < view.byteLength) {
      if (view.getUint8(pos) !== 0xff) return '';
      const marker = view.getUint8(pos + 1);
      const size = view.getUint16(pos + 2);
      if (marker === 0xe1 && view.getUint32(pos + 4) === 0x45786966) {
        const tiff = pos + 10;
        const little = view.getUint16(tiff) === 0x4949;
        const first = view.getUint32(tiff + 4, little);
        const ifd0 = entries(view, tiff, first, little);
        const exifAt = ifd0.get(EXIF_POINTER);
        const sub = exifAt ? entries(view, tiff, view.getUint32(exifAt + 8, little), little) : new Map();
        for (const [map, tag] of [
          [sub, DATE_ORIGINAL],
          [sub, DATE_DIGITIZED],
          [ifd0, DATE_TIME],
        ]) {
          const at = map.get(tag);
          const iso = at ? toIso(ascii(view, tiff, at, little)) : '';
          if (iso) return iso;
        }
        return '';
      }
      if (marker === 0xda || size < 2) return '';
      pos += 2 + size;
    }
  } catch {}
  return '';
}

/** Aufnahmedatum einer Bilddatei: EXIF, sonst Änderungsdatum der Datei. */
export async function photoDate(file) {
  try {
    const head = new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer());
    const iso = exifDate(head);
    if (iso) return iso;
  } catch {}
  if (!file.lastModified) return '';
  const d = new Date(file.lastModified);
  const two = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

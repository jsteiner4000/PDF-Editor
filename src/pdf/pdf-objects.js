/**
 * Kleine Hilfen für pdf-lib-Objekte (Namen, Zahlen, Stream-Inhalte, Ligaturen).
 */
import pako from 'pako';
import { PDFArray, PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';

export const pdfName = (name) => PDFName.of(name);

export const nameText = (obj) => (obj instanceof PDFName ? obj.decodeText() : null);

/** Entpackt höchstens so viele Bytes pro Stream (Schutz vor „Zip-Bomben“ in manipulierten PDFs). */
export const MAX_DECODED_BYTES = 64 * 1024 * 1024;

/** Ein Stream ist entpackt größer als erlaubt (oder lässt sich nicht sicher begrenzen). */
export class StreamTooLargeError extends Error {
  constructor() {
    super('Der Seiteninhalt ist zu groß (mehr als 64 MB entpackt).');
    this.name = 'StreamTooLargeError';
  }
}

/** Größtmögliches Verhältnis entpackt : gepackt je Filter (Flate/LZW theoretisch, Rest großzügig). */
const MAX_RATIO = { FlateDecode: 1032, Fl: 1032, LZWDecode: 3000, LZW: 3000, RunLengthDecode: 64, RL: 64 };
const SMALL_RATIO = { ASCIIHexDecode: 2, AHx: 2, ASCII85Decode: 4, A85: 4 };

function filterNames(ctx, stream) {
  const filter = ctx.lookup(stream.dict.get(PDFName.of('Filter')));
  const list =
    filter instanceof PDFArray ? filter.asArray().map((f) => ctx.lookup(f)) : filter ? [filter] : [];
  return list.map((f) => (f instanceof PDFName ? f.decodeText() : '?'));
}

/**
 * Prüft vor dem Entpacken, dass das Ergebnis höchstens `limit` Bytes groß wird. Rechnerisch
 * ausgeschlossen (gepackte Größe × größtmögliches Verhältnis ≤ Grenze) braucht keine Probe; sonst
 * wird ein Flate-Anfang bis zur Grenze probeweise entpackt und dabei abgebrochen. Andere
 * Filterketten, die sich nicht rechnerisch begrenzen lassen, werden abgelehnt.
 */
function assertDecodedSize(ctx, stream, limit) {
  const names = filterNames(ctx, stream);
  if (!names.length) return;
  const raw = stream.getContents();
  const ratio = (name) => MAX_RATIO[name] ?? SMALL_RATIO[name] ?? 1000;
  if (raw.length * names.reduce((product, name) => product * ratio(name), 1) <= limit) return;
  if (!/^(FlateDecode|Fl)$/.test(names[0])) throw new StreamTooLargeError();
  const later = names.slice(1).reduce((product, name) => product * ratio(name), 1);
  const inflater = new pako.Inflate();
  let total = 0;
  inflater.onData = (chunk) => {
    total += chunk.length;
    if (total * later > limit) throw new StreamTooLargeError();
  };
  try {
    inflater.push(raw, true);
  } catch (err) {
    if (err instanceof StreamTooLargeError) throw err;
    // beschädigter Datenstrom: wie bisher dem eigentlichen Entpacker überlassen
  }
}

export function readStreamBytes(ctx, obj, limit = MAX_DECODED_BYTES) {
  obj = obj instanceof PDFRef ? ctx.lookup(obj) : obj;
  if (!obj) return null;
  if (obj instanceof PDFRawStream) {
    assertDecodedSize(ctx, obj, limit);
    return decodePDFRawStream(obj).decode();
  }
  return obj.getContents ? obj.getContents() : null;
}

export const LIGATURES = { ff: 64256, fi: 64257, fl: 64258, ffi: 64259, ffl: 64260, st: 64262 };

export const singleCodePoint = (text) =>
  text ? ([...text].length === 1 ? text.codePointAt(0) : LIGATURES[text] || null) : null;

export const numberOf = (obj) =>
  obj instanceof PDFNumber ? obj.asNumber() : typeof obj == 'number' ? obj : 0;

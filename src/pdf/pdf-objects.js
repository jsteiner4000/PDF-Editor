/**
 * Kleine Hilfen für pdf-lib-Objekte (Namen, Zahlen, Stream-Inhalte, Ligaturen).
 */
import { PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';
import { MAX_DECODED_BYTES, assertDecodedSize } from './stream-limit.js';

export {
  MAX_CONTENT_BYTES,
  MAX_CONTENT_GLYPHS,
  MAX_CONTENT_OPERATORS,
  MAX_DECODED_BYTES,
  PageTooComplexError,
  StreamTooLargeError,
  assertDecodedSize,
  unreadablePageMessage,
} from './stream-limit.js';

export const pdfName = (name) => PDFName.of(name);

export const nameText = (obj) => (obj instanceof PDFName ? obj.decodeText() : null);

/** Inhalt eines Streams (entpackt, höchstens `limit` Bytes; sonst `StreamTooLargeError`). */
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

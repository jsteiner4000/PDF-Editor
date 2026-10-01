/**
 * Kleine Hilfen für pdf-lib-Objekte (Namen, Zahlen, Stream-Inhalte, Ligaturen).
 */
import { PDFName, PDFNumber, PDFRawStream, PDFRef, decodePDFRawStream } from 'pdf-lib';

export const pdfName = (name) => PDFName.of(name);

export const nameText = (obj) => (obj instanceof PDFName ? obj.decodeText() : null);

export function readStreamBytes(ctx, obj) {
  obj = obj instanceof PDFRef ? ctx.lookup(obj) : obj;
  return obj
    ? obj instanceof PDFRawStream
      ? decodePDFRawStream(obj).decode()
      : obj.getContents
        ? obj.getContents()
        : null
    : null;
}

export const LIGATURES = { ff: 64256, fi: 64257, fl: 64258, ffi: 64259, ffl: 64260, st: 64262 };

export const singleCodePoint = (text) =>
  text ? ([...text].length === 1 ? text.codePointAt(0) : LIGATURES[text] || null) : null;

export const numberOf = (obj) =>
  obj instanceof PDFNumber ? obj.asNumber() : typeof obj == 'number' ? obj : 0;

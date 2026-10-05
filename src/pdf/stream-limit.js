/**
 * Größenbegrenzung beim Entpacken von PDF-Streams (Schutz vor „Zip-Bomben“).
 *
 * pdf-lib entpackt ohne Obergrenze. `assertDecodedSize` prüft vorher, ob das Ergebnis die Grenze
 * einhalten wird: erst rechnerisch (gepackte Größe × größtmögliches Verhältnis je Filter), sonst
 * durch Zählen beim Entpacken (Flate und LZW; ASCII-Vorfilter werden vorab dekodiert), das bei
 * Überschreitung abbricht. Es wird nichts aufgehoben – nur gezählt.
 */
import pako from 'pako';
import { PDFArray, PDFName, PDFRawStream, decodePDFRawStream } from 'pdf-lib';

/** Entpackt höchstens so viele Bytes pro Stream (Schriften, Zuordnungstabellen …). */
export const MAX_DECODED_BYTES = 64 * 1024 * 1024;

/**
 * Für Seiteninhalte (Content-Streams) strenger: Sie werden Operator für Operator ausgewertet. Das
 * dauert bei normalem Inhalt etwa 1 s je MB, bei extrem dichtem (nur Kurzbefehle) bis zu 1,5 s
 * je MB. 8 MB sind schon sehr große Seiten (Karten, Pläne); mehr als ein paar Sekunden Wartezeit
 * entstehen so nicht. Siehe LIESMICH („Gut zu wissen“).
 */
export const MAX_CONTENT_BYTES = 8 * 1024 * 1024;

/**
 * Mehr Operatoren hat keine sinnvolle Seite (aufwendige Pläne: wenige Millionen); darüber wird
 * die Auswertung abgebrochen, bevor sie Minuten dauert.
 */
export const MAX_CONTENT_OPERATORS = 2_500_000;

/** Mehr Zeichen hat keine echte Seite (sehr dichte Tabellen: einige zehntausend). */
export const MAX_CONTENT_GLYPHS = 100_000;

/** Die Auswertung einer Seite ist zu aufwendig (zu viele Operatoren). */
export class PageTooComplexError extends Error {
  constructor() {
    super('Der Seiteninhalt ist zu komplex.');
    this.name = 'PageTooComplexError';
  }
}

/** Ein Stream ist entpackt größer als erlaubt (oder lässt sich nicht sicher begrenzen). */
export class StreamTooLargeError extends Error {
  constructor(limit = MAX_CONTENT_BYTES) {
    super(`Der Seiteninhalt ist zu groß (mehr als ${Math.round(limit / 1048576)} MB entpackt).`);
    this.name = 'StreamTooLargeError';
  }
}

/** Hinweis für Nutzer: diese Seite ist nur zum Ansehen da. */
export const unreadablePageMessage = (index) =>
  `Seite ${index + 1} kann nicht bearbeitet werden: Der Seiteninhalt ist zu groß oder zu komplex.`;

const FLATE = /^(FlateDecode|Fl)$/;
const LZW = /^(LZWDecode|LZW)$/;
const ASCII_PRE = /^(ASCIIHexDecode|AHx|ASCII85Decode|A85)$/;

/** Größtmögliches Verhältnis entpackt : gepackt je Filter (Flate/LZW theoretisch, Rest großzügig). */
const MAX_RATIO = { FlateDecode: 1032, Fl: 1032, LZWDecode: 3000, LZW: 3000, RunLengthDecode: 64, RL: 64 };
const UNKNOWN_RATIO = 1000;
const ratioOf = (name) => MAX_RATIO[name] ?? UNKNOWN_RATIO;
const product = (names) => names.reduce((p, name) => p * ratioOf(name), 1);

function filterNames(ctx, stream) {
  const filter = ctx.lookup(stream.dict.get(PDFName.of('Filter')));
  const list =
    filter instanceof PDFArray ? filter.asArray().map((f) => ctx.lookup(f)) : filter ? [filter] : [];
  return list.map((f) => (f instanceof PDFName ? f.decodeText() : '?'));
}

/** `EarlyChange` des (ersten) LZW-Filters; Standard 1. */
function earlyChange(ctx, stream, index) {
  const parms = ctx.lookup(stream.dict.get(PDFName.of('DecodeParms')));
  const own = parms instanceof PDFArray ? ctx.lookup(parms.get(index)) : parms;
  const value = own && own.get ? ctx.lookup(own.get(PDFName.of('EarlyChange'))) : null;
  return value && typeof value.asNumber === 'function' && value.asNumber() === 0 ? 0 : 1;
}

/**
 * Zählt die entpackten Bytes eines Flate-Datenstroms und bricht bei Überschreitung ab. Der
 * zlib-Kopf (2 Bytes) wird übersprungen und roh entpackt – das entspricht dem Entpacker von
 * pdf-lib, der Kopf-Felder wie die Fenstergröße nicht prüft (pako würde solche Köpfe ablehnen,
 * und eine Bombe käme ungezählt durch).
 */
function checkFlate(data, limit) {
  if (data.length < 2) return;
  const inflater = new pako.Inflate({ raw: true });
  let total = 0;
  inflater.onData = (chunk) => {
    total += chunk.length;
    if (total > limit) throw new StreamTooLargeError();
  };
  try {
    inflater.push(data.subarray(2), true);
  } catch (err) {
    if (err instanceof StreamTooLargeError) throw err;
    // beschädigter Datenstrom: endet für den eigentlichen Entpacker an derselben Stelle
  }
}

/**
 * Länge der LZW-Ausgabe (PDF-Variante, 9–12 Bit): nur die Länge je Tabelleneintrag wird geführt,
 * kein Inhalt. Bricht bei Überschreitung der Grenze ab.
 */
export function lzwDecodedLength(data, early, limit = Infinity) {
  const lengths = new Uint32Array(4097);
  let codeLength = 9;
  let next = 258;
  let previous = 0;
  let total = 0;
  let bits = 0;
  let buffer = 0;
  for (let i = 0; i < data.length; i++) {
    buffer = ((buffer << 8) | data[i]) >>> 0;
    bits += 8;
    while (bits >= codeLength) {
      const code = (buffer >>> (bits - codeLength)) & ((1 << codeLength) - 1);
      bits -= codeLength;
      buffer &= (1 << bits) - 1;
      if (code === 256) {
        codeLength = 9;
        next = 258;
        previous = 0;
        continue;
      }
      if (code === 257) return total;
      const length = code < 256 ? 1 : code < next ? lengths[code] : previous + 1;
      if (previous && next < 4096) lengths[next++] = previous + 1;
      total += length;
      if (total > limit) throw new StreamTooLargeError();
      previous = length;
      const t = next + early;
      if ((t & (t - 1)) === 0) codeLength = Math.min(Math.log2(t) + 1, 12);
    }
  }
  return total;
}

/**
 * Stellt sicher, dass das Entpacken von `stream` höchstens `limit` Bytes ergibt; sonst
 * `StreamTooLargeError`. Filterketten, die sich weder rechnerisch noch durch Zählen begrenzen
 * lassen, werden abgelehnt.
 */
function checkDecodedSize(ctx, stream, limit) {
  const names = filterNames(ctx, stream);
  if (!names.length) return;
  let data = stream.getContents();
  // ASCII-Vorfilter (Hex, ASCII85): klein (höchstens ×4) – vorab dekodieren, dann zählen
  let skipped = 0;
  while (skipped < names.length && ASCII_PRE.test(names[skipped])) skipped++;
  if (skipped && skipped < names.length) {
    const prefix = new PDFRawStream(
      ctx.obj({ Filter: names.slice(0, skipped).map((n) => PDFName.of(n)) }),
      data,
    );
    data = decodePDFRawStream(prefix).decode();
  }
  const rest = names.slice(skipped);
  if (!rest.length) return;
  if (data.length * product(rest) <= limit) return;
  const later = product(rest.slice(1));
  if (FLATE.test(rest[0])) return checkFlate(data, limit / later);
  if (LZW.test(rest[0])) {
    lzwDecodedLength(data, earlyChange(ctx, stream, skipped), limit / later);
    return;
  }
  throw new StreamTooLargeError(limit);
}

export function assertDecodedSize(ctx, stream, limit) {
  try {
    checkDecodedSize(ctx, stream, limit);
  } catch (err) {
    throw err instanceof StreamTooLargeError ? new StreamTooLargeError(limit) : err;
  }
}

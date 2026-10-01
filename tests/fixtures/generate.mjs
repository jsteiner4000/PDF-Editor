#!/usr/bin/env node
/**
 * Erzeugt die Test-PDFs für die Regressionstests (deterministisch).
 *
 *   dokument.pdf  – 3 Seiten A4 mit Kopfzeile, Seitenzahlen „1 / 3“, Text in Standardschriften
 *                   (Helvetica, Times) und eingebetteten Schriften (Barlow als Teilmenge,
 *                   IBM Plex Mono vollständig), Rechteck aus 4 Linien, Rechteck als „re“,
 *                   Linie und Bild.
 *   layout.pdf    – 1 Seite mit Blocksatz, zentriertem und rechtsbündigem Text, zwei Spalten,
 *                   Aufzählung, Silbentrennung, hochgestelltem Zeichen und Farbwechseln (für den
 *                   Aufbau der Textblöcke und den Inline-Editor).
 *
 * Aufruf: npm run fixtures
 */
import { readFile, writeFile } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  PDFDocument,
  StandardFonts,
  rgb,
  pushGraphicsState,
  popGraphicsState,
  setFillingRgbColor,
  rectangle,
  fill,
  beginText,
  endText,
  setFontAndSize,
  setWordSpacing,
  moveText,
  showText,
} from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(DIR, '..', '..');

// pdf-lib vergibt zufällige Namenszusätze für Teilmengen-Schriften – für reproduzierbare
// Dateien wird Math.random durch einen festen Pseudozufallsgenerator ersetzt.
let seed = 20261001;
Math.random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};

/** Kleines PNG (RGB, 8 Bit) aus einer Pixel-Funktion. */
function makePng(width, height, pixel) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc32 = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      const o = y * (width * 3 + 1) + 1 + x * 3;
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function dokument() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  doc.setTitle('Regressionstest PDF-Editor', { showInWindowTitleBar: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const barlow = await doc.embedFont(
    await readFile(path.join(ROOT, 'assets/fonts/embedded/Barlow-Regular.ttf')),
    { subset: true },
  );
  const mono = await doc.embedFont(
    await readFile(path.join(ROOT, 'assets/fonts/embedded/IBMPlexMono-Regular.ttf')),
    { subset: false },
  );
  const png = await doc.embedPng(
    makePng(120, 80, (x, y) => [
      Math.round((x / 119) * 255),
      Math.round((y / 79) * 255),
      160 - ((x + y) % 40),
    ]),
  );

  const total = 3;
  const W = 595.28;
  const H = 841.89;
  const ink = rgb(0.1, 0.12, 0.16);
  for (let i = 0; i < total; i++) {
    const page = doc.addPage([W, H]);
    // Kopfzeile + Linie (wiederkehrende Elemente)
    page.drawText('Testdokument PDF-Editor', { x: 56, y: 800, size: 9, font: helv, color: ink });
    page.drawLine({
      start: { x: 56, y: 792 },
      end: { x: W - 56, y: 792 },
      thickness: 0.75,
      color: rgb(0.5, 0.5, 0.5),
    });
    // Seitenzahl „n / 3“ zentriert
    const label = `${i + 1} / ${total}`;
    page.drawText(label, {
      x: W / 2 - helv.widthOfTextAtSize(label, 9) / 2,
      y: 30,
      size: 9,
      font: helv,
      color: ink,
    });
  }
  const [p1, p2, p3] = doc.getPages();

  p1.drawText('Regressionstest', { x: 56, y: 740, size: 20, font: helvBold, color: ink });
  const para = [
    'Dies ist ein Absatz in Helvetica, der über mehrere',
    'Zeilen läuft und für die Bearbeitung von Text',
    'verwendet wird.',
  ];
  para.forEach((line, k) => p1.drawText(line, { x: 56, y: 700 - k * 14, size: 11, font: helv, color: ink }));
  p1.drawText('Times Roman: Fließtext mit Umlauten äöü.', {
    x: 56,
    y: 640,
    size: 12,
    font: times,
    color: ink,
  });
  p1.drawText('Barlow eingebettet: Hallo Welt', {
    x: 56,
    y: 600,
    size: 14,
    font: barlow,
    color: rgb(0.13, 0.25, 0.75),
  });
  p1.drawText('Mono 0123456789', { x: 56, y: 570, size: 10, font: mono, color: ink });

  // Rechteck aus vier einzelnen Linien
  const blue = rgb(0.1, 0.2, 0.6);
  const box = { x0: 56, y0: 380, x1: 256, y1: 500 };
  for (const [a, b] of [
    [
      [box.x0, box.y0],
      [box.x1, box.y0],
    ],
    [
      [box.x1, box.y0],
      [box.x1, box.y1],
    ],
    [
      [box.x1, box.y1],
      [box.x0, box.y1],
    ],
    [
      [box.x0, box.y1],
      [box.x0, box.y0],
    ],
  ])
    p1.drawLine({ start: { x: a[0], y: a[1] }, end: { x: b[0], y: b[1] }, thickness: 1.5, color: blue });

  // Rechteck als „re“-Operator (gefüllt)
  p1.pushOperators(
    pushGraphicsState(),
    setFillingRgbColor(0.95, 0.55, 0.1),
    rectangle(300, 380, 200, 120),
    fill(),
    popGraphicsState(),
  );

  // freie Linie
  p1.drawLine({ start: { x: 56, y: 340 }, end: { x: 280, y: 260 }, thickness: 2, color: rgb(0.7, 0.1, 0.1) });

  // Bild
  p1.drawImage(png, { x: 320, y: 200, width: 150, height: 100 });

  p2.drawText('Seite zwei', { x: 56, y: 740, size: 16, font: helvBold, color: ink });
  p2.drawText('Zweite Seite mit etwas Text in Helvetica.', {
    x: 56,
    y: 710,
    size: 11,
    font: helv,
    color: ink,
  });
  p2.pushOperators(
    pushGraphicsState(),
    setFillingRgbColor(0.2, 0.6, 0.3),
    rectangle(56, 560, 120, 80),
    fill(),
    popGraphicsState(),
  );

  p3.drawText('Seite drei', { x: 56, y: 740, size: 16, font: helvBold, color: ink });
  p3.drawText('Letzte Seite des Testdokuments.', { x: 56, y: 710, size: 11, font: helv, color: ink });

  return doc.save({ useObjectStreams: false });
}

async function layout() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.registerFontkit(fontkit);
  doc.setTitle('Layouttest PDF-Editor', { showInWindowTitleBar: false });
  const helv = await doc.embedFont(StandardFonts.Helvetica);
  const helvBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const times = await doc.embedFont(StandardFonts.TimesRoman);
  const barlow = await doc.embedFont(
    await readFile(path.join(ROOT, 'assets/fonts/embedded/Barlow-Regular.ttf')),
    { subset: true },
  );
  const ink = rgb(0.1, 0.12, 0.16);
  const page = doc.addPage([595.28, 841.89]);

  // zentrierte Überschrift
  const title = 'Zentrierte Überschrift';
  page.drawText(title, {
    x: (595.28 - helvBold.widthOfTextAtSize(title, 18)) / 2,
    y: 780,
    size: 18,
    font: helvBold,
    color: ink,
  });

  // Blocksatz über Wortabstand (Tw): jede Zeile außer der letzten ist genau 300 pt breit
  const justified = [
    'Dieser Absatz ist im Blocksatz gesetzt und',
    'hat deshalb unterschiedlich breite Abstände',
    'zwischen den einzelnen Wörtern jeder Zeile,',
    'nur die letzte Zeile ist linksbündig.',
  ];
  page.setFont(times);
  const timesKey = page.fontKey;
  const ops = [
    pushGraphicsState(),
    beginText(),
    setFontAndSize(timesKey, 11),
    setFillingRgbColor(0.1, 0.12, 0.16),
  ];
  justified.forEach((line, k) => {
    const spaces = line.split(' ').length - 1;
    const tw = k === justified.length - 1 ? 0 : (300 - times.widthOfTextAtSize(line, 11)) / spaces;
    ops.push(
      setWordSpacing(tw),
      k === 0 ? moveText(56, 730) : moveText(0, -14),
      showText(times.encodeText(line)),
    );
  });
  ops.push(setWordSpacing(0), endText(), popGraphicsState());
  page.pushOperators(...ops);

  // rechtsbündig
  for (const [k, line] of ['Rechtsbündiger Text', 'in zwei Zeilen'].entries())
    page.drawText(line, {
      x: 539 - helv.widthOfTextAtSize(line, 10),
      y: 650 - k * 13,
      size: 10,
      font: helv,
      color: ink,
    });

  // zwei Spalten
  const colA = ['Linke Spalte mit etwas', 'Text, der in der Spalte', 'bleibt.'];
  const colB = ['Rechte Spalte daneben,', 'ebenfalls mehrzeilig', 'gesetzt.'];
  colA.forEach((l, k) => page.drawText(l, { x: 56, y: 580 - k * 13, size: 10, font: helv, color: ink }));
  colB.forEach((l, k) => page.drawText(l, { x: 320, y: 580 - k * 13, size: 10, font: helv, color: ink }));

  // Aufzählung
  ['• Erster Punkt der Liste', '• Zweiter Punkt der Liste', '• Dritter Punkt'].forEach((l, k) =>
    page.drawText(l, { x: 56, y: 500 - k * 14, size: 11, font: helv, color: ink }),
  );

  // Silbentrennung am Zeilenende
  ['Ein Absatz mit Silben-', 'trennung am Zeilenende und', 'einer weiteren Zeile.'].forEach((l, k) =>
    page.drawText(l, { x: 56, y: 420 - k * 14, size: 11, font: barlow, color: ink }),
  );

  // Farbwechsel und hochgestelltes Zeichen in einer Zeile
  page.drawText('Farbe:', { x: 56, y: 340, size: 12, font: helv, color: ink });
  page.drawText('rot', {
    x: 56 + helv.widthOfTextAtSize('Farbe: ', 12),
    y: 340,
    size: 12,
    font: helv,
    color: rgb(0.8, 0.1, 0.1),
  });
  page.drawText('und m', {
    x: 56 + helv.widthOfTextAtSize('Farbe: rot ', 12),
    y: 340,
    size: 12,
    font: helv,
    color: ink,
  });
  page.drawText('2', {
    x: 56 + helv.widthOfTextAtSize('Farbe: rot und m', 12),
    y: 345,
    size: 7,
    font: helv,
    color: ink,
  });
  return doc.save({ useObjectStreams: false });
}

for (const [name, make] of [
  ['dokument.pdf', dokument],
  ['layout.pdf', layout],
]) {
  const bytes = await make();
  await writeFile(path.join(DIR, name), bytes);
  console.log(`tests/fixtures/${name} geschrieben (${bytes.length} Bytes)`);
}

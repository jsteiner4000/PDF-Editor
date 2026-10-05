#!/usr/bin/env node
// Erzeugt alle Symbol-Exporte aus der Vorlage in quelle/.
//
//   node assets/icon/build-icons.mjs
//
// Quelle:   quelle/pdfix-konzept-2.jpg – Seite „Konzept 2 · PDFix · Glas-Ebenen“ aus der
//           Logo-Mappe (3720 × 2340 px). Das Symbol sitzt dort in einem Quadrat von 1367 px
//           (CROP); seine Kontur ist eine Superellipse (Apples kontinuierliche Rundung) mit dem
//           gemessenen Exponenten 5,04.
// Ausgabe:  png/icon-<n>.png (16 … 1024), icon.png (512, Electron/Linux),
//           icon.ico (Windows, PNG-komprimiert), icon.icns (macOS)
//
// Gerendert wird mit Chromium über Playwright: Ausschnitt in Stufen halbiert verkleinern
// (gute Glättung), dann mit der Superellipse freistellen. Playwright wird lokal oder aus dem
// globalen npm-Verzeichnis geladen; es wird kein Browser heruntergeladen.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_PNG = path.join(DIR, 'png');
const SOURCE = path.join(DIR, 'quelle', 'pdfix-konzept-2.jpg');
/** Lage des Symbols in der Vorlage (Pixel) und Form der Kontur. */
const CROP = { x: 288, y: 486, size: 1367 };
const EXPONENT = 5.04;
/** Kontur um so viele Vorlagen-Pixel nach innen: entfernt den hellen JPEG-Saum des Hintergrunds. */
const INSET = 2.5;
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// macOS: OSType -> Pixelgröße (alle Einträge als PNG; seit OS X 10.7 zulässig)
const ICNS_ENTRIES = [
  ['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128],
  ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024],
];

function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    try {
      return createRequire(path.join(DIR, '..', '..', 'package.json'))('@playwright/test');
    } catch {
      const globalRoot = execSync('npm root -g').toString().trim();
      return createRequire(path.join(globalRoot, '/'))('playwright');
    }
  }
}

async function renderAll() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  const result = await page.evaluate(
    async ({ b64, crop, exponent, inset, sizes }) => {
      const img = new Image();
      img.src = 'data:image/jpeg;base64,' + b64;
      await img.decode();
      const out = {};
      for (const size of sizes) {
        // Ausschnitt so oft halbieren, bis er höchstens doppelt so groß wie das Ziel ist
        let canvas = document.createElement('canvas');
        canvas.width = canvas.height = crop.size;
        canvas.getContext('2d').drawImage(img, crop.x, crop.y, crop.size, crop.size, 0, 0, crop.size, crop.size);
        while (canvas.width / 2 >= size) {
          const half = document.createElement('canvas');
          half.width = half.height = Math.round(canvas.width / 2);
          const g = half.getContext('2d');
          g.imageSmoothingQuality = 'high';
          g.drawImage(canvas, 0, 0, half.width, half.height);
          canvas = half;
        }
        const target = document.createElement('canvas');
        target.width = target.height = size;
        const g = target.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(canvas, 0, 0, size, size);
        // Freistellen: Superellipse |x|^n + |y|^n = a^n
        const a = size / 2 - (inset * size) / crop.size;
        g.globalCompositeOperation = 'destination-in';
        g.beginPath();
        for (let k = 0; k <= 720; k++) {
          const t = (k / 720) * 2 * Math.PI;
          const c = Math.cos(t);
          const s = Math.sin(t);
          const x = size / 2 + a * Math.sign(c) * Math.abs(c) ** (2 / exponent);
          const y = size / 2 + a * Math.sign(s) * Math.abs(s) ** (2 / exponent);
          if (k === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.closePath();
        g.fill();
        out[size] = target.toDataURL('image/png').split(',')[1];
      }
      return out;
    },
    { b64: fs.readFileSync(SOURCE).toString('base64'), crop: CROP, exponent: EXPONENT, inset: INSET, sizes: SIZES },
  );
  await browser.close();
  return new Map(SIZES.map((size) => [size, Buffer.from(result[size], 'base64')]));
}

// ICO: ICONDIR + ICONDIRENTRY je Bild, Bilddaten als PNG (Vista+). 256 wird als 0 kodiert.
function buildIco(pngs, sizes) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  const entries = [];
  const images = [];
  let offset = 6 + 16 * sizes.length;
  for (const size of sizes) {
    const data = pngs.get(size);
    const e = Buffer.alloc(16);
    e.writeUInt8(size >= 256 ? 0 : size, 0);
    e.writeUInt8(size >= 256 ? 0 : size, 1);
    e.writeUInt8(0, 2); // keine Palette
    e.writeUInt8(0, 3);
    e.writeUInt16LE(1, 4); // Farbebenen
    e.writeUInt16LE(32, 6); // Bit pro Pixel
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    entries.push(e);
    images.push(data);
  }
  return Buffer.concat([header, ...entries, ...images]);
}

// ICNS: 'icns' + Gesamtlaenge, danach je Eintrag OSType + Laenge (inkl. 8 Byte Kopf) + PNG.
function buildIcns(pngs, entries) {
  const chunks = entries.map(([type, size]) => {
    const data = pngs.get(size);
    const head = Buffer.alloc(8);
    head.write(type, 0, 'ascii');
    head.writeUInt32BE(data.length + 8, 4);
    return Buffer.concat([head, data]);
  });
  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

const pngs = await renderAll();
fs.mkdirSync(OUT_PNG, { recursive: true });
for (const [size, data] of pngs) fs.writeFileSync(path.join(OUT_PNG, `icon-${size}.png`), data);
fs.writeFileSync(path.join(DIR, 'icon.png'), pngs.get(512));
fs.writeFileSync(path.join(DIR, 'icon.ico'), buildIco(pngs, ICO_SIZES));
fs.writeFileSync(path.join(DIR, 'icon.icns'), buildIcns(pngs, ICNS_ENTRIES));
console.log(`Fertig: ${pngs.size} PNG, icon.png, icon.ico (${ICO_SIZES.join('/')}), icon.icns`);

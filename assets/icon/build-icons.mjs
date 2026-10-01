#!/usr/bin/env node
// Erzeugt alle Symbol-Exporte aus den SVG-Quellen in diesem Ordner.
//
//   node assets/icon/build-icons.mjs
//
// Quellen:  icon.svg        Master (1024er macOS-Raster), ab 64 px
//           icon-small.svg  vereinfachtes Kleinformat, fuer 16-48 px
// Ausgabe:  png/icon-<n>.png (16 … 1024), icon.png (512, Electron/Linux),
//           icon.ico (Windows, PNG-komprimiert), icon.icns (macOS)
//
// Gerendert wird mit Chromium ueber Playwright: jede Groesse direkt aus dem Vektor,
// nicht herunterskaliert. Playwright wird lokal oder aus dem globalen npm-Verzeichnis
// geladen; es wird kein Browser heruntergeladen. Chromium-Pfad optional ueber
// PLAYWRIGHT_BROWSERS_PATH bzw. CHROMIUM_PATH.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const OUT_PNG = path.join(DIR, 'png');
const SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const SMALL_MAX = 48; // bis einschliesslich dieser Kantenlaenge gilt icon-small.svg (48 px: Master waere zu fein)
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
// macOS: OSType -> Pixelgroesse (alle Eintraege als PNG; seit OS X 10.7 zulaessig)
const ICNS_ENTRIES = [
  ['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128],
  ['ic13', 256], ['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024],
];

function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch {
    const globalRoot = execSync('npm root -g').toString().trim();
    return createRequire(path.join(globalRoot, '/'))('playwright');
  }
}

async function renderAll() {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  const sources = {
    big: fs.readFileSync(path.join(DIR, 'icon.svg')),
    small: fs.readFileSync(path.join(DIR, 'icon-small.svg')),
  };
  const pngs = new Map();
  for (const size of SIZES) {
    const svg = size <= SMALL_MAX ? sources.small : sources.big;
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">` +
        `<img id="i" style="display:block;width:${size}px;height:${size}px" ` +
        `src="data:image/svg+xml;base64,${svg.toString('base64')}"></body></html>`,
    );
    await page.waitForFunction(() => document.getElementById('i').complete);
    pngs.set(size, await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
  }
  await browser.close();
  return pngs;
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

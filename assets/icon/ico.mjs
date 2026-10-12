// Gemeinsame Hilfen der Symbol-Skripte: Playwright laden, ICO-Datei zusammensetzen.
import path from 'node:path';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));

/** Playwright lokal, aus dem Repository (@playwright/test) oder global laden – ohne Browser-Download. */
export function loadPlaywright() {
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

// ICO: ICONDIR + ICONDIRENTRY je Bild, Bilddaten als PNG (Vista+). 256 wird als 0 kodiert.
export function buildIco(pngs, sizes) {
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

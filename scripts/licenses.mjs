#!/usr/bin/env node
/**
 * Schreibt dist/licenses/Lizenzhinweise.txt: Lizenztexte aller in den Editor eingebundenen
 * Bibliotheken (Produktionsabhängigkeiten laut package-lock.json, ohne optionale Node-Pakete)
 * und der mitgelieferten Schriften. Wird mit der Desktop-App ausgeliefert (Hilfe-Menü).
 *
 * Aufruf: node scripts/licenses.mjs
 */
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'dist', 'licenses');
const FONT_DIR = path.join(ROOT, 'assets', 'fonts', 'full');

async function licenseText(dir) {
  const names = (await readdir(dir)).filter((f) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(f));
  if (!names.length) return null;
  return (await readFile(path.join(dir, names[0]), 'utf8')).trim();
}

const lock = JSON.parse(await readFile(path.join(ROOT, 'package-lock.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const packages = Object.entries(lock.packages)
  .filter(
    ([key, info]) => key.startsWith('node_modules/') && !info.dev && !info.optional && !info.devOptional,
  )
  .map(([key, info]) => ({ name: key.replace(/^.*node_modules\//, ''), dir: path.join(ROOT, key), info }))
  .sort((a, b) => a.name.localeCompare(b.name));

const line = '='.repeat(78);
const parts = [
  `PDFix ${pkg.version} – Lizenzhinweise`,
  '',
  'PDFix enthält die folgenden Bibliotheken und Schriften Dritter. Die Desktop-App',
  'basiert zusätzlich auf Electron (MIT) und Chromium; deren Lizenzen liegen im',
  'Programmordner (LICENSE.electron.txt, LICENSES.chromium.html).',
  '',
];

for (const { name, dir, info } of packages) {
  const text = await licenseText(dir);
  parts.push(line, `${name} ${info.version} – ${info.license || 'siehe Lizenztext'}`, line, '');
  parts.push(text || `Lizenz: ${info.license} (kein Lizenztext im Paket enthalten)`, '');
}

for (const file of (await readdir(FONT_DIR)).filter((f) => /^Lizenz_.*\.txt$/.test(f)).sort()) {
  const title = 'Schrift ' + file.replace(/^Lizenz_|\.txt$/g, '') + ' – SIL Open Font License 1.1';
  parts.push(line, title, line, '', (await readFile(path.join(FONT_DIR, file), 'utf8')).trim(), '');
}

await mkdir(OUT_DIR, { recursive: true });
await writeFile(path.join(OUT_DIR, 'Lizenzhinweise.txt'), parts.join('\r\n').replace(/\r?\n/g, '\r\n'));
console.log(`dist/licenses/Lizenzhinweise.txt geschrieben (${packages.length} Pakete)`);

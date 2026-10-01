#!/usr/bin/env node
/**
 * Baut dist/PDF-Editor.html: eine einzige, offline lauffähige HTML-Datei.
 *
 * - App-Code (src/) wird mit esbuild zu einem IIFE gebündelt und inline eingebettet.
 * - Der pdf.js-Worker wird separat gebündelt und als Quelltext-String eingebettet
 *   (zur Laufzeit als Blob-URL gestartet, siehe src/render/pdf-renderer.js).
 * - Die mitgelieferten Schriften (assets/fonts/embedded) werden gzip-komprimiert
 *   als base64 eingebettet (Entpacken zur Laufzeit per DecompressionStream).
 *
 * Aufruf: node scripts/build.mjs [--watch]
 */
import * as esbuild from 'esbuild';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { watch } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const OUT_FILE = path.join(ROOT, 'dist', 'PDF-Editor.html');
const FONT_DIR = path.join(ROOT, 'assets', 'fonts', 'embedded');
const FAVICON = path.join(ROOT, 'assets', 'icon', 'favicon-1.0.svg');

/** Bündelt den pdf.js-Worker als klassisches Skript (IIFE). */
async function buildWorkerSource() {
  const result = await esbuild.build({
    entryPoints: [path.join(ROOT, 'node_modules/pdfjs-dist/build/pdf.worker.mjs')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    minify: true,
    write: false,
    logLevel: 'error',
    legalComments: 'none',
  });
  return result.outputFiles[0].text;
}

/** Liest die einzubettenden Schriften: [{ name, data: base64(gzip(ttf)) }]. */
async function loadBundledFonts() {
  const files = (await readdir(FONT_DIR)).filter((f) => /\.(ttf|otf)$/i.test(f)).sort();
  const fonts = [];
  for (const name of files) {
    const bytes = await readFile(path.join(FONT_DIR, name));
    fonts.push({ name, data: gzipSync(bytes, { level: 9 }).toString('base64') });
  }
  return fonts;
}

/** esbuild-Plugin für die virtuellen Module "virtual:pdfjs-worker" und "virtual:bundled-fonts". */
function virtualModules(contents) {
  return {
    name: 'virtual-modules',
    setup(build) {
      build.onResolve({ filter: /^virtual:/ }, (args) => ({ path: args.path, namespace: 'virtual' }));
      build.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => {
        if (!(args.path in contents)) throw new Error('Unbekanntes virtuelles Modul: ' + args.path);
        return { contents: contents[args.path], loader: 'js' };
      });
    },
  };
}

/** SVG als data:-URI (gleiche Kodierung wie in Version 1.0). */
function svgDataUri(svg) {
  return 'data:image/svg+xml,' + svg.trim().replace(/[%<>"()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, key) => {
    if (!(key in values)) throw new Error('Platzhalter ohne Wert: ' + key);
    return values[key];
  });
}

export async function build() {
  const started = Date.now();
  const [workerSource, fonts] = await Promise.all([buildWorkerSource(), loadBundledFonts()]);
  const result = await esbuild.build({
    entryPoints: [path.join(SRC, 'main.js')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    minify: true,
    write: false,
    logLevel: 'warning',
    legalComments: 'none',
    plugins: [
      virtualModules({
        'virtual:pdfjs-worker': 'export default ' + JSON.stringify(workerSource) + ';',
        'virtual:bundled-fonts': 'export default ' + JSON.stringify(fonts) + ';',
      }),
    ],
  });
  const script = result.outputFiles[0].text;
  if (/<\/script/i.test(script)) throw new Error('Das Skript enthält "</script" und kann nicht inline eingebettet werden.');
  const [template, styles, favicon] = await Promise.all([
    readFile(path.join(SRC, 'index.html'), 'utf8'),
    readFile(path.join(SRC, 'styles.css'), 'utf8'),
    readFile(FAVICON, 'utf8'),
  ]);
  const html = fill(template, { FAVICON: svgDataUri(favicon), STYLES: styles, SCRIPT: script });
  await mkdir(path.dirname(OUT_FILE), { recursive: true });
  await writeFile(OUT_FILE, html);
  const kb = (n) => (n / 1024).toFixed(0) + ' KB';
  console.log(`dist/PDF-Editor.html geschrieben (${kb(html.length)}, Skript ${kb(script.length)}, Worker ${kb(workerSource.length)}) in ${Date.now() - started} ms`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await build();
  if (process.argv.includes('--watch')) {
    let timer = null;
    const rebuild = () => {
      clearTimeout(timer);
      timer = setTimeout(() => build().catch((e) => console.error(e.message)), 100);
    };
    for (const dir of [SRC, path.join(ROOT, 'assets')]) watch(dir, { recursive: true }, rebuild);
    console.log('Beobachte src/ und assets/ – Änderungen bauen dist/PDF-Editor.html neu.');
  }
}

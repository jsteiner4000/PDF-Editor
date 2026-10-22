/**
 * Updates über GitHub-Releases: neuestes Release abfragen, Setup laden (eigene Sitzung – die
 * Sitzung der App bleibt ohne Netzwerk), Größe und SHA-256-Prüfsumme prüfen, Installer starten.
 * Es wird nur die Versionsnummer abgefragt; keine Daten der Nutzer werden übertragen.
 */
import { app, session } from 'electron';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { LATEST_URL, allowedUrl, pickUpdate } from './update-check.js';

/** Höchstens einmal je 20 Stunden von selbst nachsehen. */
const AUTO_INTERVAL = 20 * 3600 * 1000;

let net = null;
const fetchNet = (url, init) => {
  net ||= session.fromPartition('plantpdf-updates', { cache: false });
  return net.fetch(url, { ...init, headers: { 'User-Agent': `PlantPDF/${app.getVersion()}`, ...(init && init.headers) } });
};

/** Abbruch einer hängenden Verbindung: nach `ms` ohne neue Daten. */
function stallGuard(ms) {
  const ctrl = new AbortController();
  let timer = setTimeout(() => ctrl.abort(), ms);
  return {
    signal: ctrl.signal,
    alive() {
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), ms);
    },
    done: () => clearTimeout(timer),
    abort: () => ctrl.abort(),
  };
}

/** Laufender Download (zum Abbrechen beim Beenden). */
let current = null;
export const abortDownload = () => current && current.abort();

const stateFile = () => path.join(app.getPath('userData'), 'update.json');
function readState() {
  try {
    return JSON.parse(readFileSync(stateFile(), 'utf8')) || {};
  } catch {
    return {};
  }
}

/** Ist eine Prüfung beim Start fällig? */
export function autoCheckDue() {
  return Date.now() - (Number(readState().lastCheck) || 0) >= AUTO_INTERVAL;
}

/** Erfolgreiche Prüfung merken (offline zählt nicht – dann beim nächsten Start erneut). */
export function rememberCheck() {
  try {
    writeFileSync(stateFile(), JSON.stringify({ lastCheck: Date.now() }));
  } catch {}
}

/** Neueres Release oder null; wirft bei fehlender Verbindung. */
export async function checkForUpdate() {
  const guard = stallGuard(20000);
  let r;
  try {
    r = await fetchNet(LATEST_URL, { headers: { Accept: 'application/vnd.github+json' }, signal: guard.signal });
  } finally {
    guard.done();
  }
  if (r.status === 404) return null; // noch kein Release
  if (!r.ok) throw new Error(`GitHub antwortet nicht (${r.status})`);
  return pickUpdate(await r.json(), app.getVersion());
}

/** Setup laden und prüfen; `onProgress(0…1)`. Liefert den Pfad der geprüften Datei. */
export async function downloadUpdate(info, onProgress = () => {}) {
  const dir = path.join(app.getPath('temp'), 'PlantPDF-Update');
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, `PlantPDF-Setup-${info.version}.exe`);
  // ältere Setups aufräumen
  for (const name of await fs.readdir(dir).catch(() => []))
    if (name !== path.basename(file) && /^PlantPDF-Setup-.*\.exe(\.part)?$/.test(name)) await fs.rm(path.join(dir, name), { force: true }).catch(() => {});
  // schon geladen und unverändert: nicht noch einmal laden
  if (existsSync(file) && (await sha256File(file)) === info.sha256) return file;
  const guard = (current = stallGuard(30000));
  const hash = createHash('sha256');
  let out = null;
  let got = 0;
  try {
    const r = await fetchNet(info.url, { signal: guard.signal });
    // Electron liefert nach Weiterleitungen oft keine Ziel-Adresse (r.url leer) – dann zählt allein die
    // Prüfsumme; ist eine Adresse da, muss sie zu GitHub gehören
    if (!r.ok) throw new Error(`Download fehlgeschlagen (HTTP ${r.status})`);
    if (!r.body || (r.url && !allowedUrl(r.url))) throw new Error('Download fehlgeschlagen (unerwartete Adresse)');
    out = await fs.open(file + '.part', 'w');
    const reader = r.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      guard.alive();
      if (done) break;
      got += value.length;
      if (got > info.size) throw new Error('Datei größer als angekündigt');
      hash.update(value);
      await out.write(value);
      onProgress(got / info.size);
    }
  } finally {
    guard.done();
    current = null;
    if (out) await out.close();
  }
  if (got !== info.size || hash.digest('hex') !== info.sha256) {
    await fs.rm(file + '.part', { force: true });
    throw new Error('Prüfsumme stimmt nicht');
  }
  await fs.rename(file + '.part', file);
  return file;
}

async function sha256File(file) {
  const hash = createHash('sha256');
  hash.update(await fs.readFile(file));
  return hash.digest('hex');
}

/** Installer still starten (er schließt PlantPDF, installiert und startet es neu); erfüllt, sobald er läuft. */
export function runInstaller(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, ['/S', '--updated', '--force-run'], { detached: true, stdio: 'ignore' });
    child.once('error', reject);
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
  });
}

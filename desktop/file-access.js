/**
 * Dateizugriff für den Renderer – eng begrenzt:
 *
 * - Zugriff nur auf Dateien, die der Nutzer selbst gewählt hat (Öffnen-/Speichern-Dialog,
 *   Kommandozeile/Doppelklick, Drag & Drop). Für jede solche Datei wird eine zufällige Kennung
 *   vergeben; der Renderer kennt nur Kennung und Dateinamen, nie den Pfad.
 * - Schreiben nur in .pdf-Dateien, atomar (temporäre Datei im selben Ordner, dann umbenennen).
 * - Die Freigaben werden (begrenzt) in userData/file-grants.json gespeichert, damit
 *   „Zuletzt geöffnet“ nach einem Neustart funktioniert.
 */
import { app } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const MAX_GRANTS = 200;
const MAX_READ_BYTES = 1024 * 1024 * 1024; // 1 GB

const isPdfPath = (p) => /\.pdf$/i.test(p);

export class FileAccess {
  constructor(storeFile = path.join(app.getPath('userData'), 'file-grants.json')) {
    this.storeFile = storeFile;
    /** @type {Map<string, string>} Kennung → absoluter Pfad (Reihenfolge = zuletzt benutzt zuletzt) */
    this.grants = new Map();
    try {
      const saved = JSON.parse(readFileSync(storeFile, 'utf8'));
      for (const [id, p] of saved)
        if (typeof id === 'string' && typeof p === 'string') this.grants.set(id, p);
    } catch {}
  }

  persist() {
    try {
      mkdirSync(path.dirname(this.storeFile), { recursive: true });
      writeFileSync(this.storeFile, JSON.stringify([...this.grants]));
    } catch {}
  }

  /** Gibt eine vom Nutzer gewählte Datei frei; dieselbe Datei behält ihre Kennung. */
  grant(filePath) {
    const abs = path.resolve(filePath);
    let id = null;
    for (const [key, p] of this.grants)
      if (process.platform === 'win32' ? p.toLowerCase() === abs.toLowerCase() : p === abs) id = key;
    if (id) this.grants.delete(id);
    else id = randomUUID();
    this.grants.set(id, abs);
    while (this.grants.size > MAX_GRANTS) this.grants.delete(this.grants.keys().next().value);
    this.persist();
    return { id, name: path.basename(abs) };
  }

  pathOf(id) {
    const p = typeof id === 'string' ? this.grants.get(id) : undefined;
    if (!p) throw new Error('Kein Zugriff auf diese Datei.');
    return p;
  }

  async read(id) {
    const p = this.pathOf(id);
    const stat = await fs.stat(p);
    if (!stat.isFile()) throw new Error('Keine Datei.');
    if (stat.size > MAX_READ_BYTES) throw new Error('Die Datei ist zu groß.');
    const data = await fs.readFile(p);
    return {
      name: path.basename(p),
      data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
      lastModified: stat.mtimeMs,
    };
  }

  async write(id, data) {
    const p = this.pathOf(id);
    if (!isPdfPath(p)) throw new Error('Nur PDF-Dateien können gespeichert werden.');
    if (!(data instanceof Uint8Array)) throw new Error('Ungültige Daten.');
    const tmp = path.join(path.dirname(p), `.${path.basename(p)}.${process.pid}.${Date.now()}.tmp`);
    try {
      await fs.writeFile(tmp, data, { flag: 'wx' });
      await fs.rename(tmp, p);
    } catch (err) {
      await fs.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Freigabe für per Drag & Drop abgelegte Dateien (Pfad stammt aus webUtils.getPathForFile). */
  async grantDropped(filePath) {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || !isPdfPath(filePath)) return null;
    const stat = await fs.stat(filePath).catch(() => null);
    return stat && stat.isFile() ? this.grant(filePath) : null;
  }
}

/** PDF-Pfade aus einer Kommandozeile (Doppelklick, „Öffnen mit“, zweite Instanz). */
export function pdfPathsFromArgv(argv, cwd = process.cwd()) {
  return argv
    .slice(1)
    .filter((arg) => arg && !arg.startsWith('-') && isPdfPath(arg))
    .map((arg) => path.resolve(cwd, arg))
    .filter((abs) => {
      try {
        return statSync(abs).isFile();
      } catch {
        return false;
      }
    });
}

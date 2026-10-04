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

/** Verständliche Meldungen (ohne Pfade) für Dateifehler; Schlüssel = Node-Fehlercode. */
const MESSAGES = {
  read: {
    ENOENT: 'Die Datei wurde nicht gefunden – sie wurde verschoben, umbenannt oder gelöscht.',
    EACCES: 'Keine Berechtigung, die Datei zu lesen.',
    EPERM: 'Keine Berechtigung, die Datei zu lesen.',
    EBUSY: 'Die Datei wird gerade von einem anderen Programm verwendet.',
    EISDIR: 'Das ist keine Datei.',
    TOOLARGE: 'Die Datei ist zu groß (höchstens 1 GB).',
  },
  write: {
    READONLY: 'Die Datei ist schreibgeschützt. Bitte „Speichern unter“ verwenden.',
    EACCES:
      'Keine Berechtigung, in diesen Ordner oder diese Datei zu schreiben. Bitte „Speichern unter“ verwenden.',
    EPERM: 'Die Datei ist schreibgeschützt oder gesperrt. Bitte „Speichern unter“ verwenden.',
    EBUSY:
      'Die Datei wird gerade von einem anderen Programm verwendet. Bitte dort schließen und erneut speichern.',
    ENOSPC: 'Auf dem Datenträger ist nicht genug Speicherplatz frei.',
    EDQUOT: 'Auf dem Datenträger ist nicht genug Speicherplatz frei.',
    ENOENT: 'Der Ordner der Datei existiert nicht mehr. Bitte „Speichern unter“ verwenden.',
    EROFS: 'Der Datenträger ist schreibgeschützt. Bitte „Speichern unter“ verwenden.',
    EISDIR: 'Das Ziel ist keine Datei.',
    NOTPDF: 'Es können nur PDF-Dateien gespeichert werden.',
    BADDATA: 'Ungültige Daten.',
  },
  any: { NOGRANT: 'Kein Zugriff auf diese Datei. Bitte die Datei erneut öffnen.' },
};

/** Fehler mit deutscher Meldung ohne Pfad (geht so an den Renderer). */
export class FileAccessError extends Error {
  constructor(code, op = 'write') {
    super(
      MESSAGES.any[code] ||
        MESSAGES[op][code] ||
        (op === 'read'
          ? 'Die Datei konnte nicht gelesen werden.'
          : 'Die Datei konnte nicht gespeichert werden.') + (code ? ` (${code})` : ''),
    );
    this.code = code;
  }
  static from(err, op) {
    if (err instanceof FileAccessError) return new FileAccessError(err.code, op);
    return new FileAccessError(err && typeof err.code === 'string' ? err.code : '', op);
  }
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/**
 * Umbenennen; unter Windows mit Wiederholungen, weil Virenscanner, Suchindex oder OneDrive
 * die Datei kurzzeitig sperren (EPERM/EBUSY/EACCES).
 */
async function renameWithRetry(from, to) {
  const delays = process.platform === 'win32' ? [50, 100, 200, 400, 800] : [];
  for (let attempt = 0; ; attempt++) {
    try {
      return await fs.rename(from, to);
    } catch (err) {
      if (attempt >= delays.length || !RETRY_CODES.has(err.code)) throw err;
      await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

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
    const p = typeof id === 'string' && this.grants.has(id) ? this.grants.get(id) : undefined;
    if (!p) throw new FileAccessError('NOGRANT');
    return p;
  }

  async read(id) {
    const p = this.pathOf(id);
    try {
      const stat = await fs.stat(p);
      if (!stat.isFile()) throw new FileAccessError('EISDIR');
      if (stat.size > MAX_READ_BYTES) throw new FileAccessError('TOOLARGE');
      const data = await fs.readFile(p);
      return {
        name: path.basename(p),
        data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
        lastModified: stat.mtimeMs,
      };
    } catch (err) {
      throw FileAccessError.from(err, 'read');
    }
  }

  /**
   * Schreibt atomar: temporäre Datei im Zielordner (gleiche Rechte, fsync), dann umbenennen.
   * Symbolische Links werden aufgelöst (geschrieben wird das Ziel, der Link bleibt).
   * Schreibgeschützte Dateien werden abgelehnt statt per Umbenennen ersetzt.
   */
  async write(id, data) {
    const p = this.pathOf(id);
    if (!isPdfPath(p)) throw new FileAccessError('NOTPDF');
    if (!(data instanceof Uint8Array)) throw new FileAccessError('BADDATA');
    let tmp = null;
    try {
      let target = p;
      let mode;
      try {
        target = await fs.realpath(p);
        const stat = await fs.stat(target);
        if (!stat.isFile()) throw new FileAccessError('EISDIR');
        if (!(stat.mode & 0o200)) throw new FileAccessError('READONLY');
        mode = stat.mode & 0o7777;
      } catch (err) {
        if (err.code !== 'ENOENT') throw err; // gelöschte Datei: neu anlegen, falls der Ordner existiert
      }
      tmp = path.join(path.dirname(target), `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`);
      const fh = await fs.open(tmp, 'wx', mode ?? 0o666);
      try {
        await fh.writeFile(data);
        await fh.sync();
      } finally {
        await fh.close();
      }
      if (mode !== undefined) await fs.chmod(tmp, mode).catch(() => {}); // umask ausgleichen
      await renameWithRetry(tmp, target);
      tmp = null;
    } catch (err) {
      throw FileAccessError.from(err, 'write');
    } finally {
      if (tmp) await fs.rm(tmp, { force: true }).catch(() => {});
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

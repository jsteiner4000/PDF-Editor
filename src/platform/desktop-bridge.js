/**
 * Anbindung an die Desktop-App (Electron, siehe desktop/).
 *
 * Im Browser ist dieses Modul wirkungslos. In der Desktop-App stellt das Preload-Skript
 * `window.pdfEditorDesktop` bereit (eng begrenzte IPC-API, siehe desktop/preload.cjs). Darauf
 * aufbauend bildet dieses Modul die Teile der File System Access API nach, die die App nutzt
 * (`showOpenFilePicker`, `showSaveFilePicker`, `DataTransferItem.getAsFileSystemHandle`,
 * `FileSystemFileHandle.getFile/createWritable`). Die App selbst bleibt dadurch unverändert:
 * „Speichern“ überschreibt die geöffnete Datei, „Zuletzt geöffnet“ funktioniert weiter.
 *
 * Dateipfade erreichen die Seite nie: Der Hauptprozess vergibt für jede vom Nutzer gewählte
 * Datei (Dialog, Kommandozeile, Drag & Drop) eine zufällige Kennung, und nur diese Kennung wird
 * im Renderer (und in IndexedDB für „Zuletzt geöffnet“) gespeichert.
 *
 * Außerdem: Menübefehle des nativen Menüs ausführen, Fenstertitel/„Bearbeitet“-Zustand melden,
 * per Kommandozeile/Doppelklick übergebene Dateien öffnen, vor dem Schließen speichern.
 */

const desktop = typeof window !== 'undefined' ? window.pdfEditorDesktop : undefined;

/** true, wenn die Seite in der Desktop-App läuft. */
export const isDesktop = !!desktop;

const abortError = () => new DOMException('Der Vorgang wurde abgebrochen.', 'AbortError');

/** Dateifehler aus dem Hauptprozess: Meldung ist ein deutscher Satz ohne Pfad. */
const fileError = (err) =>
  Object.assign(new Error(err && err.message ? err.message : String(err)), {
    desktopReason: err && err.message ? err.message : '',
  });

/** Lesbarer Grund eines Dateifehlers der Desktop-App (sonst null, z. B. im Browser). */
export function fileErrorReason(err) {
  return (err && err.desktopReason) || null;
}

async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data && data.type === 'write' && data.position == null) return toBytes(data.data);
  throw new TypeError('Nicht unterstützter Schreibvorgang');
}

/**
 * Datei-Handle der Desktop-App (Gegenstück zu FileSystemFileHandle). Eigene Felder sind
 * strukturiert klonbar ({ kind, name, desktopId }), damit die App das Handle wie bisher in
 * IndexedDB („Zuletzt geöffnet“) ablegen kann; `reviveFileHandle` stellt es wieder her.
 */
class DesktopFileHandle {
  constructor(id, name) {
    this.kind = 'file';
    this.name = name;
    this.desktopId = id;
  }
  async getFile() {
    const { name, data, lastModified } = await desktop.readFile(this.desktopId).catch((err) => {
      throw fileError(err);
    });
    this.name = name;
    return new File([data], name, { type: 'application/pdf', lastModified });
  }
  async createWritable() {
    const id = this.desktopId;
    const chunks = [];
    return {
      async write(data) {
        chunks.push(await toBytes(data));
      },
      async close() {
        const size = chunks.reduce((n, c) => n + c.length, 0);
        const all = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) all.set(c, (offset += c.length) - c.length);
        await desktop.writeFile(id, all).catch((err) => {
          throw fileError(err);
        });
      },
      async abort() {
        chunks.length = 0;
      },
    };
  }
  async queryPermission() {
    return 'granted';
  }
  async requestPermission() {
    return 'granted';
  }
  async isSameEntry(other) {
    return !!other && other.desktopId === this.desktopId;
  }
}

const toHandle = (entry) => (entry ? new DesktopFileHandle(entry.id, entry.name) : null);

/**
 * Stellt ein aus IndexedDB gelesenes Handle der Desktop-App wieder her (dort liegt nur
 * { kind, name, desktopId }). Im Browser und für echte Handles: unverändert zurück.
 */
export function reviveFileHandle(handle) {
  if (desktop && handle && typeof handle.getFile !== 'function' && handle.desktopId)
    return new DesktopFileHandle(handle.desktopId, handle.name);
  return handle;
}

let app = null;
let stateTimer = 0;

/** Meldet Dokumentname und „Bearbeitet“-Zustand an den Hauptprozess (Fenstertitel, Rückfrage). */
export function notifyDocumentState() {
  if (!desktop || !app || stateTimer) return;
  // verzögert, damit Titel und Dateiname nach dem auslösenden Vorgang feststehen
  stateTimer = setTimeout(() => {
    stateTimer = 0;
    const session = app.session;
    desktop.setState({
      hasDocument: !!session,
      name: session && app.file ? app.file.name : '',
      dirty: !!(session && session.dirty),
    });
  }, 0);
}

const inEditableField = () => {
  const el = document.activeElement;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

/** Befehle aus dem nativen Menü (desktop/menu.js) und Anfragen des Hauptprozesses. */
const COMMANDS = {
  open: () => app.openDialog(),
  save: () => (app.session ? app.save() : false),
  saveAs: () => (app.session ? app.saveAs() : false),
  print: () => app.session && app.print(),
  properties: () => app.session && app.props(),
  closeDocument: () => app.close(),
  undo: () => (inEditableField() ? document.execCommand('undo') : app.session && app.undo()),
  redo: () => (inEditableField() ? document.execCommand('redo') : app.session && app.redo()),
  zoomIn: () => app.session && app.zoomStep(1),
  zoomOut: () => app.session && app.zoomStep(-1),
  zoomActual: () => app.session && app.setZoom(1, null, false, app.selectionAnchor()),
  zoomSelection: () => app.session && app.zoomToSelection(),
  zoomWidth: () => app.session && app.setZoom(null, 'width'),
  zoomPage: () => app.session && app.setZoom(null, 'page'),
  /** Vor dem Schließen: offene Textbearbeitung übernehmen und den echten Zustand liefern. */
  queryDirty: async () => {
    if (!app.session) return false;
    await app.finishEdit();
    return !!(app.session && app.session.dirty);
  },
};

/**
 * Richtet die Desktop-Anbindung ein (nur in der Desktop-App). Aufruf einmal nach dem Start
 * der App (src/main.js).
 */
export function installDesktopBridge(appInstance) {
  if (!desktop) return;
  app = appInstance;
  // Plattform-Klasse: Stile für die Desktop-App (z. B. ohne In-App-Menü „Datei“, siehe styles.css)
  document.documentElement.classList.add('desktop');

  window.showOpenFilePicker = async () => {
    const entry = await desktop.showOpenDialog();
    if (!entry) throw abortError();
    return [toHandle(entry)];
  };
  window.showSaveFilePicker = async (options = {}) => {
    const entry = await desktop.showSaveDialog(options.suggestedName || '');
    if (!entry) throw abortError();
    return toHandle(entry);
  };
  // Drag & Drop: Die App fragt das Handle synchron im drop-Ereignis ab.
  if (window.DataTransferItem)
    DataTransferItem.prototype.getAsFileSystemHandle = function () {
      const file = this.kind === 'file' ? this.getAsFile() : null;
      return file ? desktop.grantDroppedFile(file).then(toHandle) : Promise.resolve(null);
    };

  desktop.onCommand(async (command, fromMenu) => {
    const run = COMMANDS[command];
    // Menübefehle nicht ausführen, solange ein Dialog der App offen ist (wie die Tastenkürzel)
    if (!run || (fromMenu && document.querySelector('.backdrop'))) return undefined;
    return run();
  });
  // Strg+P: „Anzeigen und drucken“ (die Web-App kennt kein eigenes Kürzel dafür)
  window.addEventListener('keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (!mod || ev.shiftKey || ev.altKey || ev.key.toLowerCase() !== 'p') return;
    ev.preventDefault();
    if (app.session && !document.querySelector('.backdrop')) app.print();
  });
  desktop.onOpenFile((entry) => app.openHandle(toHandle(entry)));

  const title = document.querySelector('title');
  if (title) new MutationObserver(notifyDocumentState).observe(title, { childList: true });
  notifyDocumentState();
  desktop.ready();
}

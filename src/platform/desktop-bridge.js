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

import { toast } from '../ui/dialogs.js';
import { showUpdate, updateProgress } from '../ui/update-banner.js';
import { applyTheme, readTheme } from '../ui/theme.js';
import { installTitleBar } from './title-bar.js';
import { installTabStrip } from './tab-strip.js';

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
    // „Dokumentation erstellen“: Fenstertitel = Projekt; Entwürfe sichern sich selbst (nie „Bearbeitet“).
    // Jeder Tab hat genau ein Dokument – das Projekt zählt auch, wenn es gerade nicht sichtbar ist.
    const project = app.studio.project && (studioActive() || !session) ? app.studio.title() : '';
    desktop.setState({
      hasDocument: !!session || !!project,
      name: project || (session && app.file ? app.file.name : ''),
      dirty: !project && !!(session && session.dirty),
      stripActive: !!app.stripActive,
      pdfOpen: !!session,
      siteOpen: !!(app.studio.project && app.studio.project.sections.some((s) => s.type === 'site')),
      studioOpen: !!app.studio.project,
      workspace: app.workspace,
      fileId: (session && app.file && app.file.handle && app.file.handle.desktopId) || '',
      projectId: (app.studio.project && app.studio.project.id) || '',
      theme: readTheme(),
    });
  }, 0);
}

/** Ist „Dokumentation erstellen“ der sichtbare Bereich? */
const studioActive = () => app.view === 'studio' && !!app.studio.project;

/** Zoom im sichtbaren Bereich (PDF oder Dokumentation). */
const zoom = (doc, studio) => (studioActive() ? studio() : app.session && doc());

const inEditableField = () => {
  const el = document.activeElement;
  return !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
};

/** Befehle aus dem nativen Menü (desktop/menu.js) und Anfragen des Hauptprozesses. */
const COMMANDS = {
  /** Tab-Leiste des Fensters (vom Hauptprozess). */
  tabs: (data) => app.tabHost && app.tabHost.render(data),
  /** In diesem (neuen) Tab öffnen: PDF-Bytes ohne Datei bzw. einen Entwurf der Dokumentation. */
  openBytes: (data) => data && data.bytes instanceof Uint8Array && app.openBytes(data.bytes, String(data.name || 'Dokument.pdf'), null),
  openDraft: (data) => data && typeof data.id === 'string' && app.studio.openDraft(data.id),
  setWorkspace: (ws) => app.switchWorkspace(ws),
  /** Nur im ersten Tab nach dem Start: gesicherte Kopien anbieten. */
  offerRecovery: () => app.recovery.offer(),
  /** Darstellung in einem anderen Tab geändert. */
  themeChanged: () => applyTheme(),
  /** Beim Start gefunden: dezenter Hinweis unten rechts (nur im installierten Programm). */
  updateAvailable: (data) => showUpdate(data, () => desktop.installUpdate()),
  updateProgress: (data) => updateProgress(data && data.p),
  open: () => app.openDialog(),
  save: () => (app.session || studioActive() ? app.save() : false),
  saveAs: () => (app.session || studioActive() ? app.saveAs() : false),
  print: () => (app.session || studioActive()) && app.print(),
  properties: () => app.session && app.props(),
  closeDocument: () => app.close(),
  stripActive: () => app.toggleStripActive(),
  settings: () => app.settings(),
  'ws:pdf': () => app.switchWorkspace('pdf'),
  'ws:docs': () => app.switchWorkspace('docs'),
  ...Object.fromEntries(
    ['edit', 'addtext', 'addimage', 'organize', 'insert', 'formdesign', 'signature', 'fonts'].map((tool) => [
      'tool:' + tool,
      () => app.toolFromMenu(tool),
    ]),
  ),
  ...Object.fromEntries(
    ['symbols', 'again', 'ptp', 'ptmp', 'fence', 'line', 'free', 'scale', 'measure', 'renumber'].map((tool) => ['site:' + tool, () => app.siteFromMenu(tool)]),
  ),
  'studio:image': () => app.studioFromMenu('image'),
  'studio:qr': () => app.studioFromMenu('qr'),
  'studio:topdf': () => app.studioFromMenu('topdf'),
  undo: () => (inEditableField() ? document.execCommand('undo') : (app.session || studioActive()) && app.undo()),
  redo: () => (inEditableField() ? document.execCommand('redo') : (app.session || studioActive()) && app.redo()),
  zoomIn: () => zoom(() => app.zoomStep(1), () => app.studio.zoomStep(1)),
  zoomOut: () => zoom(() => app.zoomStep(-1), () => app.studio.zoomStep(-1)),
  zoomActual: () => zoom(() => app.setZoom(1, null, false, app.selectionAnchor()), () => app.studio.setZoom(1)),
  zoomSelection: () => app.session && app.zoomToSelection(),
  zoomWidth: () => zoom(() => app.setZoom(null, 'width'), () => app.studio.setZoom(null)),
  zoomPage: () => app.session && app.setZoom(null, 'page'),
  /** Schnelldruck: PDF (Bytes vom Hauptprozess) laden, Seiten einzeln als PNG holen, schließen. */
  printOpen: (data) => (data instanceof Uint8Array ? app.printOpen(data) : null),
  printPage: (data) =>
    data && Number.isInteger(data.n) && Number.isFinite(data.dpi)
      ? app.printPage(data.id, data.n, Math.min(600, Math.max(72, data.dpi)))
      : null,
  printClose: (id) => app.printClose(id),
  printed: (name) => toast(`„${String(name || '')}“ wurde an den Drucker gesendet.`),
  /** Vor dem Schließen: offene Textbearbeitung übernehmen und den echten Zustand liefern. */
  queryDirty: async () => {
    if (app.studio.project) await app.studio.flush(); // letzten Stand des Entwurfs sichern
    if (!app.session) return false;
    await app.finishEdit();
    // nicht (mehr) geändert, z. B. bis zum gespeicherten Stand rückgängig: keine Kopie zurücklassen
    if (!app.session.dirty) await app.recovery.clear();
    // Name für die Rückfrage: die PDF, auch wenn gerade die Dokumentation sichtbar ist
    return app.session && app.session.dirty ? { dirty: true, name: app.file ? app.file.name : '' } : false;
  },
  /** Rückfrage beim Beenden: die PDF speichern (nicht „PDF erstellen“ der Dokumentation). */
  saveDocument: async () => {
    const ok = app.session ? await app.saveDocument() : false;
    if (ok) await app.recovery.clear();
    return ok;
  },
  /** Rückfrage beim Beenden: „Nicht speichern“ – die Wiederherstellungs-Kopie verwerfen. */
  discardRecovery: () => app.recovery.clear(),
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
  if (desktop.platform !== 'darwin') installTitleBar(desktop);
  if (desktop.tabs) app.tabHost = installTabStrip(desktop.tabs, app);
  // Fenstertasten des Systems: In einer Tab-Ansicht kennt CSS ihren Platz nicht (env(titlebar-area-*)),
  // also fester Abstand rechts (Windows: 3 × 46 px)
  if (desktop.platform !== 'darwin' && !(navigator.windowControlsOverlay && navigator.windowControlsOverlay.visible))
    document.documentElement.style.setProperty('--wco-pad', '150px');

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

  desktop.onCommand(async (command, fromMenu, data) => {
    const run = COMMANDS[command];
    // Menübefehle nicht ausführen, solange ein Dialog der App offen ist (wie die Tastenkürzel)
    if (!run || (fromMenu && document.querySelector('.backdrop'))) return undefined;
    return run(data);
  });
  // Strg+P: „Anzeigen und drucken“ (die Web-App kennt kein eigenes Kürzel dafür)
  window.addEventListener('keydown', (ev) => {
    const mod = ev.ctrlKey || ev.metaKey;
    if (!mod || ev.shiftKey || ev.altKey || ev.key.toLowerCase() !== 'p') return;
    if (app.view === 'studio') return; // Dokumentation: eigenes Strg+P (studio.onKey)
    ev.preventDefault();
    if (app.session && !document.querySelector('.backdrop')) app.print();
  });
  desktop.onOpenFile((entry) => app.openHandle(toHandle(entry)));

  const title = document.querySelector('title');
  if (title) new MutationObserver(notifyDocumentState).observe(title, { childList: true });
  notifyDocumentState();
  desktop.ready();
  notifyDocumentState(); // Stand des Schalters „Aktive Inhalte entfernen“ ins Menü
}

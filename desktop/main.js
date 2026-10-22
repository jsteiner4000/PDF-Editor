/**
 * PlantPDF als Desktop-App (Electron-Hauptprozess).
 *
 * Lädt den gebauten Single-File-Editor (dist/PDF-Editor.html) über das eigene Schema
 * app://pdf-editor/ – ohne Netzwerk, ohne Node-Zugriff im Renderer. Dateien werden über eine
 * eng begrenzte IPC-API gelesen und geschrieben (desktop/file-access.js, desktop/preload.cjs).
 *
 * Sicherheit (Electron Security Checklist): contextIsolation, sandbox, kein nodeIntegration,
 * strikte CSP (Skript nur per Hash), keine Remote-Inhalte (http/https/ws/file werden
 * blockiert), Navigation und neue Fenster gesperrt (Ausnahme: die eigene PDF-Vorschau als
 * blob:-URL), alle Berechtigungsanfragen abgelehnt, IPC-Absender werden geprüft, keine
 * Telemetrie. Updates: nur die Versionsabfrage bei GitHub in eigener Sitzung (desktop/updater.js).
 */
import { app, BaseWindow, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, protocol, screen, session, shell, WebContentsView } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAccess, FileAccessError, pdfPathsFromArgv, printRequestFromArgv } from './file-access.js';
import { htmlToPdf, printPages, printResponse } from './quick-print.js';
import { buildMenu, DOCUMENT_ITEMS, PDF_TOOLS, SITE_TOOLS, STUDIO_TOOLS } from './menu.js';
import { loadWindowState, rememberTheme, trackWindowState, DEFAULT_SIZE, MIN_SIZE } from './window-state.js';
import { abortDownload, autoCheckDue, checkForUpdate, downloadUpdate, rememberCheck, runInstaller } from './updater.js';

const APP_NAME = 'PlantPDF';
/**
 * Eigene Titelleiste (Windows/Linux, wie Office und VS Code): Die Kopfzeile der App trägt Menü,
 * Reiter und Befehle; die Fenstertasten legt das System darüber (Window Controls Overlay). macOS
 * behält Ampel und Menü am oberen Bildschirmrand.
 */
const CUSTOM_FRAME = process.platform !== 'darwin';
/** = Höhe der Kopfzeile (#top in src/styles.css) */
const TITLEBAR_HEIGHT = 48;
/** Farben wie die Kopfzeile der App (--bg / --ink, hell bzw. dunkel). */
const frameColors = () =>
  nativeTheme.shouldUseDarkColors
    ? { background: '#15181d', overlay: { color: '#15181d', symbolColor: '#e6e9ee', height: TITLEBAR_HEIGHT } }
    : { background: '#f2f3f5', overlay: { color: '#f2f3f5', symbolColor: '#1f2329', height: TITLEBAR_HEIGHT } };
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCHEME = 'app';
const ORIGIN = `${SCHEME}://pdf-editor`;
const START_URL = `${ORIGIN}/`;
const EDITOR_HTML = path.join(ROOT, 'dist', 'PDF-Editor.html');
const ICON = path.join(ROOT, 'assets', 'icon', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
const LICENSE_FILE = app.isPackaged
  ? path.join(process.resourcesPath, 'Lizenzen', 'Lizenzhinweise.txt')
  : path.join(ROOT, 'dist', 'licenses', 'Lizenzhinweise.txt');
const FONT_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'Schriften')
  : path.join(ROOT, 'assets', 'fonts', 'full');

// Im ausgelieferten Programm keine Fernsteuerung: Debug-Schalter führen zum Beenden (die Fuses
// sperren --inspect bereits; --remote-debugging-* würde sonst den DevTools-Server öffnen).
if (app.isPackaged && process.argv.some((a) => /^--(remote-debugging-|inspect|debug)/i.test(a))) {
  console.error('PlantPDF: Debug-Schalter sind im ausgelieferten Programm nicht erlaubt.');
  app.exit(1);
}

// Tests/Entwicklung: eigener Datenordner (Einstellungen, IndexedDB, Freigaben). Sonst bleibt es beim
// Ordner aus der Zeit vor der Umbenennung, damit Unterschriften und Einstellungen erhalten bleiben.
app.setPath(
  'userData',
  process.env.PDF_EDITOR_USER_DATA
    ? path.resolve(process.env.PDF_EDITOR_USER_DATA)
    : path.join(app.getPath('appData'), 'PDF-Editor'),
);

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('de.jsteiner.pdfeditor');

protocol.registerSchemesAsPrivileged([
  // codeCache: Chromium legt den übersetzten Programmcode (V8) ab – ab dem zweiten Start lädt die
  // App schneller. Gilt nur für eigene Skriptdateien, deshalb wird das Skript als /app.js geliefert.
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  /**
   * Fenster mit Tabs (wie Chrome): Jeder Tab ist eine eigene Programmansicht (WebContentsView) mit
   * genau einem Dokument – PDF oder Dokumentation – bzw. die Startseite. Tabs lassen sich ordnen,
   * aus dem Fenster ziehen (neues Fenster) und in ein anderes Fenster ziehen; die Ansicht wandert
   * dabei mit, samt Rückgängig-Verlauf.
   *
   * @typedef {{ id: number, base: BaseWindow, tabs: Tab[], active: Tab | null, allowClose: boolean, closing: boolean }} Win
   * @typedef {{ id: number, view: WebContentsView, win: Win, state: object, ready: boolean, gone: boolean, closed: boolean, open: object | null, primary: boolean }} Tab
   */
  /** @type {Win[]} */
  const wins = [];
  let lastFocused = null;
  let nextId = 1;
  /** @type {FileAccess} */
  let files = null;
  let firstReady = false;
  const pendingPaths = pdfPathsFromArgv(process.argv);
  // Schnelldruck (Windows-Verb „Drucken“): ohne sichtbares Fenster drucken und wieder beenden,
  // sofern der Nutzer währenddessen nichts anderes öffnet
  const firstPrint = printRequestFromArgv(process.argv);
  let printOnly = !!firstPrint && !pendingPaths.length;
  let printQueue = Promise.resolve();
  let printCount = 0; // nur für Tests (PDF_EDITOR_PRINT_TO_PDF)
  const pendingPrints = firstPrint ? [withBytes(firstPrint)] : [];
  // Hängt der Start im reinen Druckmodus, beendet sich das unsichtbare Programm von selbst
  if (printOnly) setTimeout(() => !firstReady && endPrintOnly(), 60000);
  // Alt-Taste (Windows/Linux): Menüleiste nicht fokussieren, wenn Alt mit der Maus benutzt wurde
  let altDown = false;
  let altUsedWithMouse = false;
  let menu = null;
  const replies = new Map();

  const emptyState = () => ({ hasDocument: false, name: '', dirty: false, pdfOpen: false, siteOpen: false, studioOpen: false, fileId: '', projectId: '', workspace: 'pdf' });
  const allTabs = () => wins.flatMap((w) => w.tabs);
  const tabOf = (contents) => allTabs().find((t) => !t.closed && t.view.webContents === contents) || null;
  const alive = (w) => !!w && !w.base.isDestroyed();
  const focusedWin = () => (alive(lastFocused) ? lastFocused : wins.find(alive)) || null;
  const activeTab = () => focusedWin()?.active || null;
  const baseOf = (tab) => (tab && alive(tab.win) ? tab.win.base : focusedWin()?.base) || undefined;
  /** Meldung über dem Fenster (ohne Fenster frei stehend). */
  const showMessage = (parent, options) => (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
  const usable = (tab) => !!tab && !tab.gone && !tab.closed && !tab.view.webContents.isDestroyed();
  // Für die Desktop-Tests (nicht im ausgelieferten Programm): Fenster und aktive Ansicht
  if (!app.isPackaged)
    globalThis.__plantpdf = {
      win: () => focusedWin()?.base,
      contents: () => activeTab()?.view.webContents,
      tabs: () => allTabs().map((t) => ({ id: t.id, win: t.win.id, name: t.state.name, hasDocument: t.state.hasDocument, active: t.win.active === t })),
      windows: () => wins.length,
      winId: () => focusedWin()?.id,
      boundsOf: (id) => wins.find((w) => w.id === id)?.base.getContentBounds(),
    };

  /**
   * Befehl an einen Tab (ohne Angabe: der aktive Tab des vorderen Fensters); mit `wait` wird auf
   * die Antwort gewartet. Menübefehle (`fromMenu`) ignoriert die Web-App bei offenem Dialog.
   */
  function command(name, { tab = null, wait = false, timeout = 0, fromMenu = false, data = undefined } = {}) {
    tab ||= activeTab();
    if (!usable(tab)) return wait ? Promise.reject(new Error('renderer-gone')) : Promise.resolve(null);
    const wc = tab.view.webContents;
    if (!wait) {
      wc.send('app:command', { command: name, fromMenu, data });
      return Promise.resolve(null);
    }
    const replyId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timeout ? setTimeout(() => (replies.delete(replyId), reject(new Error('timeout'))), timeout) : 0;
      replies.set(replyId, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      });
      replies.get(replyId).timer = timer;
      replies.get(replyId).tab = tab;
      wc.send('app:command', { command: name, replyId, data });
    });
  }

  /* ---------- Fenster und Tabs ---------- */

  function createWin({ bounds = null, show = true } = {}) {
    const first = !wins.length;
    const saved = loadWindowState();
    const { theme, ...rest } = saved;
    if (first) nativeTheme.themeSource = theme;
    const colors = frameColors();
    const base = new BaseWindow({
      ...(bounds || rest),
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      title: APP_NAME,
      icon: ICON,
      show: false,
      backgroundColor: colors.background,
      ...(CUSTOM_FRAME ? { titleBarStyle: 'hidden', titleBarOverlay: colors.overlay } : {}),
    });
    /** @type {Win} */
    const w = { id: nextId++, base, tabs: [], active: null, allowClose: false, closing: false };
    wins.push(w);
    if (first) {
      // immer bildschirmfüllend starten (maximiert, Taskleiste bleibt sichtbar; F11 = echtes Vollbild)
      if (!printOnly) base.maximize();
      trackWindowState(base);
    }
    for (const ev of ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore']) base.on(ev, () => layout(w));
    base.on('focus', () => {
      lastFocused = w;
      updateTitle(w);
      if (usable(w.active)) w.active.view.webContents.focus();
    });
    base.on('close', (e) => {
      if (w.allowClose) return;
      e.preventDefault();
      if (w.closing) return;
      w.closing = true;
      confirmWindow(w)
        .then((ok) => {
          if (ok && alive(w)) {
            w.allowClose = true;
            base.close();
          } else quitting = false; // Beenden abgebrochen
        })
        .finally(() => (w.closing = false));
    });
    base.on('closed', () => {
      for (const t of w.tabs) disposeTab(t);
      w.tabs = [];
      wins.splice(wins.indexOf(w), 1);
      if (lastFocused === w) lastFocused = null;
      // letztes Fenster: Vorschaufenster gehören dazu
      if (!wins.length) for (const other of BrowserWindow.getAllWindows()) other.destroy();
    });
    if (show && !printOnly) setImmediate(() => alive(w) && base.show());
    lastFocused = w;
    return w;
  }

  function layout(w) {
    if (!alive(w)) return;
    const { width, height } = w.base.getContentBounds();
    for (const t of w.tabs) if (!t.closed) t.view.setBounds({ x: 0, y: 0, width, height });
  }

  /** Neuer Tab; `open` = was er nach dem Start öffnet ({ kind: 'file'|'bytes'|'draft', … }). */
  function createTab(w, { open = null, activate = true, index = w.tabs.length, primary = false } = {}) {
    const view = new WebContentsView({
      webPreferences: {
        preload: path.join(ROOT, 'desktop', 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        devTools: !app.isPackaged,
      },
    });
    view.setBackgroundColor(frameColors().background);
    /** @type {Tab} */
    const tab = { id: nextId++, view, win: w, state: emptyState(), ready: false, gone: false, closed: false, open, primary };
    if (open) Object.assign(tab.state, placeholder(open));
    w.tabs.splice(Math.max(0, Math.min(index, w.tabs.length)), 0, tab);
    w.base.contentView.addChildView(view);
    layout(w);
    hookTab(tab);
    view.webContents.setVisualZoomLevelLimits(1, 1);
    view.webContents.loadURL(START_URL);
    if (activate || !w.active) activateTab(tab);
    else view.setVisible(false);
    broadcastTabs(w);
    return tab;
  }

  /** Name und Art eines Tabs, bis sein Dokument geladen ist. */
  const placeholder = (open) => ({
    hasDocument: true,
    name: String(open.name || (open.entry && open.entry.name) || (open.kind === 'draft' ? 'Dokumentation' : 'Dokument')),
    pdfOpen: open.kind !== 'draft',
    studioOpen: open.kind === 'draft',
    fileId: open.kind === 'file' ? open.entry.id : '',
    projectId: open.kind === 'draft' ? open.id : '',
  });

  function activateTab(tab) {
    const w = tab.win;
    w.active = tab;
    for (const t of w.tabs) t.view.setVisible(t === tab);
    // nach vorn (Reihenfolge der Ansichten)
    w.base.contentView.addChildView(tab.view);
    if (usable(tab) && w.base.isFocused()) tab.view.webContents.focus();
    updateTitle(w);
    broadcastTabs(w);
  }

  function focusTab(tab) {
    const w = tab.win;
    if (printOnly) {
      printOnly = false;
      w.base.show();
    }
    if (w.base.isMinimized()) w.base.restore();
    w.base.show();
    w.base.focus();
    activateTab(tab);
  }

  function disposeTab(tab) {
    if (tab.closed) return;
    tab.closed = true;
    for (const [replyId, done] of replies)
      if (done.tab === tab) {
        replies.delete(replyId);
        clearTimeout(done.timer);
        done({ error: 'renderer-gone' });
      }
    try {
      if (alive(tab.win)) tab.win.base.contentView.removeChildView(tab.view);
    } catch {}
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
  }

  /** Tab entfernen (ohne Rückfrage); das letzte Dokument eines Fensters macht der Startseite Platz. */
  function removeTab(tab) {
    const w = tab.win;
    const i = w.tabs.indexOf(tab);
    if (i < 0) return;
    w.tabs.splice(i, 1);
    disposeTab(tab);
    if (!w.tabs.length) createTab(w);
    else if (w.active === tab) activateTab(w.tabs[Math.min(i, w.tabs.length - 1)]);
    broadcastTabs(w);
  }

  /** Tab schließen mit Rückfrage bei Änderungen. */
  async function closeTab(tab) {
    if (tab.closing) return false;
    tab.closing = true;
    try {
      // (confirmClose holt den Tab nur nach vorn, wenn er wirklich fragen muss)
      if (!(await confirmClose(tab))) return false;
    } finally {
      tab.closing = false;
    }
    if (tab.closed) return true;
    if (tab.win.tabs.length === 1 && !tab.state.hasDocument) return true;
    if (tab.win.tabs.length === 1) {
      // einziger Tab: Startseite daneben öffnen, dann diesen entfernen
      createTab(tab.win);
    }
    removeTab(tab);
    return true;
  }

  /** Tab in ein Fenster verschieben (an Stelle `index`). */
  function moveTab(tab, target, index = target.tabs.length) {
    const from = tab.win;
    if (from === target) return;
    const i = from.tabs.indexOf(tab);
    from.tabs.splice(i, 1);
    from.base.contentView.removeChildView(tab.view);
    tab.win = target;
    target.tabs.splice(Math.max(0, Math.min(index, target.tabs.length)), 0, tab);
    target.base.contentView.addChildView(tab.view);
    layout(target);
    focusTab(tab);
    if (!from.tabs.length) {
      from.allowClose = true;
      from.base.close();
    } else {
      if (from.active === tab) activateTab(from.tabs[Math.min(i, from.tabs.length - 1)]);
      broadcastTabs(from);
    }
  }

  /** Tab-Leiste eines Fensters (Bildschirmkoordinaten)? */
  function stripContains(w, x, y) {
    if (!alive(w) || w.base.isMinimized()) return false;
    const b = w.base.getContentBounds();
    return x >= b.x && x <= b.x + b.width && y >= b.y - 8 && y <= b.y + TITLEBAR_HEIGHT + 12;
  }

  /** Tab außerhalb der eigenen Leiste losgelassen: in ein anderes Fenster oder ein neues. */
  function dropTab(tab, x, y) {
    const target = wins.find((w) => w !== tab.win && stripContains(w, x, y));
    if (target) return moveTab(tab, target);
    const from = tab.win;
    if (stripContains(from, x, y)) return;
    if (from.tabs.length === 1) return; // einziger Tab: das Fenster bleibt, wie es ist
    const size = from.base.isMaximized() ? DEFAULT_SIZE : from.base.getBounds();
    const w = createWin({ bounds: { x: Math.round(x - 160), y: Math.round(y - 18), width: size.width, height: size.height } });
    moveTab(tab, w, 0);
  }

  /** Neuer Tab mit einem Dokument – oder der Tab, in dem es schon offen ist. */
  function openInTab(w, open) {
    const same = allTabs().find(
      (t) => !t.closed && ((open.kind === 'file' && t.state.fileId === open.entry.id) || (open.kind === 'draft' && t.state.projectId === open.id)),
    );
    if (same) return focusTab(same);
    // Startseite ohne Dokument: dort öffnen (wie ein neuer Tab im Browser)
    const start = w.active && !w.active.state.hasDocument && w.active.ready ? w.active : null;
    if (start) return deliver(start, open);
    focusTab(createTab(w, { open }));
  }

  function deliver(tab, open) {
    Object.assign(tab.state, placeholder(open));
    broadcastTabs(tab.win);
    updateTitle(tab.win);
    if (open.kind === 'file') tab.view.webContents.send('app:open-file', open.entry);
    else if (open.kind === 'bytes') command('openBytes', { tab, data: { bytes: open.bytes, name: open.name } });
    else if (open.kind === 'draft') command('openDraft', { tab, data: { id: open.id } });
    else if (open.kind === 'recover') command('restoreRecovery', { tab, data: { id: open.id } });
  }

  /** Startseite eines Fensters zeigen (vorhandene oder neue); `ws`: Arbeitsbereich dort. */
  function homeTab(w, ws = null) {
    let start = w.tabs.find((t) => !t.state.hasDocument);
    if (!start) start = createTab(w, { activate: true });
    else activateTab(start);
    if (ws === 'pdf' || ws === 'docs') {
      if (start.ready) command('setWorkspace', { tab: start, data: ws });
      else start.workspace = ws;
    }
  }

  /** Allen Tabs eines Fensters die Tab-Leiste schicken. */
  function broadcastTabs(w) {
    if (!alive(w)) return;
    const list = w.tabs
      .filter((t) => !t.closed)
      .map((t) => ({ id: t.id, name: t.state.name, dirty: !!t.state.dirty, kind: t.state.studioOpen ? 'docs' : t.state.hasDocument ? 'pdf' : 'home' }));
    for (const t of w.tabs) if (t.ready && usable(t)) t.view.webContents.send('app:command', { command: 'tabs', data: { tabs: list, active: w.active ? w.active.id : 0, self: t.id } });
  }

  function openPath(filePath) {
    const entry = files.grant(filePath);
    app.addRecentDocument(filePath);
    const w = focusedWin();
    if (!w || !firstReady) return pendingPaths.push(filePath);
    if (printOnly) {
      printOnly = false;
      w.base.show();
    }
    if (w.base.isMinimized()) w.base.restore();
    w.base.focus();
    openInTab(w, { kind: 'file', entry });
  }

  /** Ein bereiter Tab für den Schnelldruck (der erste). */
  const printTab = () => allTabs().find((t) => t.ready && usable(t)) || null;

  /**
   * Schnelldruck einer Datei (nacheinander, falls Outlook mehrere Anhänge schickt). Fehler
   * erscheinen als Meldung; im reinen Druckmodus beendet sich das Programm danach.
   */
  function quickPrint(job) {
    const run = printQueue.then(async () => {
      let printId = null;
      const tab = printTab();
      try {
        const data = await job.bytes;
        const info = await command('printOpen', { tab, wait: true, timeout: 120000, data });
        if (!info || !info.pages) throw new Error('Die Datei enthält keine druckbaren Seiten.');
        printId = info.id;
        if (info.pages > MAX_PRINT_PAGES)
          throw new Error(`Die Datei hat zu viele Seiten für den Schnelldruck (höchstens ${MAX_PRINT_PAGES}).`);
        // seitenweise (keine riesige Einzelnachricht)
        // Druckerauflösung (600 dpi): Schrift und Linien bleiben scharf; bei vielen Seiten weniger,
        // damit Speicher und Druckauftrag überschaubar bleiben
        const dpi = info.pages <= 20 ? 600 : info.pages <= 60 ? 300 : 200;
        const pages = [];
        for (let n = 1; n <= info.pages; n++) pages.push(await command('printPage', { tab, wait: true, timeout: 60000, data: { id: printId, n, dpi } }));
        const toPdf = !app.isPackaged && process.env.PDF_EDITOR_PRINT_TO_PDF;
        const pdf = await printPages(ORIGIN, pages, { printer: job.printer, toPdf: !!toPdf });
        if (toPdf && pdf) {
          printCount++;
          writeFileSync(printCount === 1 ? toPdf : toPdf.replace(/(\.pdf)?$/i, `-${printCount}.pdf`), pdf);
        }
        if (!printOnly) command('printed', { tab, data: path.basename(job.path) });
      } catch (err) {
        const options = {
          type: 'error',
          title: APP_NAME,
          message: `„${path.basename(job.path)}“ konnte nicht gedruckt werden.`,
          detail: printErrorText(err, job.printer),
          buttons: ['OK'],
          noLink: true,
        };
        await (printOnly || !focusedWin() ? dialog.showMessageBox(options) : dialog.showMessageBox(focusedWin().base, options));
      } finally {
        if (printId !== null) command('printClose', { tab, data: printId });
      }
    });
    printQueue = run;
    // Reiner Druckmodus: beenden, wenn die Warteschlange leer ist (nicht nach dem ersten Auftrag)
    run.then(() => {
      if (printQueue === run) endPrintOnly();
    });
  }

  function endPrintOnly() {
    if (!printOnly) return;
    for (const w of [...wins])
      if (alive(w)) {
        w.allowClose = true;
        w.base.close();
      }
  }

  /** Fenstertitel nach dem aktiven Tab; Menü nach dem aktiven Tab des vorderen Fensters. */
  function updateTitle(w = focusedWin()) {
    if (alive(w)) {
      const { hasDocument, name, dirty } = (w.active && w.active.state) || emptyState();
      w.base.setTitle(hasDocument && name ? `${name}${dirty ? ' (Bearbeitet)' : ''} – ${APP_NAME}` : APP_NAME);
      if (process.platform === 'darwin') w.base.setDocumentEdited(hasDocument && dirty);
    }
    if (w !== focusedWin() || !menu) return;
    const s = (w && w.active && w.active.state) || emptyState();
    for (const id of DOCUMENT_ITEMS) menu.getMenuItemById(id).enabled = s.hasDocument;
    for (const tool of PDF_TOOLS) menu.getMenuItemById('tool:' + tool).enabled = !!s.pdfOpen;
    for (const tool of SITE_TOOLS) menu.getMenuItemById('site:' + tool).enabled = !!s.siteOpen;
    for (const tool of STUDIO_TOOLS) menu.getMenuItemById('studio:' + tool).enabled = !!s.studioOpen;
    const ws = menu.getMenuItemById(s.workspace === 'docs' ? 'ws:docs' : 'ws:pdf');
    if (ws) ws.checked = true;
    const strip = menu.getMenuItemById('stripActive');
    if (strip) strip.checked = !!s.stripActive;
  }

  function versions() {
    let deps = {};
    try {
      deps = JSON.parse(readFileSync(path.join(app.getAppPath(), 'package.json'), 'utf8')).dependencies || {};
    } catch {}
    return deps;
  }

  function showLicenses() {
    if (existsSync(LICENSE_FILE)) shell.openPath(LICENSE_FILE);
    else
      showMessage(baseOf(null), {
        type: 'info',
        title: APP_NAME,
        message: 'Die Lizenzhinweise wurden nicht gefunden.',
        detail: 'Erzeugen mit: npm run licenses',
      });
  }

  async function showAbout() {
    const d = versions();
    const { response } = await showMessage(baseOf(null), {
      type: 'none',
      icon: path.join(ROOT, 'assets', 'icon', 'png', 'icon-128.png'),
      title: 'Über PlantPDF',
      message: `PlantPDF ${app.getVersion()}`,
      detail: [
        'PDFs bearbeiten, ordnen und unterschreiben.',
        'Arbeitet offline – nur die Update-Suche verbindet sich mit GitHub (Versionsabfrage, Download).',
        '',
        `Electron ${process.versions.electron} · Chromium ${process.versions.chrome}`,
        '',
        'Verwendete Bibliotheken:',
        `  pdf-lib ${d['pdf-lib'] || ''} (MIT), @pdf-lib/fontkit ${d['@pdf-lib/fontkit'] || ''} (MIT)`,
        `  PDF.js ${d['pdfjs-dist'] || ''} (Apache-2.0), pako (MIT), Electron (MIT)`,
        'Schriften:',
        '  Barlow, Barlow Semi Condensed, IBM Plex Mono (SIL Open Font License 1.1)',
      ].join('\n'),
      buttons: ['OK', 'Lizenzhinweise …'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (response === 1) showLicenses();
  }

  /** Rückfrage bei ungespeicherten Änderungen eines Tabs; true = darf schließen. */
  async function confirmClose(tab) {
    // Ansicht abgestürzt: Der Dokumentzustand ist verloren, Speichern ist nicht mehr möglich.
    if (!usable(tab)) return true;
    let dirty = tab.state.dirty;
    let name = tab.state.name;
    try {
      const reply = await command('queryDirty', { tab, wait: true, timeout: 5000 });
      dirty = !!(reply && (reply === true || reply.dirty));
      if (reply && typeof reply.name === 'string' && reply.name) name = reply.name;
    } catch {}
    if (!dirty) return true;
    activateTab(tab);
    const { response } = await showMessage(baseOf(tab), {
      type: 'warning',
      title: APP_NAME,
      message: `Möchten Sie die Änderungen an „${name || 'Dokument'}“ speichern?`,
      detail: 'Ihre Änderungen gehen verloren, wenn Sie sie nicht speichern.',
      buttons: ['Speichern', 'Nicht speichern', 'Abbrechen'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 2) return false;
    if (response === 1) {
      // bewusst verworfen: beim nächsten Start nichts zur Wiederherstellung anbieten
      await command('discardRecovery', { tab, wait: true, timeout: 3000 }).catch(() => {});
      return true;
    }
    try {
      return (await command('saveDocument', { tab, wait: true })) === true;
    } catch {
      return false;
    }
  }

  /** Alle Tabs eines Fensters nacheinander fragen; false = abgebrochen. */
  async function confirmWindow(w) {
    for (const t of [...w.tabs]) if (!(await confirmClose(t))) return false;
    return true;
  }

  /* ---------- Updates (GitHub-Releases) ---------- */

  /** Nur im installierten Windows-Programm (nicht beim Entwickeln, nicht im Schnelldruck). */
  const updatesEnabled = () => app.isPackaged && process.platform === 'win32' && !process.env.PDF_EDITOR_NO_UPDATES;
  let update = null; // gefundenes Update
  let updating = false;
  let cancelled = false;
  let quitting = false;
  app.on('before-quit', () => {
    quitting = true;
    abortDownload();
  });

  /** Beim Start (höchstens einmal je 20 Stunden): still nachsehen, nur bei Fund ein Hinweis. */
  async function autoCheck() {
    if (!updatesEnabled() || printOnly || !autoCheckDue()) return;
    try {
      update = await checkForUpdate();
      rememberCheck();
    } catch {
      return; // offline: kein Hinweis, beim nächsten Start erneut
    }
    if (update) command('updateAvailable', { data: { version: update.version, current: app.getVersion() } });
  }

  /** „Hilfe › Nach Updates suchen …“ */
  async function manualCheck() {
    const parent = baseOf(null);
    if (!updatesEnabled())
      return showMessage(parent, { type: 'info', title: APP_NAME, message: 'Updates gibt es nur im installierten Programm unter Windows.', buttons: ['OK'] });
    try {
      update = await checkForUpdate();
    } catch {
      return showMessage(parent, { type: 'warning', title: APP_NAME, message: 'Keine Verbindung zu GitHub.', detail: 'Bitte die Internetverbindung prüfen und später erneut versuchen.', buttons: ['OK'] });
    }
    if (!update) return showMessage(parent, { type: 'info', title: APP_NAME, message: `PlantPDF ${app.getVersion()} ist aktuell.`, buttons: ['OK'] });
    const { response } = await showMessage(parent, {
      type: 'info',
      title: APP_NAME,
      message: `PlantPDF ${update.version} ist verfügbar.`,
      detail: `Installiert ist ${app.getVersion()}. PlantPDF lädt das Update, prüft es und startet danach neu.`,
      buttons: ['Jetzt aktualisieren', 'Später'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response === 0) await installUpdate();
  }

  /** Laden, prüfen, PlantPDF schließen (mit Rückfrage je geänderten Tab), Installer starten. */
  async function installUpdate() {
    const reset = () => command('updateProgress', { data: { p: -1 } });
    if (updating) return false;
    if (!update || !focusedWin()) return reset(), false;
    // ohne Prüfsumme nichts automatisch installieren: Release-Seite im Browser öffnen
    if (!update.sha256) {
      shell.openExternal(update.page);
      return reset(), false;
    }
    updating = true;
    cancelled = false;
    const info = update;
    let last = -1;
    const progress = (p) => {
      for (const w of wins) if (alive(w)) w.base.setProgressBar(p);
      // höchstens ~200 Meldungen je Download an die Ladeanzeige
      if (p < 1 && p - last < 0.005) return;
      last = p;
      command('updateProgress', { data: { p, total: info.size, version: info.version } });
    };
    try {
      command('updateProgress', { data: { p: 0, total: info.size, version: info.version } });
      const file = await downloadUpdate(info, progress);
      progress(1);
      // Programm inzwischen beendet: nichts mehr installieren
      if (quitting || !focusedWin()) return reset(), false;
      for (const w of [...wins])
        if (!(await confirmWindow(w))) {
          reset();
          return false;
        }
      // Häkchen zeigen, dann installieren (der Installer schließt PlantPDF und startet es neu)
      command('updateProgress', { data: { phase: 'install', version: info.version } });
      await new Promise((r) => setTimeout(r, 900));
      await runInstaller(file);
      for (const w of wins) w.allowClose = true;
      app.quit();
      return true;
    } catch (err) {
      reset();
      // „Abbrechen“ in der Ladeanzeige: keine Fehlermeldung
      if (cancelled || quitting || !focusedWin()) return false;
      console.error('Update', err);
      showMessage(baseOf(null), {
        type: 'warning',
        title: APP_NAME,
        message: 'Das Update konnte nicht geladen werden.',
        detail:
          (/Prüfsumme|größer/.test(String(err && err.message))
            ? 'Die geladene Datei stimmt nicht mit dem Release überein und wurde verworfen.'
            : err && (err.installer || err.code === 'EACCES' || err.code === 'ENOENT' || err.code === 'EPERM' || err.code === 'EBUSY')
              ? 'Das Setup konnte nicht gespeichert oder gestartet werden (evtl. vom Virenschutz blockiert). Ordner: %TEMP%\\PlantPDF-Update.'
              : /^Download fehlgeschlagen/.test(String(err && err.message))
                ? 'GitHub hat die Datei nicht geliefert. Bitte später erneut versuchen.'
                : 'Bitte die Internetverbindung prüfen und später erneut versuchen.') +
          // genauer Grund (hilft bei der Fehlersuche)
          `\n\nGrund: ${String((err && (err.code || err.message)) || err).slice(0, 160)}`,
        buttons: ['OK', 'Release-Seite öffnen'],
      }).then(({ response }) => response === 1 && update && shell.openExternal(update.page));
      return false;
    } finally {
      updating = false;
      for (const w of wins) if (alive(w)) w.base.setProgressBar(-1);
    }
  }

  /** Ereignisse einer Programmansicht (Tab). */
  function hookTab(tab) {
    const wc = tab.view.webContents;
    // Die beforeunload-Sperre der Web-App nie wirken lassen – die Rückfrage stellt
    // confirmClose() nativ und auf Deutsch.
    wc.on('will-prevent-unload', (e) => e.preventDefault());
    wc.on('render-process-gone', (_e, details) => {
      if (tab.closed || details.reason === 'clean-exit') return;
      onRendererGone(tab);
    });
    wc.on('unresponsive', async () => {
      if (!usable(tab)) return;
      if (printOnly) return endPrintOnly();
      const { response } = await showMessage(baseOf(tab), {
        type: 'warning',
        title: APP_NAME,
        message: 'PlantPDF reagiert nicht.',
        detail: 'Sie können warten, bis er wieder reagiert, oder den Tab schließen. Ungespeicherte Änderungen gehen beim Schließen verloren.',
        buttons: ['Warten', 'Tab schließen'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response === 1 && !tab.closed) removeTab(tab);
    });

    if (process.platform !== 'darwin') {
      // Unter Windows fokussiert das Loslassen von Alt die Menüleiste (in der eigenen Titelleiste,
      // src/platform/title-bar.js). Im Editor ist Alt aber ein Maus-Modifikator (Alt+Klick = Element
      // dahinter, Alt-Ziehen = ohne Einrasten). Wurde die Maus bei gedrückter Alt-Taste benutzt,
      // wird das Loslassen deshalb zurückgehalten. Alt allein (Tastaturbedienung des Menüs) geht weiter.
      wc.on('before-input-event', (event, input) => {
        if (input.key !== 'Alt') return;
        if (input.type === 'keyDown') {
          if (!input.isAutoRepeat) altUsedWithMouse = false;
          altDown = true;
        } else if (input.type === 'keyUp') {
          altDown = false;
          if (altUsedWithMouse) event.preventDefault();
          altUsedWithMouse = false;
        }
      });
      wc.on('input-event', (_event, input) => {
        if (altDown && /^(mouseDown|mouseWheel|gesture)/.test(input.type)) altUsedWithMouse = true;
      });
    }
    // Fenster- und Tab-Kürzel (wie im Browser): Strg+W Tab schließen, Strg+T Startseite,
    // Strg+Tab / Strg+Umschalt+Tab Tab wechseln, F11 Vollbild, Strg+M minimieren
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isAutoRepeat || input.alt || input.meta) return;
      const key = input.key.toLowerCase();
      const w = tab.win;
      const step = (d) => {
        const i = w.tabs.indexOf(w.active);
        activateTab(w.tabs[(i + d + w.tabs.length) % w.tabs.length]);
      };
      const action =
        key === 'tab' && input.control
          ? () => step(input.shift ? -1 : 1)
          : input.shift
            ? null
            : key === 'f11' && !input.control
              ? () => w.base.setFullScreen(!w.base.isFullScreen())
              : input.control && key === 'w'
                ? () => (tab.state.hasDocument || w.tabs.length > 1 ? closeTab(tab) : w.base.close())
                : input.control && key === 't'
                  ? () => homeTab(w)
                  : input.control && key === 'm'
                    ? () => w.base.minimize()
                    : null;
      if (!action || (process.platform === 'darwin' && key !== 'tab')) return;
      event.preventDefault();
      action();
    });
  }

  /** Titelleiste und Fensterhintergrund in den Farben der aktuellen Darstellung. */
  function applyFrameColors() {
    const colors = frameColors();
    for (const w of wins) {
      if (!alive(w)) continue;
      w.base.setBackgroundColor(colors.background);
      if (CUSTOM_FRAME) w.base.setTitleBarOverlay(colors.overlay);
      for (const t of w.tabs) if (!t.closed) t.view.setBackgroundColor(colors.background);
    }
  }

  /** Ansicht eines Tabs abgestürzt: offene Anfragen beenden, Hinweis mit „Neu laden“. */
  async function onRendererGone(tab) {
    tab.gone = true;
    tab.ready = false;
    for (const [replyId, done] of replies)
      if (done.tab === tab) {
        replies.delete(replyId);
        clearTimeout(done.timer);
        done({ error: 'renderer-gone' });
      }
    // unsichtbares Druckprogramm: keine Rückfrage an ein verstecktes Fenster, einfach beenden
    if (printOnly) return endPrintOnly();
    const name = tab.state.hasDocument ? tab.state.name : '';
    tab.state = emptyState();
    updateTitle(tab.win);
    broadcastTabs(tab.win);
    if (tab.closed || !alive(tab.win)) return;
    activateTab(tab);
    const { response } = await showMessage(baseOf(tab), {
      type: 'error',
      title: APP_NAME,
      message: 'PlantPDF ist unerwartet abgestürzt.',
      detail:
        (name ? `Ungespeicherte Änderungen an „${name}“ bietet PlantPDF beim nächsten Öffnen zur Wiederherstellung an, soweit sie automatisch gesichert wurden. ` : '') +
        'Die zuletzt gespeicherte Fassung der Datei ist unverändert.',
      buttons: ['Neu laden', 'Tab schließen'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (tab.closed || !alive(tab.win)) return;
    if (response === 1) return removeTab(tab);
    tab.gone = false;
    tab.primary = true; // nach dem Neuladen Wiederherstellung anbieten
    tab.view.webContents.loadURL(START_URL);
  }

  /** IPC nur vom Hauptframe einer eigenen Programmansicht (keine iframes, keine Vorschau): der Tab. */
  const senderTab = (event) => {
    const tab = tabOf(event.sender);
    return tab && event.senderFrame === event.sender.mainFrame && event.senderFrame.url.startsWith(ORIGIN + '/') ? tab : null;
  };
  /**
   * Antwort immer als { value } oder { error }: Fehlermeldungen sind deutsche Texte ohne Pfad
   * (FileAccessError); alles andere wird nicht an den Renderer weitergegeben. `fn(tab, …args)`.
   */
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      const tab = senderTab(event);
      if (!tab) return { error: 'Nicht erlaubt.' };
      try {
        return { value: await fn(tab, ...args) };
      } catch (err) {
        if (!(err instanceof FileAccessError)) console.error(channel, err);
        return { error: err instanceof FileAccessError ? err.message : 'Interner Fehler.' };
      }
    });

  const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  function registerIpc() {
    handle('file:open-dialog', async (tab) => {
      const r = await dialog.showOpenDialog(baseOf(tab), {
        title: 'PDF-Datei öffnen',
        buttonLabel: 'Öffnen',
        properties: ['openFile'],
        filters: [
          { name: 'PDF-Dokumente', extensions: ['pdf'] },
          { name: 'Alle Dateien', extensions: ['*'] },
        ],
      });
      if (r.canceled || !r.filePaths[0]) return null;
      app.addRecentDocument(r.filePaths[0]);
      return files.grant(r.filePaths[0]);
    });
    handle('file:save-dialog', async (tab, suggestedName) => {
      const name = path
        .basename(String(suggestedName || 'Dokument.pdf'))
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const r = await dialog.showSaveDialog(baseOf(tab), {
        title: 'Speichern unter',
        buttonLabel: 'Speichern',
        defaultPath: path.join(lastDirectory(), name || 'Dokument.pdf'),
        filters: [{ name: 'PDF-Dokument', extensions: ['pdf'] }],
        properties: ['showOverwriteConfirmation', 'createDirectory'],
      });
      if (r.canceled || !r.filePath) return null;
      const target = /\.pdf$/i.test(r.filePath) ? r.filePath : r.filePath + '.pdf';
      return files.grant(target);
    });
    handle('file:read', (_tab, id) => files.read(id));
    // Hinweis „Update verfügbar“ > „Jetzt aktualisieren“
    handle('update:install', () => installUpdate());
    handle('update:cancel', () => {
      if (!updating) return false;
      cancelled = true;
      abortDownload();
      return true;
    });
    // „Dokumentation erstellen“: Druckfassung → PDF (höchstens 200 MB Text, z. B. mit Fotos)
    handle('studio:pdf', async (_tab, html) => {
      if (typeof html !== 'string' || !html.startsWith('<!doctype html>') || html.length > 200 * 1024 * 1024) throw new Error('Ungültige Druckfassung');
      return htmlToPdf(ORIGIN, html);
    });
    handle('file:write', async (_tab, id, data) => {
      await files.write(id, data);
      app.addRecentDocument(files.pathOf(id));
      return true;
    });
    handle('file:grant-dropped', async (_tab, filePath) => {
      const entry = await files.grantDropped(filePath);
      if (entry) app.addRecentDocument(filePath);
      return entry;
    });

    /* Tabs */
    // Dokument in einem neuen Tab (oder dem, in dem es schon offen ist)
    handle('tab:open', (tab, open) => {
      if (!open || typeof open !== 'object') return false;
      const name = String(open.name || '').slice(0, 255);
      if (open.kind === 'file' && typeof open.fileId === 'string' && files.grants.has(open.fileId))
        return openInTab(tab.win, { kind: 'file', entry: { id: open.fileId, name: name || path.basename(files.pathOf(open.fileId)) } }), true;
      if (open.kind === 'bytes' && open.bytes instanceof Uint8Array && open.bytes.length <= 1024 * 1024 * 1024)
        return openInTab(tab.win, { kind: 'bytes', bytes: open.bytes, name: name || 'Dokument.pdf' }), true;
      if (open.kind === 'draft' && typeof open.id === 'string' && ID_RE.test(open.id)) return openInTab(tab.win, { kind: 'draft', id: open.id, name: name || 'Dokumentation' }), true;
      if (open.kind === 'recover' && typeof open.id === 'string' && ID_RE.test(open.id)) return focusTab(createTab(tab.win, { open: { kind: 'recover', id: open.id, name: name || 'Dokument' } })), true;
      return false;
    });
    const tabById = (id) => allTabs().find((t) => t.id === id && !t.closed) || null;
    handle('tab:activate', (_tab, id) => {
      const t = tabById(id);
      if (t) activateTab(t);
    });
    handle('tab:close', (_tab, id) => {
      const t = tabById(id);
      return t ? closeTab(t) : false;
    });
    // Das Dokument im eigenen Tab wurde geschlossen (Rückfrage war schon): Tab weg, außer er ist der letzte
    handle('tab:closed-self', (tab) => {
      tab.state = emptyState();
      if (tab.win.tabs.length > 1) removeTab(tab);
      else broadcastTabs(tab.win);
    });
    handle('tab:home', (tab, ws) => homeTab(tab.win, ws === 'pdf' || ws === 'docs' ? ws : null));
    handle('tab:reorder', (tab, id, index) => {
      const t = tabById(id);
      if (!t || t.win !== tab.win || !Number.isInteger(index)) return;
      const w = tab.win;
      const docs = w.tabs.filter((x) => x.state.hasDocument);
      const before = docs.filter((x) => x !== t)[index] || null;
      w.tabs.splice(w.tabs.indexOf(t), 1);
      w.tabs.splice(before ? w.tabs.indexOf(before) : w.tabs.length, 0, t);
      broadcastTabs(w);
    });
    // Lage des Zeigers vom System (DIP, auch bei Monitoren mit unterschiedlicher Skalierung)
    handle('tab:drop', (tab, id) => {
      const t = tabById(id);
      const p = screen.getCursorScreenPoint();
      if (t) dropTab(t, p.x, p.y);
    });
    // Nur für die Tests: Ablegen an einer festen Stelle
    if (!app.isPackaged)
      handle('tab:drop-at', (tab, id, x, y) => {
        const t = tabById(id);
        if (t && Number.isFinite(x) && Number.isFinite(y)) dropTab(t, x, y);
      });

    ipcMain.on('app:state', (event, state) => {
      const tab = senderTab(event);
      if (!tab || !state) return;
      tab.state = {
        hasDocument: !!state.hasDocument,
        name: String(state.name || ''),
        dirty: !!state.dirty,
        pdfOpen: !!state.pdfOpen,
        siteOpen: !!state.siteOpen,
        studioOpen: !!state.studioOpen,
        stripActive: !!state.stripActive,
        fileId: typeof state.fileId === 'string' ? state.fileId : '',
        projectId: typeof state.projectId === 'string' ? state.projectId : '',
        workspace: state.workspace === 'docs' ? 'docs' : 'pdf',
      };
      updateTitle(tab.win);
      broadcastTabs(tab.win);
      // Darstellung der App auch für Titelleiste, Menü, Systemdialoge und die anderen Tabs
      if (['light', 'dark', 'system'].includes(state.theme) && nativeTheme.themeSource !== state.theme) {
        nativeTheme.themeSource = state.theme;
        rememberTheme(state.theme);
        applyFrameColors();
        for (const t of allTabs()) if (t !== tab && t.ready) command('themeChanged', { tab: t });
      }
    });
    // Menü der eigenen Titelleiste: Untermenü `index` (−1 = ganzes Menü) an der Stelle (x, y) öffnen;
    // die Antwort kommt, wenn es wieder geschlossen ist.
    handle(
      'menu:popup',
      (tab, index, x, y) =>
        new Promise((resolve) => {
          const item = Number.isInteger(index) && index >= 0 && menu ? menu.items[index] : null;
          const target = index === -1 ? menu : item && item.visible !== false ? item.submenu : null;
          const at = (v) => (Number.isFinite(v) ? Math.max(0, Math.min(20000, Math.round(v))) : 0);
          if (!target || !alive(tab.win)) return resolve(false);
          target.popup({ window: tab.win.base, x: at(x), y: at(y), callback: () => resolve(true) });
        }),
    );
    ipcMain.on('app:ready', (event) => {
      const tab = senderTab(event);
      if (!tab) return;
      tab.ready = true;
      tab.gone = false;
      broadcastTabs(tab.win);
      if (tab.workspace) {
        command('setWorkspace', { tab, data: tab.workspace });
        tab.workspace = null;
      }
      if (tab.open) {
        const open = tab.open;
        tab.open = null;
        deliver(tab, open);
      }
      // nach einem unerwarteten Ende: gesicherte Kopien anbieten (nur einmal, im ersten Tab)
      if (tab.primary) {
        tab.primary = false;
        command('offerRecovery', { tab });
      }
      if (firstReady) return;
      firstReady = true;
      // mehrere Dateien vor dem Start (z. B. schnell nacheinander per Doppelklick): die letzte
      const last = pendingPaths.pop();
      pendingPaths.length = 0;
      if (last) openPath(last);
      while (pendingPrints.length) quickPrint(pendingPrints.shift());
    });
    ipcMain.on('app:command-reply', (event, msg) => {
      if (!senderTab(event) || !msg) return;
      const done = replies.get(msg.replyId);
      if (done) (replies.delete(msg.replyId), done(msg));
    });
  }

  function lastDirectory() {
    const last = [...files.grants.values()].pop();
    return last ? path.dirname(last) : app.getPath('documents');
  }

  function hardenSession() {
    const ses = session.defaultSession;
    let html = null;
    let script = null;
    let csp = null;
    protocol.handle(SCHEME, (request) => {
      const url = new URL(request.url);
      if (url.host !== 'pdf-editor') return new Response('Nicht gefunden', { status: 404 });
      const printPage = printResponse(url);
      if (printPage) return printPage;
      if (!html) ({ html, script, csp } = splitEditor(readFileSync(EDITOR_HTML, 'utf8')));
      if (url.pathname === '/app.js')
        return new Response(script, {
          headers: {
            'content-type': 'text/javascript; charset=utf-8',
            'x-content-type-options': 'nosniff',
          },
        });
      if (!['/', '/index.html'].includes(url.pathname)) return new Response('Nicht gefunden', { status: 404 });
      return new Response(html, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': csp,
          'x-content-type-options': 'nosniff',
        },
      });
    });
    // Keine Netzwerkzugriffe, keine lokalen Dateien per URL
    ses.webRequest.onBeforeRequest(
      { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'ftp://*/*', 'file://*/*'] },
      (_details, callback) => callback({ cancel: true }),
    );
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);
    ses.setDevicePermissionHandler(() => false);
    ses.setSpellCheckerEnabled(false);
    // Downloads (Fallback der Web-App) mit deutschem Speichern-Dialog
    ses.on('will-download', (_event, item) => {
      item.setSaveDialogOptions({
        title: 'Speichern unter',
        buttonLabel: 'Speichern',
        defaultPath: path.join(lastDirectory(), item.getFilename()),
      });
    });
  }

  const isPreviewUrl = (url) => typeof url === 'string' && url.startsWith(`blob:${ORIGIN}/`);
  const previewTitle = (tab) => (tab && tab.state.name ? `${tab.state.name} – Vorschau – ${APP_NAME}` : APP_NAME);

  /**
   * Vorschaufenster: ohne Menü, fester Titel; es darf nur ein PDF anzeigen. Ein blob: mit
   * anderem Inhalt (z. B. HTML) wird sofort geschlossen.
   */
  function setUpPreview(child, opener) {
    const title = previewTitle(opener);
    child.removeMenu();
    child.setTitle(title);
    child.on('page-title-updated', (e) => e.preventDefault());
    const wc = child.webContents;
    wc.once('did-finish-load', async () => {
      const type = await wc.executeJavaScript('document.contentType', true).catch(() => '');
      if (type !== 'application/pdf' && !child.isDestroyed()) child.destroy();
    });
  }

  app.on('web-contents-created', (_event, contents) => {
    contents.on('will-navigate', (e, url) => {
      // Einzige Ausnahme: Das Vorschaufenster (siehe unten) lädt das PDF als blob:-URL
      if (!(isPreviewUrl(url) && !tabOf(contents))) e.preventDefault();
    });
    contents.on('did-create-window', (child) => setUpPreview(child, tabOf(contents)));
    contents.on('will-redirect', (e) => e.preventDefault());
    contents.on('will-attach-webview', (e) => e.preventDefault());
    // „Anzeigen und drucken“: die Web-App öffnet das PDF als blob:-URL – im eingebauten
    // PDF-Betrachter von Chromium (mit Drucken). Alles andere wird abgelehnt.
    contents.setWindowOpenHandler(({ url }) => {
      const tab = tabOf(contents);
      if (isPreviewUrl(url) && tab)
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            title: previewTitle(tab),
            icon: ICON,
            autoHideMenuBar: true,
            width: 1000,
            height: 800,
            webPreferences: {
              preload: undefined,
              contextIsolation: true,
              nodeIntegration: false,
              sandbox: true,
              plugins: true,
              devTools: false,
            },
          },
        };
      return { action: 'deny' };
    });
  });

  app.on('second-instance', (_event, argv, workingDirectory) => {
    const printJob = printRequestFromArgv(argv, workingDirectory);
    if (printJob) {
      // sofort lesen: Outlook löscht die temporäre Kopie, sobald dieser Prozess endet
      const job = withBytes(printJob);
      if (firstReady) quickPrint(job);
      else pendingPrints.push(job);
      return;
    }
    const last = pdfPathsFromArgv(argv, workingDirectory).pop();
    if (last) return openPath(last);
    const w = focusedWin();
    if (!w) return;
    if (printOnly) {
      printOnly = false;
      w.base.show();
    }
    if (w.base.isMinimized()) w.base.restore();
    w.base.focus();
  });
  app.on('open-file', (event, filePath) => {
    // macOS: Datei auf das Programmsymbol gezogen bzw. per Finder geöffnet
    event.preventDefault();
    if (files && firstReady) openPath(filePath);
    else pendingPaths.push(filePath);
  });
  app.on('window-all-closed', () => app.quit());

  app.whenReady().then(() => {
    files = new FileAccess();
    hardenSession();
    registerIpc();
    menu = buildMenu({
      command: (name) => command(name, { fromMenu: true }),
      about: showAbout,
      updates: () => manualCheck(),
      licenses: showLicenses,
      fonts: () => shell.openPath(FONT_DIR),
      devTools: !app.isPackaged,
    });
    Menu.setApplicationMenu(menu);
    nativeTheme.on('updated', applyFrameColors);
    const w = createWin();
    createTab(w, { primary: true });
    updateTitle(w);
    setTimeout(autoCheck, 8000);
  });
}

/** Höchstzahl der Seiten für den Schnelldruck (größere Dateien: in PlantPDF öffnen und drucken). */
const MAX_PRINT_PAGES = 500;

/** Druckauftrag mit sofort begonnenem Lesen der Datei (`bytes`: Promise<Uint8Array>). */
function withBytes(job) {
  const bytes = (async () => {
    const stat = await fs.stat(job.path);
    if (stat.size > 512 * 1024 * 1024) throw new Error('Die Datei ist zu groß zum Schnelldruck.');
    const data = await fs.readFile(job.path);
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  })();
  bytes.catch(() => {}); // Fehler meldet quickPrint
  return { ...job, bytes };
}

/** Verständlicher Grund für einen fehlgeschlagenen Schnelldruck. */
function printErrorText(err, printer) {
  const reason = String((err && err.message) || err || '');
  if (/ENOENT/.test(reason)) return 'Die Datei wurde nicht gefunden.';
  if (/invalid printer|invalid devicename|printer.*not|no printer/i.test(reason))
    return printer
      ? `Der Drucker „${printer}“ wurde nicht gefunden.`
      : 'Es ist kein Standarddrucker eingerichtet.';
  if (/cancel/i.test(reason)) return 'Der Druckauftrag wurde abgebrochen.';
  if (/password|encrypt/i.test(reason))
    return 'Die Datei ist kennwortgeschützt. Bitte in PlantPDF öffnen und von dort drucken.';
  if (/^Die Datei/.test(reason)) return reason;
  return 'Bitte die Datei in PlantPDF öffnen und über „Drucken“ ausgeben.';
}

/**
 * Trennt das eingebettete Bundle aus dist/PDF-Editor.html heraus: Die Seite lädt es als
 * app://pdf-editor/app.js (nur so greift der V8-Code-Cache). Die Content-Security-Policy erlaubt
 * genau diese eine Skriptdatei – per Hash geprüft (Subresource Integrity) –, den pdf.js-Worker als
 * blob: und WebAssembly (pdf.js-Bilddecoder), sonst nichts Fremdes.
 */
function splitEditor(source) {
  const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  if (scripts.length !== 1) throw new Error('dist/PDF-Editor.html: genau ein Skript erwartet');
  const script = scripts[0][1];
  const hash = `sha384-${createHash('sha384').update(script, 'utf8').digest('base64')}`;
  const html =
    source.slice(0, scripts[0].index) +
    `<script src="/app.js" integrity="${hash}"></script>` +
    source.slice(scripts[0].index + scripts[0][0].length);
  return { html, script, csp: contentSecurityPolicy(hash) };
}

function contentSecurityPolicy(hash) {
  return [
    "default-src 'none'",
    `script-src '${hash}' 'wasm-unsafe-eval'`,
    'worker-src blob:',
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data: blob:',
    'connect-src data: blob:',
    'object-src blob:',
    'frame-src blob:',
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

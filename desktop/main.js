/**
 * PDF-Editor als Desktop-App (Electron-Hauptprozess).
 *
 * Lädt den gebauten Single-File-Editor (dist/PDF-Editor.html) über das eigene Schema
 * app://pdf-editor/ – ohne Netzwerk, ohne Node-Zugriff im Renderer. Dateien werden über eine
 * eng begrenzte IPC-API gelesen und geschrieben (desktop/file-access.js, desktop/preload.cjs).
 *
 * Sicherheit (Electron Security Checklist): contextIsolation, sandbox, kein nodeIntegration,
 * strikte CSP (Skript nur per Hash), keine Remote-Inhalte (http/https/ws/file werden
 * blockiert), Navigation und neue Fenster gesperrt (Ausnahme: die eigene PDF-Vorschau als
 * blob:-URL), alle Berechtigungsanfragen abgelehnt, IPC-Absender werden geprüft, kein
 * Auto-Update, keine Telemetrie.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, protocol, session, shell } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FileAccess, FileAccessError, pdfPathsFromArgv } from './file-access.js';
import { buildMenu, DOCUMENT_ITEMS } from './menu.js';
import { loadWindowState, trackWindowState, MIN_SIZE } from './window-state.js';

const APP_NAME = 'PDF-Editor';
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
  console.error('PDF-Editor: Debug-Schalter sind im ausgelieferten Programm nicht erlaubt.');
  app.exit(1);
}

// Tests/Entwicklung: eigener Datenordner (Einstellungen, IndexedDB, Freigaben)
if (process.env.PDF_EDITOR_USER_DATA) app.setPath('userData', path.resolve(process.env.PDF_EDITOR_USER_DATA));

app.setName(APP_NAME);
if (process.platform === 'win32') app.setAppUserModelId('de.jsteiner.pdfeditor');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  start();
}

function start() {
  /** @type {BrowserWindow | null} */
  let win = null;
  /** @type {FileAccess} */
  let files = null;
  let rendererReady = false;
  const pendingPaths = pdfPathsFromArgv(process.argv);
  let docState = { hasDocument: false, name: '', dirty: false };
  let allowClose = false;
  let closing = false;
  let rendererGone = false;
  // Alt-Taste (Windows/Linux): Menüleiste nicht fokussieren, wenn Alt mit der Maus benutzt wurde
  let altDown = false;
  let altUsedWithMouse = false;
  let menu = null;
  const replies = new Map();

  /**
   * Befehl an die Web-App; mit `wait` wird auf die Antwort gewartet (optional mit Zeitlimit).
   * Menübefehle (`fromMenu`) ignoriert die Web-App, solange einer ihrer Dialoge offen ist.
   */
  function command(name, { wait = false, timeout = 0, fromMenu = false } = {}) {
    if (!win || win.isDestroyed() || rendererGone) {
      return wait ? Promise.reject(new Error('renderer-gone')) : Promise.resolve(null);
    }
    if (!wait) {
      win.webContents.send('app:command', { command: name, fromMenu });
      return Promise.resolve(null);
    }
    const replyId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = timeout
        ? setTimeout(() => (replies.delete(replyId), reject(new Error('timeout'))), timeout)
        : 0;
      replies.set(replyId, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(msg.error));
        else resolve(msg.result);
      });
      replies.get(replyId).timer = timer;
      win.webContents.send('app:command', { command: name, replyId });
    });
  }

  function openPath(filePath) {
    const entry = files.grant(filePath);
    app.addRecentDocument(filePath);
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    if (rendererReady) win.webContents.send('app:open-file', entry);
    else pendingPaths.push(filePath);
  }

  function updateTitle() {
    if (!win) return;
    const { hasDocument, name, dirty } = docState;
    win.setTitle(hasDocument && name ? `${name}${dirty ? ' (Bearbeitet)' : ''} – ${APP_NAME}` : APP_NAME);
    if (process.platform === 'darwin') win.setDocumentEdited(hasDocument && dirty);
    if (menu) for (const id of DOCUMENT_ITEMS) menu.getMenuItemById(id).enabled = hasDocument;
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
      dialog.showMessageBox(win, {
        type: 'info',
        title: APP_NAME,
        message: 'Die Lizenzhinweise wurden nicht gefunden.',
        detail: 'Erzeugen mit: npm run licenses',
      });
  }

  async function showAbout() {
    const d = versions();
    const { response } = await dialog.showMessageBox(win, {
      type: 'none',
      icon: path.join(ROOT, 'assets', 'icon', 'png', 'icon-128.png'),
      title: 'Über PDF-Editor',
      message: `PDF-Editor ${app.getVersion()}`,
      detail: [
        'Texte und Bilder in PDF-Dateien bearbeiten, Seiten einfügen und ordnen.',
        'Läuft vollständig offline – es werden keine Daten übertragen.',
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

  /** Rückfrage bei ungespeicherten Änderungen; true = Fenster darf schließen. */
  async function confirmClose() {
    // Renderer abgestürzt: Der Dokumentzustand ist verloren, Speichern ist nicht mehr möglich.
    if (rendererGone) return true;
    let dirty = docState.dirty;
    try {
      dirty = !!(await command('queryDirty', { wait: true, timeout: 5000 }));
    } catch {}
    if (!dirty) return true;
    const { response } = await dialog.showMessageBox(win, {
      type: 'warning',
      title: APP_NAME,
      message: `Möchten Sie die Änderungen an „${docState.name || 'Dokument'}“ speichern?`,
      detail: 'Ihre Änderungen gehen verloren, wenn Sie sie nicht speichern.',
      buttons: ['Speichern', 'Nicht speichern', 'Abbrechen'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (response === 2) return false;
    if (response === 1) return true;
    try {
      return (await command('save', { wait: true })) === true;
    } catch {
      return false;
    }
  }

  function createWindow() {
    const state = loadWindowState();
    win = new BrowserWindow({
      ...state,
      minWidth: MIN_SIZE.width,
      minHeight: MIN_SIZE.height,
      title: APP_NAME,
      icon: ICON,
      show: false,
      backgroundColor: '#f5f5f7',
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
    if (state.maximized) win.maximize();
    trackWindowState(win);
    win.once('ready-to-show', () => win.show());
    // Seitentitel nicht übernehmen – den Titel setzt updateTitle()
    win.on('page-title-updated', (e) => e.preventDefault());

    win.on('close', (e) => {
      if (allowClose) return;
      e.preventDefault();
      if (closing) return;
      closing = true;
      confirmClose()
        .then((ok) => {
          // Rückfrage ist erledigt: Fenster ohne die beforeunload-Sperre der Web-App schließen
          if (ok && win && !win.isDestroyed()) {
            allowClose = true;
            win.destroy();
          }
        })
        .finally(() => (closing = false));
    });
    // Die beforeunload-Sperre der Web-App nie wirken lassen – die Rückfrage stellt
    // confirmClose() nativ und auf Deutsch (im 'close'-Ereignis oben).
    win.webContents.on('will-prevent-unload', (e) => e.preventDefault());
    win.on('closed', () => {
      win = null;
      // Vorschaufenster gehören zum Hauptfenster
      for (const other of BrowserWindow.getAllWindows()) other.destroy();
    });

    win.webContents.on('render-process-gone', (_e, details) => {
      if (allowClose || details.reason === 'clean-exit') return;
      onRendererGone();
    });
    win.on('unresponsive', async () => {
      if (!win || rendererGone) return;
      const { response } = await dialog.showMessageBox(win, {
        type: 'warning',
        title: APP_NAME,
        message: 'Der PDF-Editor reagiert nicht.',
        detail:
          'Sie können warten, bis er wieder reagiert, oder das Fenster schließen. Ungespeicherte Änderungen gehen beim Schließen verloren.',
        buttons: ['Warten', 'Fenster schließen'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      if (response === 1 && win && !win.isDestroyed()) {
        allowClose = true;
        win.destroy();
      }
    });

    if (process.platform !== 'darwin') {
      // Unter Windows fokussiert das Loslassen von Alt die Menüleiste. Im Editor ist Alt aber ein
      // Maus-Modifikator (Alt+Klick = Element dahinter, Alt-Ziehen = ohne Einrasten). Wurde die
      // Maus bei gedrückter Alt-Taste benutzt, wird das Loslassen deshalb nicht an das Menü
      // weitergegeben. Alt allein (Tastaturbedienung des Menüs) funktioniert weiter; die Web-App
      // wertet das keyup von Alt nicht aus.
      win.webContents.on('before-input-event', (event, input) => {
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
      win.webContents.on('input-event', (_event, input) => {
        if (altDown && /^(mouseDown|mouseWheel|gesture)/.test(input.type)) altUsedWithMouse = true;
      });
    }

    win.webContents.setVisualZoomLevelLimits(1, 1);
    win.loadURL(START_URL);
  }

  /** Renderer abgestürzt: offene Anfragen beenden, Hinweis mit „Neu laden“. */
  async function onRendererGone() {
    rendererGone = true;
    rendererReady = false;
    for (const [replyId, done] of replies) {
      replies.delete(replyId);
      clearTimeout(done.timer);
      done({ error: 'renderer-gone' });
    }
    const name = docState.hasDocument ? docState.name : '';
    docState = { hasDocument: false, name: '', dirty: false };
    updateTitle();
    if (!win || win.isDestroyed()) return;
    const { response } = await dialog.showMessageBox(win, {
      type: 'error',
      title: APP_NAME,
      message: 'Der PDF-Editor ist unerwartet abgestürzt.',
      detail:
        (name ? `Ungespeicherte Änderungen an „${name}“ sind leider verloren. ` : '') +
        'Die zuletzt gespeicherte Fassung der Datei ist unverändert.',
      buttons: ['Neu laden', 'Fenster schließen'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    });
    if (!win || win.isDestroyed()) return;
    if (response === 1) {
      allowClose = true;
      win.destroy();
      return;
    }
    rendererGone = false;
    win.loadURL(START_URL);
  }

  /** IPC nur vom Hauptframe des eigenen Hauptfensters annehmen (keine iframes, keine Vorschau). */
  const fromMainFrame = (event) =>
    !!win &&
    !win.isDestroyed() &&
    event.sender === win.webContents &&
    event.senderFrame === win.webContents.mainFrame &&
    event.senderFrame.url.startsWith(ORIGIN + '/');
  /**
   * Antwort immer als { value } oder { error }: Fehlermeldungen sind deutsche Texte ohne Pfad
   * (FileAccessError); alles andere wird nicht an den Renderer weitergegeben.
   */
  const handle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!fromMainFrame(event)) return { error: 'Nicht erlaubt.' };
      try {
        return { value: await fn(...args) };
      } catch (err) {
        if (!(err instanceof FileAccessError)) console.error(channel, err);
        return { error: err instanceof FileAccessError ? err.message : 'Interner Fehler.' };
      }
    });

  function registerIpc() {
    handle('file:open-dialog', async () => {
      const r = await dialog.showOpenDialog(win, {
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
    handle('file:save-dialog', async (suggestedName) => {
      const name = path
        .basename(String(suggestedName || 'Dokument.pdf'))
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
      const r = await dialog.showSaveDialog(win, {
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
    handle('file:read', (id) => files.read(id));
    handle('file:write', async (id, data) => {
      await files.write(id, data);
      app.addRecentDocument(files.pathOf(id));
      return true;
    });
    handle('file:grant-dropped', async (filePath) => {
      const entry = await files.grantDropped(filePath);
      if (entry) app.addRecentDocument(filePath);
      return entry;
    });
    ipcMain.on('app:state', (event, state) => {
      if (!fromMainFrame(event) || !state) return;
      docState = { hasDocument: !!state.hasDocument, name: String(state.name || ''), dirty: !!state.dirty };
      updateTitle();
    });
    ipcMain.on('app:ready', (event) => {
      if (!fromMainFrame(event)) return;
      rendererReady = true;
      rendererGone = false;
      // mehrere Dateien vor dem Start (z. B. schnell nacheinander per Doppelklick): die letzte
      const last = pendingPaths.pop();
      pendingPaths.length = 0;
      if (last) openPath(last);
    });
    ipcMain.on('app:command-reply', (event, msg) => {
      if (!fromMainFrame(event) || !msg) return;
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
    let csp = null;
    protocol.handle(SCHEME, (request) => {
      const url = new URL(request.url);
      if (url.host !== 'pdf-editor' || !['/', '/index.html'].includes(url.pathname))
        return new Response('Nicht gefunden', { status: 404 });
      if (!html) {
        html = readFileSync(EDITOR_HTML, 'utf8');
        csp = contentSecurityPolicy(html);
      }
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
  const previewTitle = () => (docState.name ? `${docState.name} – Vorschau – ${APP_NAME}` : APP_NAME);

  /**
   * Vorschaufenster: ohne Menü, fester Titel; es darf nur ein PDF anzeigen. Ein blob: mit
   * anderem Inhalt (z. B. HTML) wird sofort geschlossen.
   */
  function setUpPreview(child) {
    const title = previewTitle();
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
      if (!(isPreviewUrl(url) && (!win || contents !== win.webContents))) e.preventDefault();
    });
    contents.on('did-create-window', (child) => setUpPreview(child));
    contents.on('will-redirect', (e) => e.preventDefault());
    contents.on('will-attach-webview', (e) => e.preventDefault());
    // „Anzeigen und drucken“: die Web-App öffnet das PDF als blob:-URL – im eingebauten
    // PDF-Betrachter von Chromium (mit Drucken). Alles andere wird abgelehnt.
    contents.setWindowOpenHandler(({ url }) => {
      if (isPreviewUrl(url) && win && contents === win.webContents)
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            title: previewTitle(),
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
    const last = pdfPathsFromArgv(argv, workingDirectory).pop();
    if (last) openPath(last);
    else if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.on('open-file', (event, filePath) => {
    // macOS: Datei auf das Programmsymbol gezogen bzw. per Finder geöffnet
    event.preventDefault();
    if (files && win) openPath(filePath);
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
      licenses: showLicenses,
      fonts: () => shell.openPath(FONT_DIR),
      devTools: !app.isPackaged,
    });
    Menu.setApplicationMenu(menu);
    createWindow();
    updateTitle();
  });
}

/**
 * Content-Security-Policy: Skripte nur mit passendem Hash (das eingebettete Bundle),
 * pdf.js-Worker als blob:, WebAssembly (pdf.js-Bilddecoder) erlaubt, sonst nichts Fremdes.
 */
function contentSecurityPolicy(html) {
  const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(
    (m) => `'sha256-${createHash('sha256').update(m[1], 'utf8').digest('base64')}'`,
  );
  return [
    "default-src 'none'",
    `script-src ${hashes.join(' ')} 'wasm-unsafe-eval'`,
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

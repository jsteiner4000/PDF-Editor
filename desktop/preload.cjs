/**
 * Preload-Skript (läuft isoliert und in der Sandbox). Stellt der Seite genau die Funktionen
 * bereit, die src/platform/desktop-bridge.js braucht – kein ipcRenderer, keine Node-APIs,
 * keine Dateipfade. Dateien werden nur über Kennungen angesprochen, die der Hauptprozess für
 * vom Nutzer gewählte Dateien vergibt.
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

let commandHandler = null;
let openHandler = null;
const pendingOpens = [];

ipcRenderer.on('app:command', async (_event, { command, replyId }) => {
  let result = null;
  let error = null;
  try {
    result = commandHandler ? await commandHandler(command) : null;
  } catch (err) {
    error = String((err && err.message) || err);
  }
  if (replyId) ipcRenderer.send('app:command-reply', { replyId, result: result ?? null, error });
});

ipcRenderer.on('app:open-file', (_event, entry) => {
  if (openHandler) openHandler(entry);
  else pendingOpens.push(entry);
});

contextBridge.exposeInMainWorld('pdfEditorDesktop', {
  platform: process.platform,
  showOpenDialog: () => ipcRenderer.invoke('file:open-dialog'),
  showSaveDialog: (suggestedName) => ipcRenderer.invoke('file:save-dialog', String(suggestedName || '')),
  readFile: (id) => ipcRenderer.invoke('file:read', String(id)),
  writeFile: (id, data) => {
    if (!(data instanceof Uint8Array)) throw new TypeError('Uint8Array erwartet');
    return ipcRenderer.invoke('file:write', String(id), data);
  },
  /** Gewährt Zugriff auf eine per Drag & Drop abgelegte Datei (nur echte File-Objekte). */
  grantDroppedFile: (file) => {
    const filePath = webUtils.getPathForFile(file);
    return filePath ? ipcRenderer.invoke('file:grant-dropped', filePath) : Promise.resolve(null);
  },
  setState: (state) =>
    ipcRenderer.send('app:state', {
      hasDocument: !!state.hasDocument,
      name: String(state.name || ''),
      dirty: !!state.dirty,
    }),
  onCommand: (handler) => {
    commandHandler = handler;
  },
  onOpenFile: (handler) => {
    openHandler = handler;
    while (pendingOpens.length) handler(pendingOpens.shift());
  },
  ready: () => ipcRenderer.send('app:ready'),
});

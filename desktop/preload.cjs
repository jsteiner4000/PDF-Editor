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

/** Antworten des Hauptprozesses kommen als { value } oder { error } (deutscher Text ohne Pfad). */
async function call(channel, ...args) {
  const reply = await ipcRenderer.invoke(channel, ...args);
  if (reply && typeof reply.error === 'string') throw new Error(reply.error);
  return reply ? reply.value : undefined;
}

ipcRenderer.on('app:command', async (_event, { command, replyId, fromMenu }) => {
  let result = null;
  let error = null;
  try {
    result = commandHandler ? await commandHandler(command, !!fromMenu) : null;
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
  showOpenDialog: () => call('file:open-dialog'),
  showSaveDialog: (suggestedName) => call('file:save-dialog', String(suggestedName || '')),
  readFile: (id) => call('file:read', String(id)),
  writeFile: (id, data) => {
    if (!(data instanceof Uint8Array)) return Promise.reject(new TypeError('Uint8Array erwartet'));
    return call('file:write', String(id), data);
  },
  /** Gewährt Zugriff auf eine per Drag & Drop abgelegte Datei (nur echte File-Objekte). */
  grantDroppedFile: (file) => {
    let filePath = '';
    try {
      filePath = webUtils.getPathForFile(file);
    } catch {}
    return filePath ? call('file:grant-dropped', filePath) : Promise.resolve(null);
  },
  setState: (state) =>
    ipcRenderer.send('app:state', {
      hasDocument: !!state.hasDocument,
      name: String(state.name || ''),
      dirty: !!state.dirty,
      stripActive: !!state.stripActive,
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

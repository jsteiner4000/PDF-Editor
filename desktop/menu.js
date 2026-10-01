/**
 * Natives Menü (Deutsch, schlank).
 *
 * Tastenkürzel: Die Web-App wertet ihre Kürzel (Strg+O/S/Z/Y, Zoom, Strg+A im Organisieren-
 * Modus, Strg+B/I/U im Texteditor …) selbst aus – wie im Browser. Damit nichts doppelt
 * ausgelöst wird, zeigt das Menü diese Kürzel nur an (`registerAccelerator: false`). Echt
 * registriert werden nur Kürzel, die die Web-App nicht kennt (Drucken, Vollbild, Beenden …).
 */
import { Menu } from 'electron';

const isMac = process.platform === 'darwin';

/**
 * @param {object} actions
 * @param {(command: string) => void} actions.command  Befehl an die Web-App senden
 * @param {() => void} actions.about                  „Über PDF-Editor“
 * @param {() => void} actions.licenses               Lizenzhinweise öffnen
 * @param {() => void} actions.fonts                  Ordner mit den Schriftdateien öffnen
 * @param {boolean} actions.devTools                  Entwicklerwerkzeuge anbieten (nur Entwicklung)
 */
export function buildMenu({ command, about, licenses, fonts, devTools }) {
  // Kürzel, die die Web-App selbst behandelt: nur anzeigen
  const shown = (accelerator) => ({ accelerator, registerAccelerator: false });
  const cmd = (id, label, extra = {}) => ({ id, label, click: () => command(id), ...extra });
  const docItem = (id, label, extra) => cmd(id, label, { enabled: false, ...extra });

  const template = [
    {
      label: 'Datei',
      submenu: [
        cmd('open', 'Öffnen …', shown('CmdOrCtrl+O')),
        {
          role: 'recentDocuments',
          label: 'Zuletzt geöffnet',
          visible: isMac,
          submenu: [{ role: 'clearRecentDocuments', label: 'Liste leeren' }],
        },
        { type: 'separator' },
        docItem('save', 'Speichern', shown('CmdOrCtrl+S')),
        docItem('saveAs', 'Speichern unter …', shown('CmdOrCtrl+Shift+S')),
        { type: 'separator' },
        docItem('print', 'Anzeigen und drucken …', { accelerator: 'CmdOrCtrl+P' }),
        docItem('properties', 'Dokumenteigenschaften'),
        { type: 'separator' },
        docItem('closeDocument', 'Dokument schließen'),
        { type: 'separator' },
        {
          role: 'quit',
          label: 'PDF-Editor beenden',
          accelerator: isMac ? 'Cmd+Q' : 'Alt+F4',
          registerAccelerator: isMac,
        },
      ],
    },
    {
      label: 'Bearbeiten',
      submenu: [
        docItem('undo', 'Rückgängig', shown('CmdOrCtrl+Z')),
        docItem('redo', 'Wiederholen', shown('CmdOrCtrl+Y')),
        { type: 'separator' },
        // Ausschneiden/Kopieren/Einfügen erledigt Chromium in Textfeldern selbst.
        { role: 'cut', label: 'Ausschneiden', registerAccelerator: isMac },
        { role: 'copy', label: 'Kopieren', registerAccelerator: isMac },
        { role: 'paste', label: 'Einfügen', registerAccelerator: isMac },
        { role: 'selectAll', label: 'Alles auswählen', registerAccelerator: isMac },
      ],
    },
    {
      label: 'Ansicht',
      submenu: [
        docItem('zoomIn', 'Vergrößern', shown('CmdOrCtrl+Plus')),
        docItem('zoomOut', 'Verkleinern', shown('CmdOrCtrl+-')),
        docItem('zoomWidth', 'Seitenbreite', shown('CmdOrCtrl+0')),
        docItem('zoomPage', 'Ganze Seite'),
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Vollbild', accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11' },
        ...(devTools
          ? [{ type: 'separator' }, { role: 'toggleDevTools', label: 'Entwicklerwerkzeuge' }]
          : []),
      ],
    },
    {
      label: 'Fenster',
      submenu: [
        { role: 'minimize', label: 'Minimieren' },
        { role: 'zoom', label: 'Zoomen', visible: isMac },
        { role: 'close', label: 'Fenster schließen' },
      ],
    },
    {
      label: 'Hilfe',
      role: 'help',
      submenu: [
        { label: 'Schriftdateien anzeigen', click: fonts },
        { label: 'Lizenzhinweise', click: licenses },
        { type: 'separator' },
        { label: 'Über PDF-Editor', click: about },
      ],
    },
  ];
  return Menu.buildFromTemplate(template);
}

/** Menüpunkte, die nur mit geöffnetem Dokument aktiv sind. */
export const DOCUMENT_ITEMS = [
  'save',
  'saveAs',
  'print',
  'properties',
  'closeDocument',
  'undo',
  'redo',
  'zoomIn',
  'zoomOut',
  'zoomWidth',
  'zoomPage',
];

# PDF-Editor

PDF-Editor: Texte und Bilder in PDF-Dateien bearbeiten, Seiten einfügen, löschen und ordnen.
Das Ergebnis des Builds ist **eine einzige HTML-Datei** (`dist/PDF-Editor.html`), die offline in
Chrome oder Edge läuft – Skript, Stile, Schriften und der pdf.js-Worker sind eingebettet. Dieselbe
Datei wird als **Desktop-App** (Electron, `desktop/`) für Windows ausgeliefert: Installer und
Portable-EXE, mit echter Dateiintegration. Die Bedienung beschreibt `LIESMICH.txt`.

## Schnellstart

```sh
npm ci            # Abhängigkeiten exakt nach package-lock.json installieren
npm run build     # erzeugt dist/PDF-Editor.html
npm test          # baut neu und führt die Regressionstests aus
```

Voraussetzung: Node.js 22 (oder neuer). Für die Tests wird Chromium von Playwright benötigt;
ist er nicht vorhanden: `npx playwright install chromium`.

Weitere Befehle:

| Befehl               | Zweck                                                                      |
| -------------------- | -------------------------------------------------------------------------- |
| `npm run dev`        | baut bei jeder Änderung in `src/` oder `assets/` automatisch neu           |
| `npm run fixtures`   | erzeugt die Test-PDFs in `tests/fixtures/` neu                             |
| `npm run format`     | formatiert Quelltexte mit Prettier                                         |
| `npm run app`        | baut und startet die Desktop-App (Entwicklung)                             |
| `npm run dist:win`   | baut Installer und Portable-EXE nach `release/` (unter Windows)            |
| `npm run dist:linux` | baut die Desktop-App ungepackt nach `release/linux-unpacked/` (zum Testen) |
| `npm run licenses`   | erzeugt `dist/licenses/Lizenzhinweise.txt`                                 |

## Projektstruktur

```
src/
  index.html              HTML-Gerüst (Platzhalter für Favicon, CSS und Skript)
  styles.css              Stile der Oberfläche
  main.js                 Einstiegspunkt (erzeugt window.pdfEditor)
  app.js                  App: Oberfläche, Öffnen/Speichern, Zoom, Seitenansichten, Tastenkürzel
  pdf/
    content-stream.js     Parser/Serialisierer für Content-Streams (ContentOp, NameToken, …)
    content-interpreter.js  Interpretation: Glyphen und Grafikobjekte (Pfade, Bilder, Formulare)
    text-layout.js        Glyphen → Zeilen → Textblöcke (Absätze, Ausrichtung)
    pdf-font.js           Analyse von PDF-Schriften (Codierung, Breiten, ToUnicode)
    pdf-objects.js        Hilfen für pdf-lib-Objekte
    matrix.js             2D-Matrizen
    session.js            PdfSession: Seitenmodelle, Änderungen, Rückgängig/Wiederholen, Speichern
    page-numbers.js       Seitenzahlen und Kopf-/Fußzeilen erkennen und anpassen
  fonts/
    font-manager.js       Schriftfamilien, Schriftbibliothek, Schriftwahl beim Schreiben
    sfnt.js               TrueType/OpenType-Tabellen lesen/schreiben, Teilmengen zusammenführen
    cff.js                CFF-Schriften für die Anzeige als OpenType verpacken
    glyph-list.js         Adobe Glyph List und Standard-Codierungen
  render/pdf-renderer.js  Darstellung mit pdf.js (Worker als Blob-URL), ganze Seite oder Ausschnitt
  render/detail-renderer.js  scharfer Detail-Canvas für den sichtbaren Ausschnitt bei hohem Zoom
  platform/desktop-bridge.js  Anbindung an die Desktop-App (im Browser wirkungslos)
  storage/idb.js          IndexedDB „pdf-editor“ (eigene Schriften, zuletzt geöffnet)
  ui/
    page-view.js          Seitenansicht (Vorschau- und Detail-Canvas) und Koordinatenumrechnung
    zoom-gestures.js      Strg+Mausrad, Touchpad-Pinch, Hand-Werkzeug (Leertaste/mittlere Maustaste)
    edit-mode.js          Modus „PDF bearbeiten“ (Auswahl, Ziehen, Griffe, Text, Bilder)
    text-editor.js        Inline-Texteditor
    snap-guides.js        Hilfslinien/Einrasten
    organize-mode.js      Modus „Seiten organisieren“
    fonts-panel.js        Seitenleiste „Schriften“
    dialogs.js, menu.js, dom.js, icons.js, geometry.js   Oberflächen-Bausteine
desktop/                  Desktop-App (Electron-Hauptprozess)
  main.js                 Fenster, Schema app://, CSP, Sicherheit, IPC, Schließen-Rückfrage
  preload.cjs             eng begrenzte Bridge für den Renderer (window.pdfEditorDesktop)
  file-access.js          Dateizugriff nur auf vom Nutzer gewählte Dateien (Kennungen statt Pfade)
  menu.js                 natives Menü (Deutsch)
  window-state.js         Fenstergröße/-position merken
  installer.nsh           NSIS-Ergänzung: optionale Zuordnung .pdf („Öffnen mit“)
electron-builder.yml      Paketierung (NSIS-Installer, Portable, Linux-Verzeichnis zum Testen)
.github/workflows/release.yml  Windows-Build in GitHub Actions (Tags v*, manuell)
scripts/build.mjs         Build (esbuild) → dist/PDF-Editor.html
scripts/licenses.mjs      Lizenzhinweise der eingebundenen Bibliotheken und Schriften
tests/                    Playwright-Regressionstests, Test-PDFs und deren Generator
assets/
  fonts/embedded/         eingebettete Schriften (verkleinerte Fassungen)
  fonts/full/             vollständige Schriftdateien mit Lizenzen (SIL OFL)
  icon/                   Programmsymbole und Favicon
legacy/                   Version 1.0 als Referenz für die Regressionstests
release/                  Ausgabe von electron-builder (nicht im Repository)
```

## Build

`scripts/build.mjs` bündelt `src/main.js` mit esbuild als IIFE und setzt es zusammen mit
`src/styles.css` in `src/index.html` ein. Zwei virtuelle Module werden dabei erzeugt:

- `virtual:pdfjs-worker` – der separat gebündelte pdf.js-Worker als Quelltext-String
- `virtual:bundled-fonts` – die Schriften aus `assets/fonts/embedded/` (gzip, base64)

Das Favicon stammt aus `assets/icon/favicon-1.0.svg` (Konstante `FAVICON` im Build-Skript).

## Tests

Die Tests in `tests/regression.spec.js` führen jede Szene gegen `legacy/PDF-Editor-1.0.html`
**und** gegen `dist/PDF-Editor.html` aus und vergleichen die Ergebnisse: Darstellung
(Canvas-Pixel, Bildschirmfotos einzelner Bereiche), Textblöcke, gespeicherte PDFs (byte-genau
und per Textextraktion), Verschieben und Einrasten, Seiten einfügen/löschen mit Seitenzahlen,
Rückgängig/Wiederholen, Zoom und Speichern. Zeit und Zufallszahlen sind in den Tests fixiert.

Sobald das Verhalten absichtlich vom Original abweicht, muss der betroffene Vergleich durch
eine fachliche Prüfung ersetzt werden.

Die Desktop-App testet `tests/desktop.spec.js` (Playwright `_electron`): Start mit PDF als
Kommandozeilenargument, Text bearbeiten, Strg+S überschreibt die Datei, „Speichern unter“ und
„Öffnen“ über das native Menü (Dialoge im Test ersetzt), Vorschaufenster, zweite Instanz,
„Zuletzt geöffnet“, Rückfrage beim Schließen und die Isolation des Renderers. Ohne Anzeige
(Linux ohne `DISPLAY`) wird der Test übersprungen; mit `xvfb-run -a npx playwright test` läuft er
auch dort. Als root startet Chromium nur mit `--no-sandbox` (setzt der Test selbst).

`tests/zoom.spec.js` prüft nur den Neubau: Schärfe bei 400–3200 % und devicePixelRatio 1/1,25/1,5,
Zoom zur Mausposition und per Pinch, Hand-Werkzeug, Deckung von Auswahlrahmen und Darstellung bei
3200 %, Speicherbegrenzung der Canvas, Bildlauf-Leistung sowie Verschieben und Speichern bei 3200 %.

## Darstellung bei hohem Zoom

Jede Seite hat einen **Vorschau-Canvas** (ganze Seite, höchstens 4 MP, per CSS gestreckt) und bei
Bedarf einen **Detail-Canvas**, der nur den sichtbaren Ausschnitt plus Überstand in voller
Bildschirmauflösung zeigt (pdf.js mit verschobenem Viewport, alle Detail-Canvas zusammen höchstens
12 MP). Gerendert wird nach kurzer Ruhepause (Bildlauf/Zoom), veraltete Aufgaben werden
abgebrochen. Statt Kacheln ein Ausschnitt je Seite, weil pdf.js bei jedem Aufruf die gesamte
Operatorliste abarbeitet – Kacheln würden diesen Aufwand vervielfachen. Vorschauen nicht sichtbarer
Seiten werden ab 16 MP (älteste zuerst) freigegeben.

## Desktop-App

`desktop/main.js` lädt `dist/PDF-Editor.html` über das eigene Schema `app://pdf-editor/`. Der
Editor bleibt unverändert; `src/platform/desktop-bridge.js` bildet die genutzten Teile der File
System Access API (`showOpenFilePicker`, `showSaveFilePicker`, `getAsFileSystemHandle`,
`getFile`, `createWritable`) über die Bridge nach. Damit gelten die bisherigen Abläufe:
„Speichern“ überschreibt die geöffnete Datei, „Zuletzt geöffnet“ funktioniert (in IndexedDB
liegt nur `{ kind, name, desktopId }`). Die Chromium-eigene File System Access API wird bewusst
nicht verwendet: Für per Kommandozeile/Doppelklick übergebene Dateien gibt es kein Handle, und
Schreibrechte nach einem Neustart erfordern Berechtigungsabfragen ohne Oberfläche in Electron.

- **Dateien**: Öffnen/Speichern unter mit nativen Dialogen; Drag & Drop (Pfad über
  `webUtils.getPathForFile` im Preload); Kommandozeile, Doppelklick, „Öffnen mit“; Single-Instance
  (eine zweite Datei öffnet im laufenden Fenster). Schreiben atomar (temporäre Datei, dann
  umbenennen).
- **Fenster**: Größe/Position werden gemerkt, Mindestgröße 900 × 600, Titel
  `Datei.pdf (Bearbeitet) – PDF-Editor`, Rückfrage bei ungespeicherten Änderungen als nativer
  Dialog (Speichern / Nicht speichern / Abbrechen).
- **Menü**: Datei, Bearbeiten, Ansicht (Zoom der App), Fenster, Hilfe (Über, Lizenzhinweise,
  Schriftdateien). Kürzel, die die Web-App selbst auswertet (Strg+O/S/Z/Y, Zoom, Strg+A …),
  zeigt das Menü nur an (`registerAccelerator: false`) – keine Doppelbelegung.
- **Paketierung** (`electron-builder.yml`): NSIS-Installer auf Deutsch, Benutzerinstallation
  ohne Adminrechte, Startmenü- und Desktop-Verknüpfung, Option „Öffnen mit“ für .pdf (eigene
  Installer-Seite, HKCU), sauberer Uninstaller; Portable-EXE. In `app.asar` liegen nur
  `desktop/`, `dist/PDF-Editor.html`, Symbole und `package.json`; Lizenzhinweise und
  Schriftdateien als `resources/Lizenzen` bzw. `resources/Schriften`.
- **Release**: `.github/workflows/release.yml` auf `windows-latest` bei Tags `v*` und manuell:
  `npm ci`, Build, Desktop-Smoke-Test, Regressionstests, `electron-builder`, Prüfung des
  gepackten Programms (Start mit PDF, Fenstertitel) und des Installers (stille Installation,
  Zuordnung, Startmenü, Deinstallation). Installer, Portable-EXE und `PDF-Editor.html` werden als
  Artefakte bzw. Release-Assets hochgeladen. Der Tag muss zur Version in `package.json` passen.
- Lokal unter Linux: `npm run dist:linux` baut `release/linux-unpacked/`. Windows-Pakete lassen
  sich hier nur mit Wine bauen (`rcedit` für Symbol/Versionsinfo, Uninstaller-Erzeugung).

### Sicherheits-Checkliste (Electron Security Guidelines)

| Punkt                     | Umsetzung                                                                        |
| ------------------------- | -------------------------------------------------------------------------------- |
| Nur lokale Inhalte        | eigenes Schema `app://`; http(s), ws(s), ftp und file werden blockiert           |
| Kein Node im Renderer     | `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`              |
| Content-Security-Policy   | `default-src 'none'`, Skript nur per SHA-256-Hash, Worker nur `blob:`            |
| `webSecurity`             | an (Standard), keine `allowRunningInsecureContent`, keine Experimente            |
| Berechtigungen            | alle Anfragen und Prüfungen abgelehnt (auch Geräte)                              |
| Navigation / neue Fenster | gesperrt; Ausnahme: eigenes PDF-Vorschaufenster (`blob:app://…`, ohne Preload)   |
| `<webview>`               | wird verhindert (`will-attach-webview`)                                          |
| IPC                       | wenige feste Kanäle, Absender wird geprüft, keine Pfade vom Renderer             |
| Dateizugriff              | nur vom Nutzer gewählte Dateien, Schreiben nur in `.pdf`                         |
| Electron-Fuses            | RunAsNode, NODE_OPTIONS, `--inspect` aus; nur aus `app.asar`, Integrität geprüft |
| Entwicklerwerkzeuge       | im Paket deaktiviert                                                             |
| Updates / Telemetrie      | keine (kein Auto-Updater, `publish: null`)                                       |
| Aktuelle Electron-Version | exakt gepinnt (`electron` in `package.json`)                                     |

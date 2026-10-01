# PDF-Editor

PDF-Editor für den Browser: Texte und Bilder in PDF-Dateien bearbeiten, Seiten einfügen,
löschen und ordnen. Das Ergebnis des Builds ist **eine einzige HTML-Datei**
(`dist/PDF-Editor.html`), die offline in Chrome oder Edge läuft – Skript, Stile, Schriften und
der pdf.js-Worker sind eingebettet. Die Bedienung beschreibt `LIESMICH.txt`.

## Schnellstart

```sh
npm ci            # Abhängigkeiten exakt nach package-lock.json installieren
npm run build     # erzeugt dist/PDF-Editor.html
npm test          # baut neu und führt die Regressionstests aus
```

Voraussetzung: Node.js 22 (oder neuer). Für die Tests wird Chromium von Playwright benötigt;
ist er nicht vorhanden: `npx playwright install chromium`.

Weitere Befehle:

| Befehl             | Zweck                                                            |
| ------------------ | ---------------------------------------------------------------- |
| `npm run dev`      | baut bei jeder Änderung in `src/` oder `assets/` automatisch neu |
| `npm run fixtures` | erzeugt die Test-PDFs in `tests/fixtures/` neu                   |
| `npm run format`   | formatiert Quelltexte mit Prettier                               |

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
scripts/build.mjs         Build (esbuild) → dist/PDF-Editor.html
tests/                    Playwright-Regressionstests, Test-PDFs und deren Generator
assets/
  fonts/embedded/         eingebettete Schriften (verkleinerte Fassungen)
  fonts/full/             vollständige Schriftdateien mit Lizenzen (SIL OFL)
  icon/                   Programmsymbole und Favicon
legacy/                   Version 1.0 als Referenz für die Regressionstests
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

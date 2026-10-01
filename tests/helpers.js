/**
 * Hilfsfunktionen für die Regressionstests: Jede Testszene läuft gegen das Original
 * (legacy/PDF-Editor-1.0.html) und gegen den Neubau (dist/PDF-Editor.html); die Ergebnisse
 * werden anschließend verglichen.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const BUILDS = {
  original: path.join(ROOT, 'legacy', 'PDF-Editor-1.0.html'),
  neubau: path.join(ROOT, 'dist', 'PDF-Editor.html'),
};

export const FIXTURE = readFileSync(path.join(ROOT, 'tests', 'fixtures', 'dokument.pdf'));
export const LAYOUT = readFileSync(path.join(ROOT, 'tests', 'fixtures', 'layout.pdf'));

export const sha = (data) => createHash('sha256').update(data).digest('hex').slice(0, 16);

/** Fester Zeitpunkt und deterministischer Zufall, damit gespeicherte PDFs byte-gleich vergleichbar sind. */
const DETERMINISM = `(() => {
  let s = 12345;
  Math.random = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
})();`;

/**
 * Öffnet einen Build in einem frischen Browser-Kontext (eigener Speicher/IndexedDB).
 * @returns {Promise<{page: import('@playwright/test').Page, context: any, errors: string[]}>}
 */
export async function launch(browser, build) {
  const file = BUILDS[build];
  if (!existsSync(file)) throw new Error(`${file} fehlt – vorher "npm run build" ausführen.`);
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  await page.clock.setFixedTime(new Date('2026-03-01T10:00:00+01:00'));
  await page.addInitScript(DETERMINISM);
  await page.goto(pathToFileURL(file).href);
  await page.waitForFunction(() => window.pdfEditor && window.pdfEditor.library.items.size >= 10, null, {
    timeout: 30_000,
  });
  // alle Hinweise (Toasts) mitschreiben – sie verschwinden nach wenigen Sekunden wieder
  await page.evaluate(() => {
    window.__toastLog = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n.classList && n.classList.contains('toast')) window.__toastLog.push(n.textContent);
    }).observe(document.getElementById('toasts'), { childList: true });
  });
  return { page, context, errors };
}

/** Lädt PDF-Bytes über die App (gleicher Weg wie „Datei öffnen“ ohne Dateiauswahl-Dialog). */
export async function openPdf(page, bytes = FIXTURE, name = 'dokument.pdf') {
  const ok = await page.evaluate(
    async ({ b64, name }) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return window.pdfEditor.openBytes(bytes, name, null);
    },
    { b64: Buffer.from(bytes).toString('base64'), name },
  );
  await idle(page);
  return ok;
}

/** Wartet, bis keine Synchronisation/Bearbeitung mehr läuft (ohne auf die Darstellung zu warten). */
export async function settled(page) {
  await page.waitForFunction(
    () => {
      const app = window.pdfEditor;
      return (
        app && !app._syncP && !(app.edit && (app.edit._finishing || app.edit._nudging || app.edit.nudge))
      );
    },
    null,
    { timeout: 30_000, polling: 50 },
  );
}

/**
 * Wartet, bis keine Synchronisation/Bearbeitung/Darstellung mehr läuft und alle sichtbaren Seiten
 * gerendert sind.
 *
 * Hinweis: In Version 1.0 gibt es ein Zeitfenster, in dem eine Seite nach „Esc ohne Änderung“ eine
 * veraltete Darstellung behält (rendered.sig ≠ sig, aber nichts in der Warteschlange). Bleibt dieser
 * Zustand länger als 3 s bestehen, wird die Seite erneut zur Darstellung angemeldet – identisch für
 * Original und Neubau, damit die Tests nicht hängen.
 */
export async function idle(page) {
  for (let round = 0; round < 2; round++) {
    // zwei Frames, damit IntersectionObserver und Layout nachgezogen haben
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    await page.waitForFunction(
      () => {
        const app = window.pdfEditor;
        if (!app || app._syncP || app.rendering || app.renderQueue.size) return false;
        if (app.edit && (app.edit._finishing || app.edit._nudging || app.edit.nudge)) return false;
        const scroller = document.getElementById('scroller');
        const pagesShown = app.session && scroller && !scroller.classList.contains('hidden');
        if (pagesShown && app.pvs.length && !app.pvs.some((pv) => pv.visible)) return false;
        const stale = app.pvs.filter(
          (pv) =>
            pv.visible && !(pv.rendered && pv.rendered.sig === pv.sig && pv.rendered.scale === pv.scale),
        );
        if (!stale.length) {
          window.__staleSince = 0;
          return true;
        }
        const now = performance.now();
        if (!window.__staleSince) window.__staleSince = now;
        else if (now - window.__staleSince > 3000) {
          window.__staleSince = 0;
          stale.forEach((pv) => app.queueRender(pv));
        }
        return false;
      },
      null,
      { timeout: 30_000, polling: 50 },
    );
  }
}

/** Hashes der Seiten-Canvas (Pixelinhalt als PNG). */
export async function canvasHashes(page) {
  const urls = await page.evaluate(() =>
    window.pdfEditor.pvs.map((pv) => (pv.rendered ? pv.canvas.toDataURL('image/png') : null)),
  );
  return urls.map((u) => (u ? sha(u) : null));
}

/**
 * Bildschirmfotos der wichtigsten Bereiche (Kopfzeile, Seitenleisten, erste Seite).
 * Einzelne Elemente statt des ganzen Fensters, weil Ganzfenster-Aufnahmen im Headless-Chromium
 * nicht pixelstabil sind.
 */
export async function screenshots(page, selectors = ['#top', '#left', '#right', '.page']) {
  // Maus aus dem Weg (Hover-Zustände) und Übergänge abklingen lassen
  await page.mouse.move(1, 999);
  await page.waitForTimeout(400);
  await idle(page);
  // Die schwebende Navigation liegt mit Weichzeichner (backdrop-filter) über der Seite – das
  // Ergebnis ist nicht pixelstabil, daher wird sie für die Aufnahme ausgeblendet.
  await page.evaluate(() => document.getElementById('nav').style.setProperty('visibility', 'hidden'));
  const out = {};
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    out[sel] = (await loc.isVisible()) ? sha(await loc.screenshot()) : null;
  }
  await page.evaluate(() => document.getElementById('nav').style.removeProperty('visibility'));
  return out;
}

/** Gespeicherte PDF-Bytes (gleicher Weg wie Speichern: Bearbeitung abschließen, aufräumen, speichern). */
export async function savedBytes(page) {
  const b64 = await page.evaluate(async () => {
    const bytes = await window.pdfEditor.bytesForSave();
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000)
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(s);
  });
  return Buffer.from(b64, 'base64');
}

/** Textinhalt aller Seiten eines PDFs (pdf.js in Node). */
export async function extractText(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false })
    .promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(
      tc.items
        .map((it) => it.str + (it.hasEOL ? '\n' : ''))
        .join('')
        .replace(/[ \t]+/g, ' ')
        .trim(),
    );
  }
  await doc.destroy();
  return pages;
}

/** Bildschirmkoordinaten eines PDF-Punkts auf Seite `index`; scrollt den Punkt bei Bedarf in den sichtbaren Bereich. */
export async function clientPoint(page, index, x, y) {
  const at = () =>
    page.evaluate(
      ({ index, x, y }) => {
        const pv = window.pdfEditor.pvs[index];
        return pv.layerToClient(...pv.pdfToLayer(x, y));
      },
      { index, x, y },
    );
  let p = await at();
  const height = await page.evaluate(() => window.innerHeight);
  if (p[1] < 120 || p[1] > height - 120) {
    await page.evaluate((dy) => (document.querySelector('#scroller').scrollTop += dy), p[1] - height / 2);
    await idle(page);
    p = await at();
  }
  return p;
}

/** Textblock auf Seite `index`, dessen Text `needle` enthält: { bbox, text, editable }. */
export async function findBlock(page, index, needle) {
  return page.evaluate(
    ({ index, needle }) => {
      const b = window.pdfEditor.session.model(index).blocks.find((bl) => bl.text.includes(needle));
      return b
        ? {
            bbox: b.bbox,
            text: b.text,
            editable: b.editable,
            lines: b.lines.map((l) => ({ y: l.y, x0: l.x0, ex: l.ex })),
          }
        : null;
    },
    { index, needle },
  );
}

/** Grafikobjekte der Seite `index` (Typ, sichtbares Rechteck, Gruppengröße). */
export async function objectsOf(page, index) {
  return page.evaluate(
    (index) =>
      window.pdfEditor.session
        .model(index)
        .objects.map((o) => ({
          type: o.type,
          vis: o.vis.map((v) => Math.round(v * 100) / 100),
          selectable: o.selectable,
          group: o.cluster ? o.cluster.members.length : 0,
        })),
    index,
  );
}

/** Zustand der Oberfläche, der zwischen Original und Neubau gleich sein muss. */
export async function uiState(page) {
  return page.evaluate(() => {
    const app = window.pdfEditor;
    const q = (s) => document.querySelector(s);
    return {
      title: document.title,
      pages: app.session ? app.session.numPages : 0,
      pgN: q('#pgN') && q('#pgN').textContent,
      zoomLabel: q('#bZoom') && q('#bZoom').textContent,
      zoom: Math.round(app.zoom * 10000) / 10000,
      fit: app.fit,
      tool: app.tool,
      undo: app.session ? app.session.hist.undo.map((e) => e.label) : [],
      redo: app.session ? app.session.hist.redo.map((e) => e.label) : [],
      dirty: app.session ? app.session.dirty : false,
      pageSizes: app.pvs.map((pv) => [
        pv.el.style.width,
        pv.el.style.height,
        pv.canvas.width,
        pv.canvas.height,
      ]),
      undoDisabled: q('#bUndo').disabled,
      redoDisabled: q('#bRedo').disabled,
      undoTitle: q('#bUndo').title,
    };
  });
}

/** Alle bisher angezeigten Hinweise (Toasts) in Reihenfolge. */
export async function toasts(page) {
  return page.evaluate(() => window.__toastLog.slice());
}

/**
 * Führt `scenario` für Original und Neubau aus und gibt beide Ergebnisse zurück.
 * Fehler auf der Seite (pageerror/console.error) werden mitgeliefert.
 */
export async function runBoth(browser, scenario) {
  const out = {};
  for (const build of Object.keys(BUILDS)) {
    const { page, context, errors } = await launch(browser, build);
    try {
      out[build] = await scenario(page, build);
      out[build + 'Errors'] = errors;
    } finally {
      await context.close();
    }
  }
  return out;
}

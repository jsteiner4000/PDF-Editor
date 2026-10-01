/**
 * Hoher Zoom (bis 3200 %): Schärfe, Zoom zur Mausposition, Deckung der Overlays,
 * Speicherbegrenzung, Verschieben bei 32× und Bildlauf-Leistung. Nur Neubau.
 */
import { test, expect } from '@playwright/test';
import { pathToFileURL } from 'node:url';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { BUILDS, openPdf, idle, objectsOf } from './helpers.js';

const PT = 96 / 72;

/** Öffnet den Neubau mit eigenem devicePixelRatio. */
async function launch(browser, dpr = 1) {
  const context = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: dpr,
    locale: 'de-DE',
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push('console: ' + m.text());
  });
  await page.goto(pathToFileURL(BUILDS.neubau).href);
  await page.waitForFunction(() => window.pdfEditor && window.pdfEditor.library.items.size >= 10);
  return { page, context, errors };
}

/** Wartet, bis Vorschau und Detail-Canvas fertig sind. */
async function zoomIdle(page) {
  await idle(page);
  await page.waitForFunction(() => !window.pdfEditor.detail.pending, null, { polling: 30 });
  await idle(page);
  await page.waitForFunction(() => !window.pdfEditor.detail.pending, null, { polling: 30 });
}

/** Zoom mit Anker auf einem PDF-Punkt von Seite `index`, der in die Fenstermitte rückt. */
async function zoomOnto(page, zoom, index, x, y) {
  await page.evaluate(
    ({ zoom, index, x, y }) => {
      const app = window.pdfEditor;
      const s = document.getElementById('scroller');
      const r = s.getBoundingClientRect();
      app.setZoom(zoom, null, true, {
        pv: app.pvs[index],
        pdf: [x, y],
        clientX: r.left + s.clientWidth / 2,
        clientY: r.top + s.clientHeight / 2,
      });
    },
    { zoom, index, x, y },
  );
  await zoomIdle(page);
}

/**
 * Kleinste effektive Auflösung (Geräte-Pixel je CSS-Pixel ÷ dpr) im sichtbaren Bereich aller
 * Seiten: Detail-Canvas, wo er den sichtbaren Teil abdeckt, sonst die Vorschau.
 */
const sharpness = (page) =>
  page.evaluate(() => {
    const app = window.pdfEditor;
    const dpr = devicePixelRatio;
    const s = document.getElementById('scroller');
    const sr = s.getBoundingClientRect();
    const view = {
      left: sr.left,
      top: sr.top,
      right: sr.left + s.clientWidth,
      bottom: sr.top + s.clientHeight,
    };
    let min = Infinity;
    const pages = [];
    for (const pv of app.pvs) {
      const pr = pv.el.getBoundingClientRect();
      const core = {
        left: Math.max(pr.left, view.left),
        top: Math.max(pr.top, view.top),
        right: Math.min(pr.right, view.right),
        bottom: Math.min(pr.bottom, view.bottom),
      };
      if (core.right <= core.left || core.bottom <= core.top) continue;
      let value = pv.canvas.width / pr.width / dpr;
      if (!pv.detail.hidden && pv.detail.width) {
        const dr = pv.detail.getBoundingClientRect();
        const covers =
          dr.left <= core.left + 0.5 &&
          dr.top <= core.top + 0.5 &&
          dr.right >= core.right - 0.5 &&
          dr.bottom >= core.bottom - 0.5;
        if (covers) value = Math.max(value, pv.detail.width / dr.width / dpr);
      }
      pages.push(Math.round(value * 1000) / 1000);
      min = Math.min(min, value);
    }
    return { min, pages, pixels: app.canvasPixels() };
  });

test('Schärfe bei 400 % bis 3200 % (dpr 1 / 1,25 / 1,5)', async ({ browser }) => {
  test.setTimeout(180_000);
  const rows = [];
  for (const dpr of [1, 1.25, 1.5]) {
    const { page, context, errors } = await launch(browser, dpr);
    try {
      await openPdf(page);
      for (const zoom of [4, 8, 16, 32]) {
        // Mitte der Seite (Text und Grafik) bzw. die Kante des orangefarbenen Rechtecks
        await zoomOnto(page, zoom, 0, 300, 450);
        const m = await sharpness(page);
        rows.push({
          dpr,
          zoom,
          schaerfe: Math.round(m.min * 1000) / 1000,
          MP: +(m.pixels.total / 1e6).toFixed(1),
        });
        expect(m.min, `dpr ${dpr}, Zoom ${zoom}`).toBeGreaterThanOrEqual(0.95);
        expect(m.pixels.detail).toBeLessThanOrEqual(12e6);
      }
      expect(await page.locator('#bZoom').textContent()).toBe('3.200 %');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  }
  console.table(rows);
});

test('Zoom zur Mausposition (Strg+Mausrad, Pinch), Strg+1, Eingabefeld', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 1.25);
  try {
    await openPdf(page);
    await zoomOnto(page, 2, 0, 300, 450);
    const box = await page.locator('#scroller').boundingBox();
    const mouse = [Math.round(box.x + box.width * 0.62), Math.round(box.y + box.height * 0.41)];
    await page.mouse.move(...mouse);
    const pin = await page.evaluate(([x, y]) => window.pdfEditor.pvs[0].clientToPdf(x, y), mouse);
    const drift = () =>
      page.evaluate(
        ({ pin, mouse }) => {
          const pv = window.pdfEditor.pvs[0];
          const [x, y] = pv.layerToClient(...pv.pdfToLayer(...pin));
          return Math.hypot(x - mouse[0], y - mouse[1]);
        },
        { pin, mouse },
      );
    // Strg+Mausrad: eine Stufe je Raste, bis 3200 %
    const labels = [];
    for (let i = 0; i < 8; i++) {
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -100);
      await page.keyboard.up('Control');
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(r)));
      labels.push(await page.locator('#bZoom').textContent());
      expect(await drift(), 'Punkt unter dem Zeiger nach ' + labels.at(-1)).toBeLessThanOrEqual(2);
    }
    expect(labels).toEqual(['250 %', '300 %', '400 %', '600 %', '800 %', '1.200 %', '1.600 %', '2.400 %']);
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
    expect(await page.locator('#bZoom').textContent()).toBe('3.200 %');
    expect(await drift()).toBeLessThanOrEqual(2);
    await zoomIdle(page);

    // Pinch auf dem Touchpad: ctrlKey ohne gedrückte Strg-Taste, feine Ausschläge → stufenlos
    await page.evaluate(([x, y]) => {
      const target = document.elementFromPoint(x, y);
      for (let i = 0; i < 12; i++)
        target.dispatchEvent(
          new WheelEvent('wheel', {
            ctrlKey: true,
            deltaY: 3.5,
            clientX: x,
            clientY: y,
            bubbles: true,
            cancelable: true,
          }),
        );
    }, mouse);
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    const zoom = await page.evaluate(() => window.pdfEditor.zoom);
    expect(zoom).toBeCloseTo(32 * Math.exp(-0.42), 2);
    expect(await drift()).toBeLessThanOrEqual(2);

    // Strg+1 = 100 %, Strg+0 = Seitenbreite
    await page.keyboard.press('Control+1');
    expect(await page.locator('#bZoom').textContent()).toBe('100 %');
    await page.keyboard.press('Control+0');
    expect(await page.locator('#bZoom').textContent()).toBe('125 %');

    // Eigener Wert im Zoom-Menü
    await page.locator('#bZoom').click();
    await page.locator('.menu .zin input').fill('1.750');
    await page.keyboard.press('Enter');
    expect(await page.locator('#bZoom').textContent()).toBe('1.750 %');
    await page.locator('#bZoom').click();
    await page.locator('.menu .zin input').fill('5000');
    await page.keyboard.press('Enter');
    expect(await page.locator('#bZoom').textContent()).toBe('3.200 %');
    await zoomIdle(page);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Leertaste + Ziehen verschiebt den Ausschnitt, ohne zu bearbeiten', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 1);
  try {
    await openPdf(page);
    await page.locator('#lpBody .tool', { hasText: 'PDF bearbeiten' }).click();
    await zoomOnto(page, 16, 0, 400, 440);
    const before = await page.evaluate(() => {
      const s = document.getElementById('scroller');
      return [s.scrollLeft, s.scrollTop];
    });
    const box = await page.locator('#scroller').boundingBox();
    const c = [box.x + box.width / 2, box.y + box.height / 2];
    await page.keyboard.down('Space');
    expect(await page.locator('#scroller.pan-ready').count()).toBe(1);
    await page.mouse.move(...c);
    await page.mouse.down();
    await page.mouse.move(c[0] - 150, c[1] - 90, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up('Space');
    const after = await page.evaluate(() => {
      const s = document.getElementById('scroller');
      return [s.scrollLeft, s.scrollTop];
    });
    expect(after[0] - before[0]).toBeCloseTo(150, 0);
    expect(after[1] - before[1]).toBeCloseTo(90, 0);
    // weder ausgewählt noch verschoben
    expect(await page.evaluate(() => window.pdfEditor.edit.hasSelection())).toBe(false);
    expect(await page.evaluate(() => window.pdfEditor.session.hist.undo.length)).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

/** Rand eines farbigen Bereichs im Detail-Canvas, in Client-Koordinaten. */
const edgeInDetail = (page, axis, at, from, to) =>
  page.evaluate(
    ({ axis, at, from, to }) => {
      const pv = window.pdfEditor.pvs[0];
      const c = pv.detail;
      const r = c.getBoundingClientRect();
      const k = c.width / r.width;
      const ctx = c.getContext('2d');
      const isColored = (px) => px[0] - px[2] > 80; // orange/rot, kein Schwarz/Weiß/Blau
      const steps = Math.round(Math.abs(to - from) * k);
      const dir = Math.sign(to - from);
      let prev = null;
      for (let i = 0; i <= steps; i++) {
        const client = from + (dir * i) / k;
        const x = axis === 'x' ? (client - r.left) * k : (at - r.left) * k;
        const y = axis === 'x' ? (at - r.top) * k : (client - r.top) * k;
        const colored = isColored(ctx.getImageData(Math.floor(x), Math.floor(y), 1, 1).data);
        if (prev === false && colored) return client;
        prev = colored;
      }
      return null;
    },
    { axis, at, from, to },
  );

test('Overlays bei 3200 % deckungsgleich, Strg+2 zoomt auf die Auswahl', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 1.5);
  try {
    await openPdf(page);
    await page.locator('#lpBody .tool', { hasText: 'PDF bearbeiten' }).click();
    await idle(page);
    // orangefarbenes Rechteck (re-Operator, 300/380, 200 × 120 pt) auswählen
    const [x, y] = await page.evaluate(() => {
      const pv = window.pdfEditor.pvs[0];
      return pv.layerToClient(...pv.pdfToLayer(400, 440));
    });
    await page.mouse.click(x, y);
    expect(await page.evaluate(() => window.pdfEditor.edit.hasSelection())).toBe(true);
    await page.keyboard.press('Control+2');
    await zoomIdle(page);
    const fitZoom = await page.evaluate(() => window.pdfEditor.zoom);
    expect(fitZoom).toBeGreaterThan(2);
    // Auswahlrahmen mittig
    const sel = await page.locator('.sel').boundingBox();
    const sb = await page.locator('#scroller').boundingBox();
    expect(Math.abs(sel.x + sel.width / 2 - (sb.x + sb.width / 2))).toBeLessThan(10);

    // 3200 % auf die linke obere Ecke
    await zoomOnto(page, 32, 0, 300, 500);
    const frame = await page.locator('.sel').boundingBox();
    // Rahmen (Outline 1,5 px außen) gegen die erste orangefarbene Pixelspalte/-zeile
    const midY = frame.y + 200;
    const midX = frame.x + 200;
    const left = await edgeInDetail(page, 'x', midY, frame.x - 100, frame.x + 100);
    const top = await edgeInDetail(page, 'y', midX, frame.y - 100, frame.y + 100);
    expect(left).not.toBeNull();
    expect(top).not.toBeNull();
    expect(Math.abs(left - frame.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(top - frame.y)).toBeLessThanOrEqual(1);
    // Strg+Plus/Minus behalten die Auswahl an ihrer Stelle
    const selCenter = async () => {
      const b = await page.evaluate(() => {
        const app = window.pdfEditor;
        const box = app.edit.selBox();
        const pv = app.edit.sel.pv;
        return pv.layerToClient(...pv.pdfToLayer((box[0] + box[2]) / 2, (box[1] + box[3]) / 2));
      });
      return b;
    };
    await zoomOnto(page, 4, 0, 400, 440);
    const c0 = await selCenter();
    await page.keyboard.press('Control+Equal');
    const c1 = await selCenter();
    expect(await page.locator('#bZoom').textContent()).toBe('600 %');
    expect(Math.hypot(c1[0] - c0[0], c1[1] - c0[1])).toBeLessThanOrEqual(2);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

/** Mehrseitiges PDF mit Grafik und Text (für Speicher- und Leistungsmessung). */
async function manyPages(n = 12) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < n; i++) {
    const p = doc.addPage([595.28, 841.89]);
    p.drawText('Seite ' + (i + 1), { x: 56, y: 780, size: 24, font });
    for (let k = 0; k < 60; k++)
      p.drawLine({
        start: { x: 40 + k * 8, y: 60 },
        end: { x: 560 - k * 8, y: 740 },
        thickness: 0.25 + (k % 4) * 0.25,
        color: rgb((k % 7) / 7, 0.2, 0.5),
      });
    for (let k = 0; k < 40; k++)
      p.drawText('Feine Schrift Zeile ' + k, { x: 60 + (k % 3) * 160, y: 100 + k * 15, size: 4, font });
  }
  return Buffer.from(await doc.save());
}

test('Speicherbegrenzung: Canvas-Pixel bleiben bei 3200 % über viele Seiten begrenzt', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const { page, context, errors } = await launch(browser, 1.5);
  try {
    await openPdf(page, await manyPages(12), 'viele-seiten.pdf');
    const peaks = { total: 0, detail: 0, preview: 0 };
    const sample = async () => {
      const px = await page.evaluate(() => window.pdfEditor.canvasPixels());
      for (const k of Object.keys(peaks)) peaks[k] = Math.max(peaks[k], px[k]);
    };
    // zuerst alle Seiten bei 300 % ansehen (füllt den Vorschau-Cache), dann bei 3200 % durchblättern
    for (const zoom of [3, 32]) {
      for (let i = 0; i < 12; i++) {
        await zoomOnto(page, zoom, i, 300, 420);
        await sample();
      }
    }
    // Vorschau: sichtbare Seiten (je ≤ 4 MP) + Cache 16 MP; Detail ≤ 12 MP
    expect(peaks.detail).toBeLessThanOrEqual(12e6);
    expect(peaks.preview).toBeLessThanOrEqual(3 * 4e6 + 16e6);
    expect(peaks.total).toBeLessThanOrEqual(40e6);
    const remembered = await page.evaluate(() =>
      window.pdfEditor.pvs.reduce((n, pv) => n + pv.bitmaps.length, 0),
    );
    expect(remembered).toBeLessThanOrEqual(3);
    console.log(
      'Canvas-Pixel (Spitze, MP):',
      Object.fromEntries(Object.entries(peaks).map(([k, v]) => [k, +(v / 1e6).toFixed(1)])),
    );
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Bildlauf bei 3200 %: flüssig, Detail wird nachgerendert', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page, context, errors } = await launch(browser, 1.25);
  try {
    await openPdf(page, await manyPages(3), 'viele-seiten.pdf');
    await zoomOnto(page, 32, 0, 300, 420);
    const result = await page.evaluate(async () => {
      const s = document.getElementById('scroller');
      const frames = [];
      let last = performance.now();
      for (let i = 0; i < 180; i++) {
        s.scrollTop += 24;
        s.scrollLeft += i % 2 ? 6 : -6;
        await new Promise((r) => requestAnimationFrame(r));
        const now = performance.now();
        frames.push(now - last);
        last = now;
      }
      frames.sort((a, b) => a - b);
      return {
        median: frames[frames.length >> 1],
        p95: frames[Math.floor(frames.length * 0.95)],
        max: frames.at(-1),
      };
    });
    await zoomIdle(page);
    const stats = await page.evaluate(() => window.pdfEditor.detail.stats.slice(-10));
    const m = await sharpness(page);
    console.log(
      'Bildlauf 3200 % – Frame-Abstand (ms):',
      result,
      'Detail-Renderzeiten (ms):',
      stats.map((s) => s.ms),
    );
    expect(m.min).toBeGreaterThanOrEqual(0.95);
    expect(result.median).toBeLessThan(40);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Objekt bei 3200 % verschieben und speichern', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 1.25);
  let saved;
  try {
    await openPdf(page);
    await page.locator('#lpBody .tool', { hasText: 'PDF bearbeiten' }).click();
    await idle(page);
    const before = (await objectsOf(page, 0)).find((o) => o.type === 'image');
    const cx = (before.vis[0] + before.vis[2]) / 2;
    const cy = (before.vis[1] + before.vis[3]) / 2;
    await zoomOnto(page, 32, 0, cx, cy);
    const box = await page.locator('#scroller').boundingBox();
    const c = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.click(...c);
    expect(await page.evaluate(() => window.pdfEditor.edit.hasSelection())).toBe(true);
    // 64 px nach rechts, 32 px nach oben = 1,5 pt bzw. 0,75 pt bei 3200 %
    const scale = 32 * PT;
    await page.mouse.move(...c);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(c[0] + (64 * i) / 8, c[1] - (32 * i) / 8);
    // Bildkopie beim Ziehen stammt aus dem scharfen Detail-Canvas
    const ghost = await page.evaluate(() => {
      const g = document.querySelector('.ghost');
      return g ? { w: g.width, css: parseFloat(g.style.width), dpr: devicePixelRatio } : null;
    });
    await page.mouse.up();
    await page.waitForFunction(() => !window.pdfEditor.edit.drag);
    await zoomIdle(page);
    if (ghost) expect(ghost.w / ghost.css).toBeGreaterThan(0.2); // auf 4 MP begrenzt, nicht leer
    const after = (await objectsOf(page, 0)).find((o) => o.type === 'image');
    expect(after.vis[0] - before.vis[0]).toBeCloseTo(64 / scale, 2);
    expect(after.vis[1] - before.vis[1]).toBeCloseTo(32 / scale, 2);
    saved = await page.evaluate(async () => {
      const bytes = await window.pdfEditor.bytesForSave();
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000)
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
  // gespeicherte Datei neu öffnen: Bild an der neuen Stelle
  const reopened = await launch(browser, 1);
  try {
    await openPdf(reopened.page, Buffer.from(saved, 'base64'), 'gespeichert.pdf');
    const img = (await objectsOf(reopened.page, 0)).find((o) => o.type === 'image');
    expect(img.vis[0]).toBeCloseTo(320 + 64 / (32 * PT), 1);
    expect(img.vis[1]).toBeCloseTo(200 + 32 / (32 * PT), 1);
  } finally {
    await reopened.context.close();
  }
});

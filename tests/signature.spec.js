/**
 * Ende-zu-Ende-Tests „Unterschrift“ (nur Neubau):
 *   Unterschrift aus einem PDF-Bereich übernehmen → sichern → Seite neu laden (Persistenz in
 *   IndexedDB) → in einem anderen Dokument auf Seite 2 einsetzen → PDF speichern → gespeichertes
 *   PDF mit pdf-lib prüfen (Image-XObject mit SMask) und mit pdf.js rendern (transparente Stelle
 *   zeigt den farbigen Seitenhintergrund, Tinte ist dunkel).
 * Außerdem: Migration der Datenbank von Version 1 auf 2 ohne Datenverlust, Zeichnen.
 */
import { test, expect } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { PDFDocument, PDFName, PDFRawStream, PDFDict, rgb, degrees, StandardFonts } from 'pdf-lib';
import { launch, openPdf, idle, settled, savedBytes, BUILDS } from './helpers.js';

/** Signaturähnlicher Pfad (SVG-Syntax, y nach unten) – Schleifen und ein Schwung. */
const SIGNATURE_SVG =
  'M 0 30 C 10 -10, 22 -6, 18 22 C 15 40, 30 34, 36 12 C 40 -2, 46 4, 44 22 ' +
  'C 43 34, 56 30, 62 14 C 66 4, 72 8, 70 24 C 69 34, 84 30, 96 18 C 104 10, 118 12, 132 20';

/** Dokument A: Vertrag mit grauem „Scan“-Feld, Formularlinie und blauer Unterschrift darauf. */
async function contractPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([595.28, 841.89]);
    page.drawText(i ? 'Seite 2' : 'Vertrag', { x: 72, y: 760, size: 18, font });
    if (i) continue;
    page.drawRectangle({ x: 60, y: 160, width: 300, height: 110, color: rgb(0.93, 0.93, 0.92) });
    page.drawText('Ort, Datum, Unterschrift', { x: 80, y: 172, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
    page.drawLine({
      start: { x: 80, y: 200 },
      end: { x: 340, y: 200 },
      thickness: 0.8,
      color: rgb(0.2, 0.2, 0.2),
    });
    page.drawSvgPath(SIGNATURE_SVG, {
      x: 110,
      y: 240,
      scale: 1.2,
      borderColor: rgb(0.1, 0.16, 0.5),
      borderWidth: 1.6,
    });
  }
  return Buffer.from(await doc.save());
}

/** Dokument B: zwei Seiten, Seite 2 vollflächig hellgelb (um Transparenz sichtbar zu machen). */
async function targetPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < 2; i++) {
    const page = doc.addPage([595.28, 841.89]);
    if (i) page.drawRectangle({ x: 0, y: 0, width: 595.28, height: 841.89, color: rgb(1, 0.92, 0.6) });
    page.drawText('Angebot – Seite ' + (i + 1), { x: 72, y: 760, size: 16, font });
  }
  return Buffer.from(await doc.save());
}

/** PDF-Punkt (Seite `index`) → Bildschirmkoordinaten. */
function clientOf(page, index, x, y) {
  return page.evaluate(
    ([index, x, y]) => {
      const pv = window.pdfEditor.pvs[index];
      pv.el.scrollIntoView({ block: 'center' });
      return pv.layerToClient(...pv.pdfToLayer(x, y));
    },
    [index, x, y],
  );
}

async function enterEditMode(page) {
  await page.evaluate(() => window.pdfEditor.setTool('edit'));
  await page.locator('#cAddSig').waitFor();
}

async function readSignatures(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('pdf-editor');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('signatures')) {
            db.close();
            return resolve({ version: db.version, items: null });
          }
          const all = db.transaction('signatures').objectStore('signatures').getAll();
          all.onsuccess = () => {
            const version = db.version;
            db.close();
            resolve({
              version,
              items: all.result.map((r) => ({ ...r, png: r.png.byteLength })),
            });
          };
          all.onerror = () => reject(all.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
}

test('Unterschrift aus PDF übernehmen, nach Neuladen in anderem Dokument einsetzen und speichern', async ({
  browser,
}, testInfo) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  // --- 1. Unterschrift aus Dokument A übernehmen
  expect(await openPdf(page, await contractPdf(), 'vertrag.pdf')).toBe(true);
  await enterEditMode(page);
  await page.locator('#cAddSig').click();
  await expect(page.locator('.sig-pop')).toBeVisible();
  await expect(page.locator('.sig-pop .sig-empty')).toBeVisible();
  await page.getByRole('button', { name: 'Aus Dokument übernehmen' }).click();
  await expect(page.locator('.sig-hint')).toContainText('Rahmen um die Unterschrift');
  // Rahmen um die Unterschrift, die die Formularlinie (y = 200) kreuzt (PDF: x 95…290, y 184…262)
  const [ax, ay] = await clientOf(page, 0, 95, 262);
  const [bx, by] = await clientOf(page, 0, 290, 184);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move((ax + bx) / 2, (ay + by) / 2, { steps: 4 });
  await page.mouse.move(bx, by, { steps: 4 });
  await page.mouse.up();
  const sheet = page.locator('.dlg.sig-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.locator('.sig-preview canvas')).toBeVisible();
  // nichts ausgewählt oder verschoben (Bearbeiten-Modus hat die Zeigerereignisse nicht gesehen)
  expect(await page.evaluate(() => window.pdfEditor.edit.sel)).toBeNull();
  expect(await page.evaluate(() => window.pdfEditor.session.hist.undo.length)).toBe(0);
  // Vorschau: ganzer Bereich, der Zuschnittrahmen liegt automatisch um die Tinte. Die
  // Formularlinie läuft über die ganze Breite – bliebe sie stehen, wäre der Rahmen so breit wie
  // der Bereich.
  // Fokus liegt im Sheet (Namensfeld)
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('sigName');
  const frameWidth = () => sheet.locator('.sig-crop').evaluate((el) => parseFloat(el.style.width) / 100);
  expect(await frameWidth()).toBeGreaterThan(0.7);
  expect(await frameWidth()).toBeLessThan(0.92);
  await sheet.locator('#sigLines').uncheck();
  await expect.poll(frameWidth).toBeGreaterThan(0.97);
  await sheet.locator('#sigLines').check();
  await expect.poll(frameWidth).toBeLessThan(0.92);
  await sheet.screenshot({ path: testInfo.outputPath('vorschau.png') });
  await sheet.getByRole('radio', { name: 'Dunkelblau' }).click();
  await sheet.locator('#sigName').fill('Max Mustermann');
  await sheet.getByRole('button', { name: 'Sichern' }).click();
  await expect(sheet).toBeHidden();
  let stored = await readSignatures(page);
  expect(stored.version).toBe(2);
  expect(stored.items).toHaveLength(1);
  const record = stored.items[0];
  expect(record).toMatchObject({
    name: 'Max Mustermann',
    kind: 'signature',
    source: 'document',
    isDefault: true,
  });
  // natürliche Größe ≈ Größe im Dokument (Pfad ca. 158 × 55 pt ≈ 56 × 19 mm, plus Rand)
  expect(record.widthMm).toBeGreaterThan(50);
  expect(record.widthMm).toBeLessThan(66);
  expect(record.aspect).toBeCloseTo(record.width / record.height, 5);
  // gespeichertes PNG höchstens 300 dpi bezogen auf 1,6 × 50 mm
  expect(record.width).toBeLessThanOrEqual(945);
  expect(record.width).toBeGreaterThan(900);

  // --- 2. Neu laden: Unterschrift ist noch da
  await page.reload();
  await page.waitForFunction(() => window.pdfEditor && window.pdfEditor.library.items.size >= 10, null, {
    timeout: 30_000,
  });
  stored = await readSignatures(page);
  expect(stored.items.map((r) => r.name)).toEqual(['Max Mustermann']);

  // --- 3. In Dokument B auf Seite 2 einsetzen
  expect(await openPdf(page, await targetPdf(), 'angebot.pdf')).toBe(true);
  await enterEditMode(page);
  await page.locator('#cAddSig').click();
  const card = page.locator('.sig-pop .sig-card');
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Max Mustermann');
  await expect(card.locator('.def')).toHaveText('Standard');
  await card.click();
  await expect(page.locator('.sig-hint')).toContainText('Max Mustermann');
  const target = [300, 300];
  const [tx, ty] = await clientOf(page, 1, ...target);
  await page.mouse.move(tx - 20, ty - 20);
  await page.mouse.move(tx, ty, { steps: 3 });
  await expect(page.locator('.sig-ghost')).toBeVisible();
  await page.mouse.click(tx, ty);
  await settled(page);
  await idle(page);
  const placed = await page.evaluate(() => {
    const app = window.pdfEditor;
    const sel = app.edit.sel;
    return {
      label: app.session.hist.undo[app.session.hist.undo.length - 1].label,
      selPage: sel && sel.pv.index,
      selType: sel && sel.objs.map((o) => o.type),
      vis: sel && sel.objs[0].vis,
    };
  });
  expect(placed.label).toBe('Unterschrift eingefügt');
  expect(placed.selPage).toBe(1);
  expect(placed.selType).toEqual(['image']);
  const [x0, y0, x1, y1] = placed.vis;
  const widthMm = ((x1 - x0) / 72) * 25.4;
  expect(widthMm).toBeCloseTo(50, 0);
  expect((x1 - x0) / (y1 - y0)).toBeCloseTo(record.aspect, 1);
  expect((x0 + x1) / 2).toBeCloseTo(target[0], 0);
  expect((y0 + y1) / 2).toBeCloseTo(target[1], 0);

  // Rückgängig/Wiederholen
  await page.keyboard.press('Control+z');
  await settled(page);
  expect(
    await page.evaluate(
      () => window.pdfEditor.session.model(1).objects.filter((o) => o.type === 'image').length,
    ),
  ).toBe(0);
  await page.keyboard.press('Control+y');
  await settled(page);
  expect(
    await page.evaluate(
      () => window.pdfEditor.session.model(1).objects.filter((o) => o.type === 'image').length,
    ),
  ).toBe(1);

  // Zweites Mal einsetzen (Taste U = Standard-Unterschrift) – wird nicht erneut eingebettet
  await page.keyboard.press('Escape'); // Auswahl aufheben
  await page.keyboard.press('u');
  await expect(page.locator('.sig-hint')).toContainText('Max Mustermann');
  const [ux, uy] = await clientOf(page, 1, 300, 600);
  await page.mouse.move(ux, uy);
  await page.mouse.click(ux, uy);
  await settled(page);
  expect(
    await page.evaluate(
      () => window.pdfEditor.session.model(1).objects.filter((o) => o.type === 'image').length,
    ),
  ).toBe(2);

  // --- 4. Speichern und mit pdf-lib prüfen
  const bytes = await savedBytes(page);
  const saved = await PDFDocument.load(bytes);
  const page2 = saved.getPage(1);
  const xobjects = page2.node.Resources().lookup(PDFName.of('XObject'), PDFDict);
  const images = xobjects
    .entries()
    .map(([, ref]) => saved.context.lookup(ref))
    .filter(
      (obj) => obj instanceof PDFRawStream && obj.dict.get(PDFName.of('Subtype')) === PDFName.of('Image'),
    );
  expect(images).toHaveLength(1); // zweimal eingesetzt, einmal eingebettet
  const image = images[0];
  expect(image.dict.get(PDFName.of('Width')).asNumber()).toBe(record.width);
  expect(image.dict.get(PDFName.of('Height')).asNumber()).toBe(record.height);
  const smask = saved.context.lookup(image.dict.get(PDFName.of('SMask')));
  expect(smask).toBeInstanceOf(PDFRawStream);
  expect(smask.dict.get(PDFName.of('ColorSpace'))).toBe(PDFName.of('DeviceGray'));
  // Seite 1 unverändert ohne Bild
  const xobjects1 = saved.getPage(0).node.Resources().lookup(PDFName.of('XObject'));
  expect(xobjects1 ? xobjects1.entries().length : 0).toBe(0);

  // --- 5. Gespeichertes PDF mit pdf.js rendern (über die App) und Pixel prüfen
  const probe = await page.evaluate(
    async ({ b64, vis }) => {
      const app = window.pdfEditor;
      // Stellen im gespeicherten PNG suchen: völlig transparent (weit weg von Tinte) und volle Tinte
      const items = await new Promise((resolve) => {
        const req = indexedDB.open('pdf-editor');
        req.onsuccess = () => {
          const all = req.result.transaction('signatures').objectStore('signatures').getAll();
          all.onsuccess = () => resolve(all.result);
        };
      });
      const bitmap = await createImageBitmap(new Blob([items[0].png], { type: 'image/png' }));
      const c = document.createElement('canvas');
      c.width = bitmap.width;
      c.height = bitmap.height;
      const ctx = c.getContext('2d');
      ctx.drawImage(bitmap, 0, 0);
      const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);
      // Summentabellen: Anzahl Pixel mit Alpha > 0 bzw. Alpha = 255 im Rechteck
      const table = (pred) => {
        const t = new Uint32Array((width + 1) * (height + 1));
        for (let y = 0; y < height; y++)
          for (let x = 0; x < width; x++)
            t[(y + 1) * (width + 1) + x + 1] =
              (pred(data[(y * width + x) * 4 + 3]) ? 1 : 0) +
              t[y * (width + 1) + x + 1] +
              t[(y + 1) * (width + 1) + x] -
              t[y * (width + 1) + x];
        return (x, y, r) =>
          t[(y + r + 1) * (width + 1) + x + r + 1] -
          t[(y - r) * (width + 1) + x + r + 1] -
          t[(y + r + 1) * (width + 1) + x - r] +
          t[(y - r) * (width + 1) + x - r];
      };
      const visible = table((a) => a > 0);
      const full = table((a) => a === 255);
      const r = Math.round(width / 25);
      const rInk = 2;
      let clear = null;
      let ink = null;
      for (let y = r; y < height - r; y += 2)
        for (let x = r; x < width - r; x += 2) {
          if (!clear && x > width * 0.3 && visible(x, y, r) === 0) clear = [x, y];
          if (!ink && full(x, y, rInk) === (2 * rInk + 1) ** 2) ink = [x, y];
        }
      // PNG-Pixel → PDF-Punkt auf Seite 2
      const toPdf = ([px, py]) => [
        vis[0] + ((px + 0.5) / width) * (vis[2] - vis[0]),
        vis[3] - ((py + 0.5) / height) * (vis[3] - vis[1]),
      ];
      // gespeichertes PDF öffnen (pdf.js rendert es) und groß darstellen
      const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
      app.markSaved(); // keine Rückfrage „Änderungen verwerfen?“
      await app.openBytes(bytes, 'gespeichert.pdf', null);
      // nach der Seitenbreiten-Anpassung des Öffnens (requestAnimationFrame) auf 300 % zoomen
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      app.setZoom(3);
      return { clear: clear && toPdf(clear), ink: ink && toPdf(ink) };
    },
    { b64: bytes.toString('base64'), vis: placed.vis },
  );
  expect(probe.clear).not.toBeNull();
  expect(probe.ink).not.toBeNull();
  const pixelAt = async ([x, y]) => {
    await page.evaluate(
      ([x, y]) => {
        const pv = window.pdfEditor.pvs[1];
        const [cx, cy] = pv.pdfToLayer(x, y);
        document.getElementById('scroller').scrollTop += pv.layerToClient(cx, cy)[1] - 400;
      },
      [x, y],
    );
    await idle(page);
    return page.evaluate(
      ([x, y]) => {
        const pv = window.pdfEditor.pvs[1];
        const [lx, ly] = pv.pdfToLayer(x, y);
        const f = pv.canvas.width / pv.W;
        const d = pv.canvas.getContext('2d').getImageData(Math.floor(lx * f), Math.floor(ly * f), 1, 1).data;
        return [d[0], d[1], d[2]];
      },
      [x, y],
    );
  };
  const background = await pixelAt([500, 100]); // Seite 2 ohne Unterschrift: hellgelb
  expect(background[0]).toBeGreaterThan(240);
  expect(background[2]).toBeLessThan(180);
  const clearPx = await pixelAt(probe.clear);
  for (let k = 0; k < 3; k++) expect(Math.abs(clearPx[k] - background[k])).toBeLessThanOrEqual(3);
  const inkPx = await pixelAt(probe.ink);
  await page
    .locator('.page')
    .nth(1)
    .screenshot({ path: testInfo.outputPath('seite2.png') });
  expect(inkPx[0]).toBeLessThan(90);
  expect(inkPx[2]).toBeGreaterThan(inkPx[0]); // dunkelblau
  expect(errors).toEqual([]);
  await context.close();
});

test('Datenbank-Migration von Version 1 auf 2 behält Schriften und zuletzt geöffnete Dateien', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  const page = await context.newPage();
  // gleiche Herkunft (file://) wie die App: Datenbank in Version 1 anlegen wie der PDF-Editor 1.0
  const blank = testInfo.outputPath('leer.html');
  writeFileSync(blank, '<!doctype html><title>leer</title>');
  await page.goto(pathToFileURL(blank).href);
  await page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const req = indexedDB.open('pdf-editor', 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('fonts');
          req.result.createObjectStore('recent');
        };
        req.onsuccess = () => {
          const tx = req.result.transaction(['fonts', 'recent'], 'readwrite');
          tx.objectStore('fonts').put(new Uint8Array([1, 2, 3]).buffer, 'TestSchrift-Regular');
          tx.objectStore('recent').put({ name: 'alt.pdf', time: 1 }, 'alt.pdf');
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      }),
  );
  await page.goto(pathToFileURL(BUILDS.neubau).href);
  await page.waitForFunction(() => window.pdfEditor && window.pdfEditor.library.items.size >= 10);
  expect(await openPdf(page, await targetPdf(), 'angebot.pdf')).toBe(true);
  await enterEditMode(page);
  await page.locator('#cAddSig').click();
  await expect(page.locator('.sig-pop .sig-empty')).toBeVisible(); // liest den neuen Store
  const state = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('pdf-editor');
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction(['fonts', 'recent'], 'readonly');
          const font = tx.objectStore('fonts').get('TestSchrift-Regular');
          const recent = tx.objectStore('recent').get('alt.pdf');
          tx.oncomplete = () =>
            resolve({
              version: db.version,
              stores: [...db.objectStoreNames].sort(),
              font: font.result && font.result.byteLength,
              recent: recent.result && recent.result.name,
            });
        };
      }),
  );
  expect(state).toEqual({
    version: 2,
    stores: ['fonts', 'recent', 'signatures'],
    font: 3,
    recent: 'alt.pdf',
  });
  await context.close();
});

test('Unterschrift zeichnen, sichern und einsetzen', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  expect(await openPdf(page, await targetPdf(), 'angebot.pdf')).toBe(true);
  await enterEditMode(page);
  await page.locator('#cAddSig').click();
  await page.getByRole('button', { name: 'Zeichnen …' }).click();
  const sheet = page.locator('.dlg.sig-sheet');
  await expect(sheet).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Sichern' })).toBeDisabled();
  await sheet.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const box = await sheet.locator('.sig-pad canvas').boundingBox();
  const stroke = async (points) => {
    await page.mouse.move(box.x + points[0][0], box.y + points[0][1]);
    await page.mouse.down();
    for (const [x, y] of points.slice(1)) await page.mouse.move(box.x + x, box.y + y, { steps: 3 });
    await page.mouse.up();
  };
  await stroke([
    [60, 150],
    [90, 60],
    [120, 150],
    [160, 80],
    [200, 140],
    [260, 100],
  ]);
  await stroke([
    [300, 120],
    [320, 90],
  ]);
  await sheet.getByRole('button', { name: 'Rückgängig' }).click(); // zweiten Strich entfernen
  // Esc mit begonnener Zeichnung fragt nach; „Weiter zeichnen“ behält sie
  await page.keyboard.press('Escape');
  const confirm = page.locator('.dlg:not(.sig-sheet)');
  await expect(confirm).toContainText('Zeichnung verwerfen?');
  await confirm.getByRole('button', { name: 'Weiter zeichnen' }).click();
  await expect(confirm).toHaveCount(0);
  await expect(sheet).toBeVisible();
  await sheet.locator('#sigName').fill('Kürzel');
  await sheet.getByRole('radio', { name: 'Initialen' }).click();
  await sheet.getByRole('button', { name: 'Sichern' }).click();
  await expect(sheet).toBeHidden();
  const stored = await readSignatures(page);
  expect(stored.items).toHaveLength(1);
  expect(stored.items[0]).toMatchObject({
    name: 'Kürzel',
    kind: 'initials',
    source: 'drawn',
    isDefault: true,
  });
  // Initialen: PNG auf 300 dpi × 1,6 × 20 mm = 378 px begrenzt; nur der erste Strich
  // (≈ 200 × 90 CSS-px plus Rand) – das Seitenverhältnis zeigt, dass der zweite fehlt
  expect(stored.items[0].width).toBe(378);
  expect(stored.items[0].aspect).toBeGreaterThan(1.8);
  expect(stored.items[0].aspect).toBeLessThan(2.4);
  // nach dem Sichern direkt im Platzier-Modus
  await expect(page.locator('.sig-hint')).toContainText('Kürzel');
  const [tx, ty] = await clientOf(page, 0, 200, 400);
  await page.mouse.move(tx, ty);
  await page.mouse.click(tx, ty);
  await settled(page);
  const vis = await page.evaluate(() => window.pdfEditor.edit.sel.objs[0].vis);
  expect((((vis[2] - vis[0]) / 72) * 25.4).toFixed(0)).toBe('20'); // Initialen: 20 mm
  // Taste U setzt die Standard-Unterschrift
  await page.keyboard.press('Escape');
  await page.keyboard.press('u');
  await expect(page.locator('.sig-hint')).toContainText('Kürzel');
  await page.keyboard.press('Escape');
  await expect(page.locator('.sig-hint')).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

/** Dokument mit Seiten /Rotate 0, 90, 180, 270; auf 90/270 eine Unterschrift, die aufrecht angezeigt wird. */
async function rotatedPdf() {
  const doc = await PDFDocument.create();
  for (const rot of [0, 90, 180, 270]) {
    const page = doc.addPage([595.28, 841.89]);
    page.setRotation(degrees(rot));
    if (rot === 90 || rot === 270)
      // in PDF-Koordinaten um `rot` gegen den Uhrzeigersinn gedreht → in der Anzeige aufrecht
      page.drawSvgPath(SIGNATURE_SVG, {
        x: 297.64,
        y: 420.95,
        scale: 1.2,
        rotate: degrees(rot),
        borderColor: rgb(0.1, 0.16, 0.5),
        borderWidth: 1.6,
      });
  }
  return Buffer.from(await doc.save());
}

/** Legt eine Unterschrift direkt in IndexedDB an (PNG im Browser erzeugt). */
async function seedSignature(page, draw, { name = 'Test', width = 400, height = 100 } = {}) {
  await page.evaluate(
    async ({ draw, name, width, height }) => {
      const c = document.createElement('canvas');
      c.width = width;
      c.height = height;
      new Function('ctx', draw)(c.getContext('2d'));
      const png = await (await new Promise((r) => c.toBlob(r, 'image/png'))).arrayBuffer();
      await new Promise((resolve, reject) => {
        const req = indexedDB.open('pdf-editor', 2);
        req.onsuccess = () => {
          const tx = req.result.transaction('signatures', 'readwrite');
          // bisherige Standard-Markierungen entfernen – die Testunterschrift wird Standard
          const cursor = tx.objectStore('signatures').openCursor();
          cursor.onsuccess = () => {
            const c = cursor.result;
            if (!c || c.key === 'sig-test') return;
            c.update({ ...c.value, isDefault: false });
            c.continue();
          };
          tx.objectStore('signatures').put(
            {
              id: 'sig-test',
              name,
              kind: 'signature',
              source: 'drawn',
              created: Date.now(),
              png,
              width,
              height,
              aspect: width / height,
              widthMm: 50,
              heightMm: (50 * height) / width,
              isDefault: true,
            },
            'sig-test',
          );
          tx.oncomplete = () => {
            req.result.close();
            resolve();
          };
          tx.onerror = () => reject(tx.error);
        };
        req.onerror = () => reject(req.error);
      });
    },
    { draw, name, width, height },
  );
}

/** Farbe der Seitendarstellung (Vorschau-Canvas) an einer Bildschirmposition. */
function displayPixel(page, index, cx, cy) {
  return page.evaluate(
    ([index, cx, cy]) => {
      const pv = window.pdfEditor.pvs[index];
      const r = pv.el.getBoundingClientRect();
      const x = Math.floor(((cx - r.left) / r.width) * pv.canvas.width);
      const y = Math.floor(((cy - r.top) / r.height) * pv.canvas.height);
      const d = pv.canvas.getContext('2d').getImageData(x, y, 1, 1).data;
      return [d[0], d[1], d[2]];
    },
    [index, cx, cy],
  );
}

test('Gedrehte Seiten: Erfassen liefert aufrechte Unterschrift, Einsetzen steht aufrecht (90°, 180°, 270°)', async ({
  browser,
}) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  expect(await openPdf(page, await rotatedPdf(), 'gedreht.pdf')).toBe(true);
  await enterEditMode(page);

  // --- Erfassen auf /Rotate 90 und 270: gespeichertes Bild ist breit (aufrecht), nicht hochkant
  for (const index of [1, 3]) {
    await page.locator('#cAddSig').click();
    await page.getByRole('button', { name: 'Aus Dokument übernehmen' }).click();
    const [ax, ay] = await clientOf(page, index, 297.64 - 110, 420.95 + 110);
    const [bx, by] = await clientOf(page, index, 297.64 + 110, 420.95 - 110);
    await page.mouse.move(ax, ay);
    await page.mouse.down();
    await page.mouse.move(bx, by, { steps: 6 });
    await page.mouse.up();
    const sheet = page.locator('.dlg.sig-sheet');
    await expect(sheet).toBeVisible();
    await sheet.locator('#sigName').fill('Seite ' + (index + 1));
    await sheet.getByRole('button', { name: 'Sichern' }).click();
    await expect(sheet).toBeHidden();
  }
  const stored = await readSignatures(page);
  expect(stored.items).toHaveLength(2);
  for (const record of stored.items) expect(record.aspect).toBeGreaterThan(2);

  // --- Einsetzen: Testbild links rot, rechts blau, oben links grüne Marke
  await seedSignature(
    page,
    `ctx.fillStyle = '#d00000'; ctx.fillRect(0, 0, 200, 100);
     ctx.fillStyle = '#0000d0'; ctx.fillRect(200, 0, 200, 100);
     ctx.fillStyle = '#00b000'; ctx.fillRect(0, 0, 80, 40);`,
    { name: 'Orientierung' },
  );
  for (const index of [0, 1, 2, 3]) {
    const [cx, cy] = await clientOf(page, index, 297.64, 300);
    await page.keyboard.press('u');
    await expect(page.locator('.sig-hint')).toContainText('Orientierung');
    await page.mouse.move(cx, cy);
    await expect(page.locator('.sig-ghost')).toBeVisible();
    await page.mouse.click(cx, cy);
    await settled(page);
    await idle(page);
    const box = await page.evaluate(
      ([index]) => {
        const app = window.pdfEditor;
        const sel = app.edit.sel;
        const pv = app.pvs[index];
        const [x0, y0, x1, y1] = sel.objs[0].vis;
        const pts = [
          [x0, y0],
          [x1, y1],
        ].map(([x, y]) => pv.layerToClient(...pv.pdfToLayer(x, y)));
        return {
          left: Math.min(pts[0][0], pts[1][0]),
          right: Math.max(pts[0][0], pts[1][0]),
          top: Math.min(pts[0][1], pts[1][1]),
          bottom: Math.max(pts[0][1], pts[1][1]),
          page: sel.pv.index,
        };
      },
      [index],
    );
    expect(box.page).toBe(index);
    const w = box.right - box.left;
    const h = box.bottom - box.top;
    // in der Anzeige 50 mm breit und 4:1 – auf jeder Seitendrehung
    expect(w / h).toBeCloseTo(4, 0);
    const at = (fx, fy) => displayPixel(page, index, box.left + w * fx, box.top + h * fy);
    const green = await at(0.08, 0.15);
    const red = await at(0.35, 0.75);
    const blue = await at(0.8, 0.5);
    expect(green[1], `Seite ${index + 1}: grün oben links`).toBeGreaterThan(120);
    expect(green[0]).toBeLessThan(80);
    expect(red[0], `Seite ${index + 1}: rot links`).toBeGreaterThan(150);
    expect(red[2]).toBeLessThan(80);
    expect(blue[2], `Seite ${index + 1}: blau rechts`).toBeGreaterThan(150);
    expect(blue[0]).toBeLessThan(80);
    await page.keyboard.press('Escape');
  }
  expect(errors).toEqual([]);
  await context.close();
});

test('Zuschnittrahmen schließt gedruckten Text neben der Unterschrift aus', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  expect(await openPdf(page, await contractPdf(), 'vertrag.pdf')).toBe(true);
  await enterEditMode(page);
  await page.locator('#cAddSig').click();
  await page.getByRole('button', { name: 'Aus Dokument übernehmen' }).click();
  // Bereich inklusive der Beschriftung „Ort, Datum, Unterschrift“ (y ≈ 172)
  const [ax, ay] = await clientOf(page, 0, 70, 262);
  const [bx, by] = await clientOf(page, 0, 300, 166);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx, by, { steps: 6 });
  await page.mouse.up();
  const sheet = page.locator('.dlg.sig-sheet');
  await expect(sheet).toBeVisible();
  // Einblend-Animation des Sheets abwarten, bevor Positionen gemessen werden
  await sheet.evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  const frame = sheet.locator('.sig-crop');
  const before = await frame.evaluate((el) => parseFloat(el.style.top) + parseFloat(el.style.height));
  expect(before).toBeGreaterThan(90); // Rahmen reicht bis zur Beschriftung hinunter
  // unteren Griff hochziehen (bis knapp unter die Formularlinie y = 200)
  const stage = await sheet.locator('.sig-stage').boundingBox();
  const handle = await sheet.locator('.sig-crop i[data-h="s"]').boundingBox();
  const targetY = stage.y + stage.height * ((262 - 196) / (262 - 166));
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2, targetY, { steps: 5 });
  await page.mouse.up();
  await expect(sheet.getByRole('button', { name: 'Rahmen zurücksetzen' })).toBeVisible();
  await sheet.locator('#sigName').fill('Ohne Text');
  await sheet.getByRole('button', { name: 'Sichern' }).click();
  await expect(sheet).toBeHidden();
  const [record] = (await readSignatures(page)).items;
  // nur die Unterschrift (y ≈ 198…246 → ca. 17 mm + Rand), nicht bis zur Beschriftung (≈ 30 mm)
  expect(record.heightMm).toBeLessThan(22);
  expect(record.heightMm).toBeGreaterThan(12);
  expect(errors).toEqual([]);
  await context.close();
});

test('Datenbank blockiert durch altes Fenster: Popover bleibt bedienbar, Hinweis, danach normal', async ({
  browser,
}, testInfo) => {
  const context = await browser.newContext();
  const blocker = await context.newPage();
  const blank = testInfo.outputPath('alt.html');
  writeFileSync(blank, '<!doctype html><title>alt</title>');
  await blocker.goto(pathToFileURL(blank).href);
  // wie PDF-Editor 1.0: Version 1 offen halten, ohne auf versionchange zu reagieren
  await blocker.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('pdf-editor', 1);
        req.onupgradeneeded = () => {
          req.result.createObjectStore('fonts');
          req.result.createObjectStore('recent');
        };
        req.onsuccess = () => {
          window.__db = req.result;
          resolve();
        };
      }),
  );
  const page = await context.newPage();
  await page.goto(pathToFileURL(BUILDS.neubau).href);
  await page.waitForFunction(() => window.pdfEditor);
  expect(await openPdf(page, await targetPdf(), 'angebot.pdf')).toBe(true);
  await enterEditMode(page);
  await page.locator('#cAddSig').click();
  const pop = page.locator('.sig-pop');
  // Erfassen-Knöpfe sofort da, Liste mit verständlichem Hinweis
  await expect(pop.getByRole('button', { name: 'Zeichnen …' })).toBeVisible();
  await expect(pop.locator('.sig-empty.err')).toContainText('anderen Fenster', { timeout: 15_000 });
  // altes Fenster schließt die Datenbank → erneut versuchen → leere Liste
  await blocker.evaluate(() => window.__db.close());
  await pop.getByRole('button', { name: 'Erneut versuchen' }).click();
  await expect(pop.locator('.sig-empty')).toContainText('Noch keine Unterschrift');
  await context.close();
});

test('Alle Werkzeuge und Startseite öffnen das Unterschrift-Popover', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  await page.locator('#hSig').click();
  await expect(page.locator('.sig-pop')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.sig-pop')).toHaveCount(0);
  expect(await openPdf(page, await targetPdf(), 'angebot.pdf')).toBe(true);
  await page.locator('#lpBody .tool[data-tool="signature"]').click();
  await expect(page.locator('.sig-pop')).toBeVisible();
  expect(await page.evaluate(() => window.pdfEditor.tool)).toBe('edit');
  // Klick auf „Unterschrift“ während des Erfassens beendet es
  await page.getByRole('button', { name: 'Aus Dokument übernehmen' }).click();
  await expect(page.locator('.sig-hint')).toBeVisible();
  await page.locator('#cAddSig').click();
  await expect(page.locator('.sig-hint')).toHaveCount(0);
  expect(await page.evaluate(() => document.getElementById('pages').classList.contains('sig-capture'))).toBe(
    false,
  );
  // Die Hinweisleiste blockiert das Aufziehen nicht: Rahmen beginnt direkt auf ihrem Text
  await page.locator('#cAddSig').click();
  await page.getByRole('button', { name: 'Aus Dokument übernehmen' }).click();
  const hint = await page.locator('.sig-hint span').boundingBox();
  const sx = hint.x + 10;
  const sy = hint.y + hint.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 200, sy + 120, { steps: 5 });
  await page.mouse.up();
  await expect(page.locator('.dlg.sig-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dlg.sig-sheet')).toHaveCount(0);
  expect(errors).toEqual([]);
  await context.close();
});

for (const zoom of [8, 32]) {
  test(`Leertaste/Mittelklick = Hand beim Erfassen und Platzieren (${zoom * 100} %)`, async ({ browser }) => {
    const { page, context, errors } = await launch(browser, 'neubau');
    expect(await openPdf(page, await contractPdf(), 'vertrag.pdf')).toBe(true);
    await enterEditMode(page);
    await seedSignature(page, `ctx.fillStyle = '#123'; ctx.fillRect(0, 40, 400, 20);`, { name: 'Balken' });
    await page.evaluate((z) => window.pdfEditor.setZoom(z), zoom);
    await idle(page);
    const scroll = () =>
      page.evaluate(() => {
        const s = document.getElementById('scroller');
        return [s.scrollLeft, s.scrollTop];
      });
    // Mitte der ersten Seite im sichtbaren Bereich
    await page.evaluate(() => {
      const pv = window.pdfEditor.pvs[0];
      const sc = document.getElementById('scroller');
      const [cx, cy] = pv.layerToClient(...pv.pdfToLayer(200, 220));
      const r = sc.getBoundingClientRect();
      sc.scrollLeft += cx - (r.left + r.width / 2);
      sc.scrollTop += cy - (r.top + r.height / 2);
    });
    await idle(page);
    const drag = async (button) => {
      await page.mouse.move(700, 500);
      await page.mouse.down({ button });
      await page.mouse.move(560, 420, { steps: 6 });
      await page.mouse.up({ button });
    };
    for (const mode of ['capture', 'place']) {
      if (mode === 'capture') {
        await page.locator('#cAddSig').click();
        await page.getByRole('button', { name: 'Aus Dokument übernehmen' }).click();
        await expect(page.locator('.sig-hint')).toContainText('Rahmen');
      } else await page.keyboard.press('u');
      const undo0 = await page.evaluate(() => window.pdfEditor.session.hist.undo.length);
      for (const how of ['space', 'middle']) {
        const before = await scroll();
        if (how === 'space') await page.keyboard.down('Space');
        await drag(how === 'space' ? 'left' : 'middle');
        if (how === 'space') await page.keyboard.up('Space');
        await expect.poll(async () => (await scroll()).join() !== before.join()).toBe(true);
        // weder Sheet noch Einsetzen, der Modus bleibt aktiv
        await expect(page.locator('.dlg.sig-sheet')).toHaveCount(0);
        await expect(page.locator('.sig-hint')).toBeVisible();
        expect(await page.evaluate(() => window.pdfEditor.session.hist.undo.length)).toBe(undo0);
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('.sig-hint')).toHaveCount(0);
    }
    // ohne Leertaste funktionieren beide Modi weiterhin
    await page.keyboard.press('u');
    await page.mouse.move(700, 500);
    await page.mouse.click(700, 500);
    await expect
      .poll(() => page.evaluate(() => window.pdfEditor.session.hist.undo.map((e) => e.label).pop()))
      .toBe('Unterschrift eingefügt');
    await settled(page);
    expect(errors).toEqual([]);
    await context.close();
  });
}

test('Verwalten: Fokus kehrt zur Schaltfläche zurück; Vorschau reagiert schnell', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  expect(await openPdf(page, await contractPdf(), 'vertrag.pdf')).toBe(true);
  await enterEditMode(page);
  await seedSignature(page, `ctx.fillRect(0, 40, 400, 20);`, { name: 'Balken' });
  await page.locator('#cAddSig').click();
  await page.getByRole('button', { name: 'Unterschriften verwalten …' }).click();
  await expect(page.locator('.dlg.sig-sheet')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.dlg.sig-sheet')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('cAddSig');
  // Vorschau eines 600-dpi-Bereichs (großer Rahmen): Reglerbewegung < 200 ms bis das Ergebnis steht
  await page.locator('#cAddSig').click();
  await page.getByRole('button', { name: 'Aus Dokument übernehmen' }).click();
  const [ax, ay] = await clientOf(page, 0, 40, 330);
  const [bx, by] = await clientOf(page, 0, 380, 150);
  await page.mouse.move(ax, ay);
  await page.mouse.down();
  await page.mouse.move(bx, by, { steps: 5 });
  await page.mouse.up();
  const sheet = page.locator('.dlg.sig-sheet');
  await expect(sheet.locator('.sig-crop')).toBeVisible();
  const ms = await sheet.evaluate(async (el) => {
    const range = el.querySelector('#sigSens');
    const canvas = el.querySelector('canvas');
    const times = [];
    for (const v of [20, 80, 35]) {
      const t0 = performance.now();
      range.value = v;
      range.dispatchEvent(new Event('input', { bubbles: true }));
      // Vorschau gilt als fertig, wenn der Canvas neu beschrieben wurde (Inhalt ändert sich)
      const before = canvas.toDataURL();
      while (canvas.toDataURL() === before && performance.now() - t0 < 3000)
        await new Promise((r) => setTimeout(r, 5));
      times.push(Math.round(performance.now() - t0));
    }
    return times;
  });
  console.log('Vorschau-Zeiten (ms):', ms.join(', '));
  expect(Math.min(...ms)).toBeLessThan(200);
  expect(errors).toEqual([]);
  await context.close();
});

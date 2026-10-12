/**
 * Werkzeug „Formularfelder“: Felder anlegen (Klick und Aufziehen), verschieben, Größe ändern,
 * Eigenschaften ändern, löschen, Rückgängig. Nur gegen den Neubau.
 */
import { test, expect } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { launch, openPdf, idle, savedBytes } from './helpers.js';

async function blankPdf(withField = false) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  page.drawText('Formular', { x: 50, y: 790, size: 16, font: await doc.embedFont(StandardFonts.Helvetica) });
  if (withField) {
    const f = doc.getForm().createTextField('vorhanden');
    f.setText('Wert');
    f.addToPage(page, { x: 100, y: 600, width: 200, height: 24 });
  }
  return doc.save();
}

const fields = async (bytes) => {
  const form = (await PDFDocument.load(bytes)).getForm();
  return Object.fromEntries(
    form.getFields().map((f) => {
      const r = f.acroField.getWidgets()[0].getRectangle();
      return [
        f.getName(),
        { type: f.constructor.name, rect: [r.x, r.y, r.width, r.height].map(Math.round), field: f },
      ];
    }),
  );
};

async function pagePoint(page, x, y) {
  // PDF-Punkt → Bildschirm (Seite 1)
  return page.evaluate(
    ([x, y]) => {
      const pv = window.pdfEditor.pvs[0];
      const [lx, ly] = pv.pdfToLayer(x, y);
      return pv.layerToClient(lx, ly);
    },
    [x, y],
  );
}

test('Textfeld und Kontrollkästchen anlegen, ausfüllen und speichern', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await openPdf(page, await blankPdf(), 'leer.pdf');
    await page.evaluate(() => window.pdfEditor.setTool('formdesign'));
    await idle(page);
    // Textfeld per Klick (Standardgröße 160 × 22 pt ab dem Klickpunkt)
    await page.click('#fdText');
    const [cx, cy] = await pagePoint(page, 100, 700);
    await page.mouse.click(cx, cy);
    await idle(page);
    // Kontrollkästchen per Aufziehen
    await page.click('#fdCheck');
    const [ax, ay] = await pagePoint(page, 300, 700);
    const [bx, by] = await pagePoint(page, 320, 680);
    await page.mouse.move(ax, ay);
    await page.mouse.down();
    await page.mouse.move(bx, by, { steps: 4 });
    await page.mouse.up();
    await idle(page);
    await expect(page.locator('.fdb')).toHaveCount(2);
    let saved = await fields(await savedBytes(page));
    expect(saved['Textfeld 1'].type).toBe('PDFTextField');
    expect(saved['Textfeld 1'].rect).toEqual([100, 678, 160, 22]);
    expect(saved['Kontrollkästchen 1'].type).toBe('PDFCheckBox');
    expect(saved['Kontrollkästchen 1'].rect).toEqual([300, 680, 20, 20]);

    // außerhalb des Werkzeugs ausfüllen
    await page.evaluate(() => window.pdfEditor.setTool(null));
    await idle(page);
    await page.locator('.ff[data-name="Textfeld 1"]').fill('Hallo');
    await page.locator('.ff[data-name="Textfeld 1"]').press('Enter');
    await idle(page);
    await page.locator('.ff[data-name="Kontrollkästchen 1"]').click();
    await idle(page);
    saved = await fields(await savedBytes(page));
    expect(saved['Textfeld 1'].field.getText()).toBe('Hallo');
    expect(saved['Kontrollkästchen 1'].field.isChecked()).toBe(true);

    // Rückgängig entfernt zuletzt angelegte Felder wieder
    for (let k = 0; k < 4; k++) await page.evaluate(() => window.pdfEditor.undo());
    await idle(page);
    expect(Object.keys(await fields(await savedBytes(page)))).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Vorhandenes Feld verschieben, Größe ändern, Eigenschaften ändern und löschen', async ({ browser }) => {
  const { page, context } = await launch(browser, 'neubau');
  try {
    await openPdf(page, await blankPdf(true), 'feld.pdf');
    await page.evaluate(() => window.pdfEditor.setTool('formdesign'));
    await idle(page);
    const box = page.locator('.fdb');
    await expect(box).toHaveCount(1);
    const [x0, y0, w0, h0] = (await fields(await savedBytes(page))).vorhanden.rect;
    // verschieben um 50 pt nach rechts
    const [sx, sy] = await pagePoint(page, 150, 612);
    const [tx, ty] = await pagePoint(page, 200, 612);
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(tx, ty, { steps: 5 });
    await page.mouse.up();
    await idle(page);
    expect((await fields(await savedBytes(page))).vorhanden.rect).toEqual([x0 + 50, y0, w0, h0]);
    // reines Verschieben behält das Erscheinungsbild (keine neue Appearance)
    expect(
      await page.evaluate(() => window.pdfEditor.session.hist.undo[0].changes.map((c) => c.key.decodeText())),
    ).toEqual(['Rect']);
    // Größe: rechter unterer Griff 40 pt nach rechts
    const handle = await page.locator('.fdb.on .fdh[data-h="se"]').boundingBox();
    const [hx] = await pagePoint(page, x0 + 50 + w0 + 40, y0);
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(hx, handle.y + handle.height / 2, { steps: 5 });
    await page.mouse.up();
    await idle(page);
    const resized = (await fields(await savedBytes(page))).vorhanden.rect;
    expect(resized[0]).toBe(x0 + 50);
    expect(Math.abs(resized[2] - (w0 + 40))).toBeLessThanOrEqual(1.5); // Griffmitte ≈ Ecke
    expect(resized[3]).toBe(h0);
    // bereits aktive Ausrichtung erneut wählen: kein zusätzlicher Schritt
    const steps = await page.evaluate(() => window.pdfEditor.session.hist.undo.length);
    await page.locator('#lpBody .seg button.on').click();
    await idle(page);
    expect(await page.evaluate(() => window.pdfEditor.session.hist.undo.length)).toBe(steps);
    // Eigenschaften
    const name = page.locator('#lpBody input.fld');
    await name.fill('Kunde');
    await name.press('Enter');
    await idle(page);
    await page.locator('#lpBody label', { hasText: 'Schreibgeschützt' }).click();
    await idle(page);
    await page.locator('#lpBody label', { hasText: 'Mehrzeilig' }).click();
    await idle(page);
    let saved = await fields(await savedBytes(page));
    expect(saved.Kunde.field.isReadOnly()).toBe(true);
    expect(saved.Kunde.field.isMultiline()).toBe(true);
    expect(saved.Kunde.field.getText()).toBe('Wert');
    // Pfeiltaste verschiebt um 1 pt, Entf löscht (Fokus zurück auf die Seite: Feld anklicken)
    await page.locator('.fdb.on').click();
    await page.keyboard.press('ArrowUp');
    await idle(page);
    expect((await fields(await savedBytes(page))).Kunde.rect[1]).toBe(y0 + 1);
    await page.keyboard.press('Delete');
    await idle(page);
    await expect(page.locator('.fdb')).toHaveCount(0);
    expect(Object.keys(await fields(await savedBytes(page)))).toEqual([]);
    await page.evaluate(() => window.pdfEditor.undo());
    await idle(page);
    await expect(page.locator('.fdb')).toHaveCount(1);
  } finally {
    await context.close();
  }
});

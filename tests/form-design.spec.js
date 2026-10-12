/**
 * Werkzeug „Formularfelder“: Felder anlegen (Klick und Aufziehen), verschieben, Größe ändern,
 * Eigenschaften ändern, löschen, Rückgängig. Nur gegen den Neubau.
 */
import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
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
    const name = page.locator('#lpBody input[aria-label="Feldname"]');
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

test('Eigenschaften wie in Acrobat: Allgemein, Darstellung, Optionen', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await openPdf(page, await blankPdf(true), 'feld.pdf');
    await page.evaluate(() => window.pdfEditor.setTool('formdesign'));
    await idle(page);
    await page.locator('.fdb').click();
    await idle(page);
    const panel = page.locator('#lpBody');
    const pick = async (aria, value) => {
      await panel.locator(`select[aria-label="${aria}"]`).selectOption(value);
      await idle(page);
    };
    const type = async (aria, value) => {
      const input = panel.locator(`input[aria-label="${aria}"]`);
      await input.fill(value);
      await input.press('Enter');
      await idle(page);
    };
    const tick = async (label) => {
      await panel.locator('label.fd-check', { hasText: label }).click();
      await idle(page);
    };
    await type('QuickInfo', 'Name des Kunden');
    await pick('Sichtbarkeit', 'noPrint');
    await tick('Erforderlich');
    await panel.locator('input[aria-label="Rahmenfarbe verwenden"]').check();
    await idle(page);
    await pick('Linienstärke', '2');
    await pick('Linienart', 'D');
    await pick('Schriftart', 'TiBo');
    await pick('Schriftgröße', '14');
    await panel.locator('.seg button[data-q="1"]').click();
    await idle(page);
    await panel.locator('input[aria-label="Zeichenzahl begrenzen"]').check();
    await idle(page);
    await type('Höchstens Zeichen', '8');
    await tick('Kammfeld');
    await pick('Drehung', '90');

    const doc = await PDFDocument.load(await savedBytes(page));
    const field = doc.getForm().getTextField('vorhanden');
    const widget = field.acroField.getWidgets()[0];
    const dict = widget.dict;
    const ctx = doc.context;
    const get = (d, key) => ctx.lookup(d.get(PDFName.of(key)));
    expect(get(field.acroField.dict, 'TU').decodeText()).toBe('Name des Kunden');
    expect(widget.dict.get(PDFName.of('F')).asNumber() & 4).toBe(0); // nicht drucken
    expect(field.isRequired()).toBe(true);
    expect(get(dict, 'DA').decodeText()).toMatch(/^\/TiBo 14 Tf/);
    expect(get(dict, 'Q').asNumber()).toBe(1);
    expect(get(get(dict, 'BS'), 'W').asNumber()).toBe(2);
    expect(get(get(dict, 'BS'), 'S').decodeText()).toBe('D');
    expect(get(get(dict, 'MK'), 'R').asNumber()).toBe(90);
    expect(get(get(dict, 'MK'), 'BC')).toBeTruthy();
    expect(field.getMaxLength()).toBe(8);
    expect(field.isCombed()).toBe(true);
    // Erscheinungsbild: gedreht (/Matrix) mit der gewählten Schrift
    const ap = get(get(dict, 'AP'), 'N');
    expect(
      get(ap.dict, 'Matrix')
        .asArray()
        .map((n) => n.asNumber())
        .slice(0, 4),
    ).toEqual([0, 1, -1, 0]);
    expect(get(get(ap.dict, 'Resources'), 'Font').has(PDFName.of('TiBo'))).toBe(true);
    // Schrift für andere Programme unter /DR
    const dr = get(doc.catalog.lookup(PDFName.of('AcroForm')), 'DR');
    expect(get(dr, 'Font').has(PDFName.of('TiBo'))).toBe(true);

    // Kennwort-Feld: beim Ausfüllen verdeckte Eingabe
    await page.locator('label.fd-check', { hasText: 'Kammfeld' }).click();
    await idle(page);
    await page.locator('label.fd-check', { hasText: 'Kennwort' }).click();
    await idle(page);
    await page.evaluate(() => window.pdfEditor.setTool(null));
    await idle(page);
    await expect(page.locator('.ff[data-name="vorhanden"]')).toHaveAttribute('type', 'password');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Feld mit Widgets auf zwei Seiten: Feld-Eigenschaften zeichnen beide neu', async ({ browser }) => {
  const doc = await PDFDocument.create();
  const p1 = doc.addPage([595, 842]);
  const p2 = doc.addPage([595, 842]);
  const field = doc.getForm().createTextField('kennung');
  field.setText('abc');
  field.addToPage(p1, { x: 100, y: 700, width: 200, height: 24 });
  field.addToPage(p2, { x: 100, y: 700, width: 200, height: 24 });
  const { page, context } = await launch(browser, 'neubau');
  try {
    await openPdf(page, await doc.save(), 'zwei.pdf');
    await page.evaluate(async () => {
      const s = window.pdfEditor.session;
      const entry = s.formFields(0, { all: true })[0];
      await s.updateFormField(entry, { password: true });
    });
    const saved = await PDFDocument.load(await savedBytes(page));
    const widgets = saved.getForm().getTextField('kennung').acroField.getWidgets();
    expect(widgets).toHaveLength(2);
    for (const widget of widgets) {
      const ap = saved.context.lookup(widget.getAppearances().normal.ref ?? widget.getAppearances().normal);
      const text = Buffer.from(ap.getContents ? ap.getContents() : ap.contents).toString('latin1');
      // Kennwort: beide Erscheinungsbilder zeigen Sternchen statt „abc“
      expect(text).toContain('<2A2A2A>');
    }
    expect(await page.evaluate(() => [...window.pdfEditor.session.formRevs.values()].length)).toBe(2);
  } finally {
    await context.close();
  }
});

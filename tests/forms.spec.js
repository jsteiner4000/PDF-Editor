/**
 * Formularfelder ausfüllen: Text (ein-/mehrzeilig), Kontrollkästchen, Optionsfelder, Auswahlliste,
 * schreibgeschützte Felder und doppelt geschriebene Feldbäume (wie im PDF-Export von iOS).
 * Nur gegen den Neubau.
 */
import { test, expect } from '@playwright/test';
import { PDFArray, PDFBool, PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';
import { launch, openPdf, idle, savedBytes } from './helpers.js';

const N = (name) => PDFName.of(name);

async function formPdf({ readOnly = false, duplicateTree = false } = {}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText('Formular', { x: 50, y: 790, size: 16, font });
  const form = doc.getForm();
  const name = form.createTextField('kunde');
  name.setText('Alte Firma');
  name.addToPage(page, { x: 150, y: 700, width: 300, height: 22 });
  const notes = form.createTextField('bemerkung');
  notes.enableMultiline();
  notes.setText('Zeile eins');
  notes.addToPage(page, { x: 150, y: 560, width: 300, height: 100 });
  const check = form.createCheckBox('erledigt');
  check.addToPage(page, { x: 150, y: 500, width: 14, height: 14 });
  const radio = form.createRadioGroup('ergebnis');
  radio.addOptionToPage('gut', page, { x: 150, y: 460, width: 14, height: 14 });
  radio.addOptionToPage('schlecht', page, { x: 250, y: 460, width: 14, height: 14 });
  radio.select('gut');
  const choice = form.createDropdown('anlage');
  choice.addOptions(['Alarm', 'Video', 'Zutritt']);
  choice.select('Alarm');
  choice.addToPage(page, { x: 150, y: 400, width: 200, height: 22 });
  if (readOnly) name.enableReadOnly();
  form.updateFieldAppearances(font);
  if (duplicateTree) {
    // wie iOS: /AcroForm /Fields zeigt auf lose Kopien statt auf die Widgets der Seite
    const ctx = doc.context;
    const fields = ctx.lookup(form.acroForm.dict.get(N('Fields')));
    const copies = fields.asArray().map((ref) => ctx.register(ctx.lookup(ref).clone(ctx)));
    form.acroForm.dict.set(N('Fields'), ctx.obj(copies));
  }
  return doc.save({ updateFieldAppearances: false });
}

async function fieldValues(bytes) {
  const doc = await PDFDocument.load(bytes);
  const form = doc.getForm();
  return {
    kunde: form.getTextField('kunde').getText(),
    bemerkung: form.getTextField('bemerkung').getText(),
    erledigt: form.getCheckBox('erledigt').isChecked(),
    ergebnis: form.getRadioGroup('ergebnis').getSelected(),
    anlage: form.getDropdown('anlage').getSelected()[0],
  };
}

const field = (page, name) => page.locator(`.ff[data-name="${name}"]`);

test('Formularfelder ausfüllen, rückgängig machen und speichern', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await openPdf(page, await formPdf(), 'formular.pdf');
    await expect(page.locator('.ff')).toHaveCount(6);

    await field(page, 'kunde').fill('Bäckerei Lindner GmbH');
    await field(page, 'kunde').press('Enter');
    await idle(page);
    await field(page, 'bemerkung').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Enter');
    await page.keyboard.type('Zeile zwei – Akku getauscht');
    await field(page, 'erledigt').click(); // verlässt die Bemerkung (übernimmt sie) und hakt an
    await idle(page);
    await page.locator('.ff-radio').nth(1).click();
    await idle(page);
    await field(page, 'anlage').selectOption('Video');
    await idle(page);

    const undo = await page.evaluate(() => window.pdfEditor.session.hist.undo.map((e) => e.label));
    expect(undo).toEqual(Array(5).fill('Formularfeld ausgefüllt'));
    expect(await fieldValues(await savedBytes(page))).toEqual({
      kunde: 'Bäckerei Lindner GmbH',
      bemerkung: 'Zeile eins\nZeile zwei – Akku getauscht',
      erledigt: true,
      ergebnis: 'schlecht',
      anlage: 'Video',
    });
    await expect(field(page, 'erledigt')).toHaveAttribute('aria-checked', 'true');

    // Rückgängig: Auswahlliste und Optionsfeld wieder wie vorher
    await page.evaluate(() => window.pdfEditor.undo());
    await page.evaluate(() => window.pdfEditor.undo());
    await idle(page);
    const back = await fieldValues(await savedBytes(page));
    expect(back.anlage).toBe('Alarm');
    expect(back.ergebnis).toBe('gut');
    await expect(field(page, 'anlage')).toHaveValue('Alarm');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Speichern übernimmt ein gerade bearbeitetes Feld', async ({ browser }) => {
  const { page, context } = await launch(browser, 'neubau');
  try {
    await openPdf(page, await formPdf(), 'formular.pdf');
    await field(page, 'kunde').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type('Noch im Feld');
    // kein Verlassen des Felds: Speichern (und die Rückfrage beim Schließen) übernehmen den Wert
    expect(
      await page.evaluate(() => window.pdfEditor.finishEdit().then(() => window.pdfEditor.session.dirty)),
    ).toBe(true);
    expect((await fieldValues(await savedBytes(page))).kunde).toBe('Noch im Feld');
  } finally {
    await context.close();
  }
});

test('Esc verwirft die Eingabe, unveränderte Felder erzeugen keinen Schritt', async ({ browser }) => {
  const { page, context } = await launch(browser, 'neubau');
  try {
    await openPdf(page, await formPdf(), 'formular.pdf');
    await field(page, 'kunde').fill('Wird verworfen');
    await field(page, 'kunde').press('Escape');
    await field(page, 'bemerkung').click();
    await page.locator('#scroller').click({ position: { x: 5, y: 5 } });
    await idle(page);
    await expect(field(page, 'kunde')).toHaveValue('Alte Firma');
    expect(await page.evaluate(() => window.pdfEditor.session.hist.undo.length)).toBe(0);
  } finally {
    await context.close();
  }
});

test('Schreibgeschützte Felder: nur im Bearbeiten-Modus änderbar, Schutz bleibt in der Datei', async ({
  browser,
}) => {
  const { page, context } = await launch(browser, 'neubau');
  try {
    await openPdf(page, await formPdf({ readOnly: true }), 'formular.pdf');
    const kunde = field(page, 'kunde');
    await expect(kunde).toHaveClass(/locked/);
    await expect(kunde).toHaveJSProperty('readOnly', true);
    await page.evaluate(() => window.pdfEditor.setTool('edit'));
    await idle(page);
    await expect(kunde).not.toHaveClass(/locked/);
    await kunde.fill('Neu');
    await kunde.press('Enter');
    await idle(page);
    const doc = await PDFDocument.load(await savedBytes(page));
    const text = doc.getForm().getTextField('kunde');
    expect(text.getText()).toBe('Neu');
    expect(text.isReadOnly()).toBe(true);
  } finally {
    await context.close();
  }
});

test('Doppelter Feldbaum (iOS): gespeicherte Werte sind auch über /Fields lesbar', async ({ browser }) => {
  const { page, context } = await launch(browser, 'neubau');
  try {
    await openPdf(page, await formPdf({ duplicateTree: true }), 'formular.pdf');
    await field(page, 'kunde').fill('Über Fields lesbar');
    await field(page, 'kunde').press('Enter');
    await idle(page);
    const bytes = await savedBytes(page);
    expect((await fieldValues(bytes)).kunde).toBe('Über Fields lesbar');
    // /Fields zeigt jetzt auf die Felder der Seite (keine losen Kopien mehr)
    const doc = await PDFDocument.load(bytes);
    const ctx = doc.context;
    const fields = ctx.lookup(doc.catalog.lookup(N('AcroForm')).get(N('Fields')));
    const onPage = new Set();
    for (const ref of doc.getPage(0).node.lookup(N('Annots'), PDFArray).asArray())
      for (let node = ctx.lookup(ref); node; node = ctx.lookup(node.get(N('Parent')))) onPage.add(node);
    expect(fields.asArray().every((ref) => onPage.has(ctx.lookup(ref)))).toBe(true);
  } finally {
    await context.close();
  }
});

test('Gleiche Darstellung wie Acrobat: /NeedAppearances entfällt nur, wenn die Bilder passen', async ({
  browser,
}) => {
  const make = async (stale) => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([595, 842]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const field = doc.getForm().createTextField('kunde');
    field.setText(stale ? '' : 'Firma');
    field.addToPage(page, { x: 100, y: 700, width: 200, height: 22 });
    doc.getForm().updateFieldAppearances(font);
    // veraltet: Wert nachträglich gesetzt, Erscheinungsbild noch leer (Programm verlässt sich auf den Schalter)
    if (stale) field.acroField.dict.set(N('V'), PDFHexString.fromText('Firma'));
    doc.getForm().acroForm.dict.set(N('NeedAppearances'), PDFBool.True);
    return doc.save({ updateFieldAppearances: false });
  };
  const flagAfterSave = async (bytes) => {
    const { page, context } = await launch(browser, 'neubau');
    try {
      await openPdf(page, bytes, 'formular.pdf');
      const saved = await PDFDocument.load(await savedBytes(page));
      return String(saved.catalog.lookup(N('AcroForm')).get(N('NeedAppearances')));
    } finally {
      await context.close();
    }
  };
  expect(await flagAfterSave(await make(false))).toBe('false');
  expect(await flagAfterSave(await make(true))).toBe('true');
});

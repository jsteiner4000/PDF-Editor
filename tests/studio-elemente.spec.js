import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { launch } from './helpers.js';

/** Freie Bilder und QR-Codes auf jeder Seite; Dokumentation als PDF im PDF-Bereich öffnen. */

const overlays = (page) => page.evaluate(() => JSON.parse(JSON.stringify(window.pdfEditor.studio.project.overlays)));

async function newDoc(page, context) {
  await page.exposeFunction('__pdfixMakePdf', async (html) => {
    const printer = await context.newPage();
    try {
      await printer.setContent(html);
      const pdf = await printer.pdf({ preferCSSPageSize: true, printBackground: true });
      return Buffer.from(pdf).toString('base64');
    } finally {
      await printer.close();
    }
  });
  await page.locator('#wsDocs').click();
  await page.locator('.tpl[data-tpl="documentation"]').click();
  await page.locator('.dlg .btn.primary', { hasText: 'Erstellen' }).click();
  await expect(page.locator('#prjTab')).toHaveClass(/on/);
}

test('QR-Code aus Seriennummer und Bild frei auf der Seite: einfügen, verschieben, Größe, löschen', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await newDoc(page, context);
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const acc = st.project.sections.find((s) => s.type === 'access');
      st.change('Gerät', () =>
        acc.devices.push({ id: 'nvr1', name: { de: 'Rekorder', en: '' }, ip: '', web: '', user: '', password: '', role: '', note: { de: '', en: '' }, model: '', serial: 'DS-7608-ABC123', mac: '', firmware: '', location: { de: '', en: '' }, users: [], sym: null }),
      );
      st.select({ kind: 'section', id: st.project.sections.find((s) => s.type === 'site').id }, { reveal: true });
    });
    await page.locator('.rb[data-act="insert"]').click();
    await page.locator('.menu .mi', { hasText: 'QR-Code einfügen' }).click();
    let list = await overlays(page);
    expect(list.length).toBe(1);
    expect(list[0].src).toBe('nvr1');
    // landet im gewählten Abschnitt (Lageplan), nicht auf dem Deckblatt
    expect(list[0].section).toBe(await page.evaluate(() => window.pdfEditor.studio.project.sections.find((s) => s.type === 'site').id));
    await expect(page.locator('#studio .sd-page', { hasText: 'SN DS-7608-ABC123' }).first()).toBeVisible();
    await expect(page.locator('#sdIBody select').first()).toHaveValue('nvr1');

    // Seriennummer ändern: QR-Code folgt
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const acc = st.project.sections.find((s) => s.type === 'access');
      st.change('SN', () => (acc.devices.find((d) => d.id === 'nvr1').serial = 'XYZ-999'));
    });
    const pg = page.locator('#studio .sd-page', { hasText: 'SN XYZ-999' }).first();
    await expect(pg).toBeVisible();

    // Verschieben mit der Maus, Größe am Griff
    const o = list[0];
    await pg.scrollIntoViewIfNeeded();
    const box = await pg.boundingBox();
    const k = box.width / 595.276;
    const cx = box.x + (o.x + o.w / 2) * k;
    const cy = box.y + (o.y + o.w / 2) * k;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx - 60, cy + 40, { steps: 5 });
    await page.mouse.up();
    list = await overlays(page);
    expect(list[0].x).toBeLessThan(o.x - 30);
    expect(list[0].y).toBeGreaterThan(o.y + 20);
    await expect(page.locator('.sd-ogrip')).toHaveCount(1);
    const grip = await page.locator('.sd-ogrip').boundingBox();
    await page.mouse.move(grip.x + 6, grip.y + 6);
    await page.mouse.down();
    await page.mouse.move(grip.x + 46, grip.y + 46, { steps: 5 });
    await page.mouse.up();
    list = await overlays(page);
    expect(list[0].w).toBeGreaterThan(o.w + 20);
    expect(list[0].h).toBe(list[0].w + 13);
    // Pfeiltaste verschiebt, Rückgängig nimmt es zurück
    const before = list[0].x;
    await page.locator('#sdScroll').focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(async () => (await overlays(page))[0].x).toBe(before + 1);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await overlays(page))[0].x).toBe(before);

    // Bild einfügen
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.rb[data-act="insert"]').click();
    await page.locator('.menu .mi', { hasText: 'Bild einfügen' }).click();
    await (await chooser).setFiles({ name: 'logo.jpg', mimeType: 'image/jpeg', buffer: readFileSync('tests/fixtures/signature-felt-pen-f.jpg') });
    await expect.poll(async () => (await overlays(page)).length).toBe(2);
    list = await overlays(page);
    expect(list[1].kind).toBe('image');
    expect(Math.max(list[1].w, list[1].h)).toBeLessThanOrEqual(200);

    // Löschen mit Entf
    await page.locator('#sdScroll').focus();
    await page.keyboard.press('Delete');
    await expect.poll(async () => (await overlays(page)).length).toBe(1);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Dokumentation im PDF-Bereich öffnen', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await newDoc(page, context);
    const btn = page.locator('.rb[data-act="topdf"]');
    await expect(btn).toBeVisible();
    await btn.click();
    await expect(page.locator('#docTab')).toHaveClass(/on/);
    await expect.poll(() => page.evaluate(() => window.pdfEditor.session && window.pdfEditor.session.numPages)).toBeGreaterThan(1);
    // die Dokumentation bleibt offen: zurück zum Bereich „Dokumentation“
    await page.locator('#wsDocs').click();
    await expect(page.locator('#prjTab')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

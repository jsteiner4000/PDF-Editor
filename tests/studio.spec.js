/**
 * „Dokumentation erstellen“: Anschlussplan wie das Vorbild, Bedienung (Auswahl, Ziehen, Rückgängig,
 * Eigenschaften, Sprache), Entwürfe und die PDF mit eingebettetem Projekt. Nur gegen den Neubau.
 */
import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { launch, extractText } from './helpers.js';

async function openExample(page) {
  await page.locator('.tpl[data-tpl="example"]').click();
  await expect(page.locator('#studio .sd-page')).toHaveCount(2);
  await expect(page.locator('#prjTab')).toHaveClass(/on/);
}

test('Beispiel „Zufallsgenerator“: Lage aller Teile wie im Vorbild', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await openExample(page);
    const geo = await page.evaluate(() => {
      const L = window.pdfEditor.studio.doc.pages[0].layout;
      const r = (v) => Math.round(v * 100) / 100;
      return {
        scale: L.scale,
        hub: [L.hub.x, r(L.hub.y), L.hub.w, r(L.hub.h)],
        boxes: Object.fromEntries(L.boxes.map((b) => [b.id, [b.x, r(b.y), b.w, r(b.h)]])),
        conns: L.conns.map((c) => [c.label, r(c.y)]),
      };
    });
    // Maße aus der Vorlage (PDF-Koordinaten in pt, hier von oben gemessen: 841.89 − y)
    const top = (yPdf, h) => Math.round((841.89 - yPdf - h) * 100) / 100;
    expect(geo.scale).toBe(1);
    expect(geo.hub).toEqual([232, top(230, 476), 132, 476]);
    expect(geo.boxes).toEqual({
      display: [46, top(606, 84), 152, 84],
      key: [46, top(530, 56), 152, 56],
      ls1: [46, top(434, 72), 152, 72],
      ls2: [46, top(340, 72), 152, 72],
      relay: [398, top(600, 90), 152, 90],
      lights: [398, top(526, 58), 152, 58],
      amp: [398, top(458, 58), 152, 58],
      sd: [398, top(382, 66), 152, 66],
      rtc: [398, top(300, 58), 152, 58],
      psu: [46, top(132, 82), 504, 82],
    });
    const y = (yPdf) => Math.round((841.89 - yPdf) * 100) / 100;
    expect(geo.conns).toEqual([
      ['D2', y(636)],
      ['D3', y(620)],
      ['A0', y(556)],
      ['A2', y(470)],
      ['A3', y(376)],
      ['D5', y(640)],
      ['D6', y(626)],
      ['D7', y(612)],
      ['D9', y(500)],
      ['D10-D13', y(424)],
      ['A4 / A5', y(330)],
    ]);
    const text = await page.locator('#studio .sd-page').nth(1).textContent();
    expect(text).toContain('Belegung der Arduino-Anschlüsse');
    expect(text).toContain('Hinweise zur Verdrahtung');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Bedienung: Baugruppe ziehen, Rückgängig, Eigenschaften, Sprache, Entwurf', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await openExample(page);
    const boxY = () =>
      page.evaluate(() => window.pdfEditor.studio.doc.pages[0].layout.boxes.find((b) => b.id === 'key').y);
    const before = await boxY();
    // Kasten „Schlüsselschalter“ um 30 pt nach unten ziehen
    const pageEl = page.locator('#studio .sd-page').first();
    const box = await pageEl.boundingBox();
    const s = box.width / 595.276;
    const x = box.x + (46 + 76) * s;
    const yy = box.y + (before + 20) * s;
    await page.mouse.move(x, yy);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(x, yy + (30 * s * i) / 6);
    await page.mouse.up();
    await expect.poll(boxY).toBeCloseTo(before + 30, 0);
    await expect(page.locator('.sd-ihead')).toContainText('Baugruppe');
    await page.keyboard.press('Control+z');
    await expect.poll(boxY).toBeCloseTo(before, 1);

    // Titel im Eigenschaftenfeld ändern: die Seite zeigt ihn sofort
    const title = page.locator('#sdIBody input').first();
    await title.fill('Schlüsselschalter Tor');
    await expect(pageEl).toContainText('Schlüsselschalter Tor');

    // Sprache „Beide“: englische Beschriftungen erscheinen zusätzlich
    await page.locator('#sdProj').click();
    await page.locator('.sd-seg button', { hasText: 'Beide' }).click();
    await expect(pageEl).toContainText('Anschlussplan / Wiring diagram');
    await expect(page.locator('.rb[data-act="lang"]')).toContainText('Deutsch und Englisch');

    // Entwurf: auf der Startseite unter „Dokumentationen“, von dort wieder zu öffnen
    await page.locator('#tHome').click();
    await page.locator('.hs-tabs [data-list="drafts"]').click();
    const row = page.locator('#recentList .ri', { hasText: 'Anschlussplan Zufallsgenerator' });
    await expect(row).toBeVisible();
    await page.locator('#bPrjClose').click({ force: true });
    await expect(page.locator('#prjTab')).toBeHidden();
    await row.click();
    await expect(page.locator('#studio .sd-page').first()).toContainText('Schlüsselschalter Tor');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('PDF erstellen: Projekt eingebettet, beim Öffnen weiterbearbeiten', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    // Ersatz für den Hauptprozess der Desktop-App: Chromium setzt die Druckfassung in eine PDF
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
    await openExample(page);
    const b64 = await page.evaluate(async () => {
      const bytes = await window.pdfEditor.studio.buildPdf();
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const bytes = Buffer.from(b64, 'base64');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getTitle()).toBe('Anschlussplan Zufallsgenerator');
    expect(doc.catalog.has(PDFName.of('PDFixProject'))).toBe(true);
    const [p1, p2] = await extractText(bytes);
    expect(p1).toContain('Zufallsgenerator - Übersicht der Anschlüsse');
    expect(p1).toContain('Seite 1 von 2');
    expect(p2).toContain('Belegung der Arduino-Anschlüsse');

    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await window.pdfEditor.openBytes(bytes, 'plan.pdf', null);
    }, b64);
    await expect(page.locator('#docTab')).toHaveClass(/on/);
    await expect(page.locator('#sdOffer')).toBeVisible();
    await page.locator('#sdOffer .btn.primary').click();
    await expect(page.locator('#prjTab')).toHaveClass(/on/);
    expect(await page.evaluate(() => window.pdfEditor.studio.project.sections[0].hub.pins.length)).toBe(20);
    // beide Reiter bleiben offen: zurück zur PDF
    await page.locator('#docTab').click();
    await expect(page.locator('#scroller')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

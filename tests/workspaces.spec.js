/**
 * Arbeitsbereiche „PDF“ und „Dokumentation“: Umschalter, eigene Startseiten, Reiter, Akzentfarbe,
 * gemerkter Bereich, „Aus PDF fortsetzen“ – und neutrale Vorgaben (keine Firma, keine Beispiele).
 */
import { test, expect } from '@playwright/test';
import { launch, openPdf, FIXTURE } from './helpers.js';

const ws = (page) => page.evaluate(() => document.documentElement.dataset.ws);
const acc = (page) =>
  page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--acc').trim());

/** PDF-Erzeugung der Desktop-App im Browser nachbilden (Chromium druckt die Druckfassung). */
async function stubPdfMaker(page, context) {
  await page.exposeFunction('__pdfixMakePdf', async (html) => {
    const printer = await context.newPage();
    try {
      await printer.setContent(html);
      return Buffer.from(await printer.pdf({ preferCSSPageSize: true, printBackground: true })).toString('base64');
    } finally {
      await printer.close();
    }
  });
}

test('Umschalter: zwei Startseiten, Akzentfarbe, gemerkter Bereich', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    // Standard: Bereich „PDF“ – Öffnen, Werkzeuge, zuletzt geöffnete Dateien; keine Vorlagen
    expect(await ws(page)).toBe('pdf');
    await expect(page.locator('#wsPdf')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#hOpen')).toBeVisible();
    await expect(page.locator('#home .feat')).toHaveCount(4);
    await expect(page.locator('#home .tpl[data-tpl]')).toHaveCount(0);
    await expect(page.locator('#hsRecent h3')).toHaveText('Zuletzt geöffnet');
    const pdfAccent = await acc(page);

    // „Dokumentation“: Vorlagen, „Aus PDF fortsetzen“, zuletzt bearbeitete; andere Akzentfarbe
    await page.locator('#wsDocs').click();
    await expect.poll(() => ws(page)).toBe('docs');
    await expect(page.locator('#wsDocs')).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('#home .tpl[data-tpl]')).toHaveCount(4);
    await expect(page.locator('#continueZone')).toBeVisible();
    await expect(page.locator('#hOpen')).toHaveCount(0);
    await expect(page.locator('#hsRecent h3')).toHaveText('Zuletzt bearbeitet');
    expect(await acc(page)).not.toBe(pdfAccent);

    // Pfeiltasten im Umschalter
    await page.locator('#wsDocs').press('ArrowLeft');
    await expect.poll(() => ws(page)).toBe('pdf');
    await expect(page.locator('#wsPdf')).toBeFocused();
    await page.locator('#wsPdf').press('ArrowRight');
    await expect.poll(() => ws(page)).toBe('docs');

    // nach Neustart im zuletzt genutzten Bereich
    await page.reload();
    await page.waitForSelector('#home .hs');
    expect(await ws(page)).toBe('docs');
    await expect(page.locator('#home .tpl[data-tpl]')).toHaveCount(4);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Geöffnetes bleibt beim Umschalten: PDF und Dokumentation nebeneinander', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="manual"]').click();
    await expect(page.locator('#prjTab')).toHaveClass(/on/);
    await expect(page.locator('#docTab')).toBeHidden();

    // PDF öffnen: wechselt in den Bereich „PDF“, die Dokumentation läuft weiter (Punkt am Umschalter)
    await openPdf(page);
    expect(await ws(page)).toBe('pdf');
    await expect(page.locator('#docTab')).toHaveClass(/on/);
    await expect(page.locator('#prjTab')).toBeHidden();
    await expect(page.locator('#wsDocs')).toHaveClass(/open/);
    await expect(page.locator('#wsPdf')).not.toHaveClass(/open/);

    // zurück zur Dokumentation: dort weiter, wo man war
    await page.locator('#wsDocs').click();
    await expect(page.locator('#prjTab')).toHaveClass(/on/);
    await expect(page.locator('#studio')).toBeVisible();
    await expect(page.locator('#wsPdf')).toHaveClass(/open/);

    // Dokumentation schließen: Startseite „Dokumentation“, die PDF bleibt im Bereich „PDF“
    await page.locator('#bPrjClose').click();
    await expect(page.locator('#prjTab')).toBeHidden();
    expect(await ws(page)).toBe('docs');
    await expect(page.locator('#home .tpl[data-tpl]')).toHaveCount(4);
    await page.locator('#wsPdf').click();
    await expect(page.locator('#docTab')).toHaveClass(/on/);

    // PDF schließen: Startseite „PDF“ (nicht in die Dokumentation springen)
    await page.locator('#bClose').click();
    await expect(page.locator('#docTab')).toBeHidden();
    expect(await ws(page)).toBe('pdf');
    await expect(page.locator('#hOpen')).toBeVisible();
    await expect(page.locator('#wsDocs')).not.toHaveClass(/open/);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Aus PDF fortsetzen: Dokumentation aus einer erstellten PDF, fremde PDF wird erkannt', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await stubPdfMaker(page, context);
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="tech"]').click();
    const b64 = await page.evaluate(async () => {
      const st = window.pdfEditor.studio;
      st.change('Titel', (p) => (p.title = { de: 'Fortsetzungstest', en: '' }));
      const bytes = await st.buildPdf();
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      await st.close();
      return btoa(s);
    });
    await expect(page.locator('#prjTab')).toBeHidden();

    const run = (data) =>
      page.evaluate(async (data) => {
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        return window.pdfEditor.studio.continueFromPdf(bytes);
      }, data);
    // eine gewöhnliche PDF enthält keine Dokumentation
    expect(await run(FIXTURE.toString('base64'))).toBe('none');
    // die erstellte PDF: das Projekt öffnet im Bereich „Dokumentation“ (Entwurf und PDF sind gleich alt)
    expect(await run(b64)).toBe('opened');
    await expect(page.locator('#prjTab')).toHaveClass(/on/);
    await expect(page.locator('#prjName')).toContainText('Fortsetzungstest');
    expect(await ws(page)).toBe('docs');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Neutral: keine Firma, keine Kundenbeispiele in Vorlagen und neuen Dokumenten', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.locator('#wsDocs').click();
    await expect(page.locator('.tpl-thumb[data-thumb] svg')).toHaveCount(4);
    const previews = await page.locator('#home').innerHTML();
    for (const word of ['Doitronic', 'Zufallsgenerator', 'Arduino', 'Lichtschranke']) expect(previews).not.toContain(word);
    await page.locator('.tpl[data-tpl="documentation"]').click();
    const project = await page.evaluate(() => window.pdfEditor.studio.project);
    expect(project.company.name).toBe('');
    expect(project.company.tagline).toEqual({ de: '', en: '' });
    const all = JSON.stringify(project) + (await page.locator('#studio').innerHTML());
    for (const word of ['Doitronic', 'Zufallsgenerator', 'Arduino', 'Lichtschranke', 'Hikvision', 'Hik-Connect'])
      expect(all, word).not.toContain(word);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

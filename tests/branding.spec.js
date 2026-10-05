/**
 * Erscheinungsbild: PDFix-Symbol und -Name (Favicon, Kopfzeile, Startseite) und eine Kontextleiste,
 * deren Aktionen auch bei schmalem Fenster vollständig sichtbar bleiben.
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { launch, openPdf, idle } from './helpers.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const GRAFIK = readFileSync(path.join(DIR, 'fixtures', 'grafik.pdf'));

test.describe('PDFix-Symbol und Name', () => {
  test('Favicon, Kopfzeile und Startseite nutzen das neue Symbol und den neuen Namen', async ({
    browser,
  }) => {
    const { page, context, errors } = await launch(browser, 'neubau');
    try {
      expect(await page.title()).toBe('PDFix');
      expect(await page.locator('link[rel~="icon"]').getAttribute('href')).toMatch(
        /^data:image\/png;base64,/,
      );
      expect(await page.locator('#top .brand').innerText()).toBe('PDFix');
      expect(await page.locator('#home .hhero h1').innerText()).toBe('PDFix');
      for (const sel of ['#top .brand .mark img', '#home .hhero .mark img']) {
        expect(await page.locator(sel).getAttribute('src'), sel).toMatch(/^data:image\/png;base64,/);
        const box = await page.locator(sel).boundingBox();
        expect(box.width).toBeGreaterThanOrEqual(28);
      }
      // das Bild wird tatsächlich dekodiert (kein kaputtes Data-URI)
      const ok = await page.evaluate(() =>
        [...document.querySelectorAll('.mark img')].every((i) => i.complete && i.naturalWidth > 0),
      );
      expect(ok).toBe(true);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

test.describe('Kontextleiste im Bearbeiten-Modus', () => {
  for (const width of [1024, 1400]) {
    test(`Aktionen liegen bei ${width} px vollständig im Fenster (auch bei „Pfad bearbeiten“)`, async ({
      browser,
    }) => {
      const { page, context } = await launch(browser, 'neubau');
      try {
        await page.setViewportSize({ width, height: 800 });
        await openPdf(page, GRAFIK, 'grafik.pdf');
        await page.evaluate(() => window.pdfEditor.setTool('edit'));
        await idle(page);
        const check = async () => {
          const center = await page.locator('#center').boundingBox();
          const ctxBox = await page.locator('#ctx').boundingBox();
          const kids = await page.locator('#ctx > .btn, #ctx > .title').evaluateAll((els) =>
            els.map((e) => {
              const r = e.getBoundingClientRect();
              return { id: e.id || e.className, l: r.left, r: r.right, w: r.width };
            }),
          );
          for (const k of kids.filter((k) => k.w > 0)) {
            expect(k.l, k.id).toBeGreaterThanOrEqual(ctxBox.x - 0.5);
            expect(k.r, k.id).toBeLessThanOrEqual(center.x + center.width + 0.5);
          }
          const done = await page.locator('#cDone').boundingBox();
          expect(done.x + done.width).toBeLessThanOrEqual(width);
          expect(await page.locator('#ctx').evaluate((e) => e.scrollWidth <= e.clientWidth + 1)).toBe(true);
        };
        await check();
        await page.evaluate(() => {
          const e = window.pdfEditor.edit;
          e.pe = e.pe || {};
          e.updateHint();
        });
        await check();
      } finally {
        await context.close();
      }
    });
  }
});

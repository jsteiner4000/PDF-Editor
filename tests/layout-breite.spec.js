import { test, expect } from '@playwright/test';
import { launch, openPdf } from './helpers.js';

/**
 * Fensterbreite: Die App wird nie breiter als das Fenster, die rechte Leiste bleibt vollständig,
 * Reiter und Knöpfe der Kopfzeile überlappen nicht, „Im PDF-Bereich öffnen“ bleibt sichtbar.
 * Mit nachgebildeter Desktop-Kopfzeile (Menüleiste, Platz für die Fenstertasten).
 */
for (const frame of [false, true])
  test(`Kopfzeile und Leisten passen bei jeder Breite${frame ? ' (Desktop-Kopfzeile)' : ''}`, async ({ browser }) => {
    const { page, context, errors } = await launch(browser, 'neubau');
    try {
      await page.exposeFunction('__pdfixMakePdf', async () => '');
      await page.locator('#wsDocs').click();
      await page.locator('.tpl[data-tpl="documentation"]').click();
      await page.locator('.dlg .btn.primary', { hasText: 'Erstellen' }).click();
      await page.evaluate((frame) => {
        const st = window.pdfEditor.studio;
        st.change('Titel', (p) => (p.meta.site = 'Sehr langer Name einer Anlage mit Erweiterung Nord'));
        st.select({ kind: 'section', id: st.project.sections.find((s) => s.type === 'access').id });
        if (!frame) return;
        document.documentElement.classList.add('frame', 'desktop');
        const bar = document.createElement('nav');
        bar.className = 'menubar';
        bar.innerHTML = ['Datei', 'Bearbeiten', 'Ansicht', 'Werkzeuge', 'Fenster', 'Hilfe'].map((l) => `<button class="mb">${l}</button>`).join('') + '<button class="mb mb-all">≡</button>';
        document.querySelector('#top .brand').after(bar);
        document.getElementById('top').style.paddingRight = '148px';
      }, frame);
      for (const w of [900, 1000, 1100, 1280, 1530, 1700]) {
        await page.setViewportSize({ width: w, height: 860 });
        await page.waitForTimeout(150);
        const m = await page.evaluate(() => {
          const r = (sel) => document.querySelector(sel).getBoundingClientRect();
          const close = r('#bPrjClose');
          const hit = document.elementFromPoint(close.left + close.width / 2, close.top + close.height / 2);
          const bar = r('#rbBar');
          const toPdf = r('.rb[data-act="topdf"]');
          return {
            app: document.getElementById('app').scrollWidth,
            insp: r('.sd-insp').right,
            home: r('#tHome').width,
            closeFree: !!hit && !!hit.closest('#bPrjClose'),
            saveRight: r('#bSave').right,
            toPdfVisible: toPdf.right <= bar.right + 1 && toPdf.width > 20,
          };
        });
        expect(m.app, `Breite ${w}`).toBeLessThanOrEqual(w);
        expect(m.insp, `Breite ${w}`).toBeLessThanOrEqual(w);
        expect(m.home, `Breite ${w}`).toBeLessThan(40);
        expect(m.closeFree, `Breite ${w}: Schließen des Reiters verdeckt`).toBe(true);
        expect(m.saveRight, `Breite ${w}`).toBeLessThanOrEqual(w - (frame ? 148 : 0) + 1);
        expect(m.toPdfVisible, `Breite ${w}: „Im PDF-Bereich öffnen“ nicht sichtbar`).toBe(true);
      }
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

test('Umschalten PDF ↔ Dokumentation: Knöpfe oben behalten ihre Größe', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await openPdf(page);
    const sizes = () => page.evaluate(() => ['wsPdf', 'wsDocs', 'bSave', 'bFile'].map((id) => document.getElementById(id).offsetWidth));
    const first = await sizes();
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await page.locator('.dlg .btn.primary', { hasText: 'Erstellen' }).click();
    expect(await sizes()).toEqual(first);
    await page.locator('#wsPdf').click(); // Punkt „Dokumentation geöffnet“ erscheint
    expect(await sizes()).toEqual(first);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

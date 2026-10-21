import { test, expect } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { launch } from './helpers.js';

/** Querformat je Abschnitt: Umschalten, Lage auf dem Hintergrund bleibt, Setzen per Klick, PDF mit gemischten Formaten. */

test('Lageplan im Querformat: Lage bleibt, Klick setzt richtig, PDF hat hoch und quer', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
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
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const site = st.project.sections.find((s) => s.type === 'site');
      const c = document.createElement('canvas');
      c.width = 800;
      c.height = 500;
      c.getContext('2d').fillRect(0, 0, 800, 500);
      st.project.images.bg = { mime: 'image/png', data: c.toDataURL('image/png'), w: 800, h: 500 };
      const sym = (id, x, y) => ({ id, kind: 'camera', x, y, name: { de: '', en: '' }, note: { de: '', en: '' }, scale: 1, fov: true, dir: 90, angle: 90, range: 60 });
      st.change('Plan', () => {
        site.bg.image = 'bg';
        site.symbols.push(sym('a', 0.25, 0.5));
      });
      st.select({ kind: 'section', id: site.id });
    });
    // Lage auf dem Bild (Anteil der Bildbreite/-höhe), unabhängig vom Seitenformat
    const onImage = () =>
      page.evaluate(() => {
        const st = window.pdfEditor.studio;
        const p = st.doc.pages.find((x) => x.kind === 'site');
        const a = p.site.area;
        const s = Math.min(a.w / 800, a.h / 500);
        const [w, h] = [800 * s, 500 * s];
        const m = p.site.symbols.find((x) => x.id === 'a') || { x: 0, y: 0 };
        const pos = m.x != null ? [m.x, m.y] : [0, 0];
        return { land: p.w > p.h, fx: (pos[0] - (a.x + (a.w - w) / 2)) / w, fy: (pos[1] - (a.y + (a.h - h) / 2)) / h };
      });
    await expect.poll(() => page.evaluate(() => !!window.pdfEditor.studio.doc.pages.find((x) => x.kind === 'site')?.site.symbols.length)).toBe(true);
    const before = await onImage();
    expect(before.fx).toBeCloseTo(0.25, 2);
    await page.locator('#sdIBody .sd-seg button', { hasText: 'Querformat' }).click();
    await expect.poll(async () => (await onImage()).land).toBe(true);
    const after = await onImage();
    expect(after.land).toBe(true);
    expect(after.fx).toBeCloseTo(before.fx, 2);
    expect(after.fy).toBeCloseTo(before.fy, 2);

    // Kamera per Klick in den Plan (Querformat): landet an der geklickten Stelle
    const i = await page.evaluate(() => window.pdfEditor.studio.doc.pages.findIndex((p) => p.kind === 'site'));
    const area = await page.evaluate((i) => window.pdfEditor.studio.doc.pages[i].site.area, i);
    await page.evaluate(() => window.pdfEditor.studio.arm('camera'));
    const pg = page.locator('#studio .sd-page').nth(i);
    await pg.scrollIntoViewIfNeeded();
    const box = await pg.boundingBox();
    const k = box.width / 841.89;
    await page.mouse.click(box.x + (area.x + area.w * 0.8) * k, box.y + (area.y + area.h * 0.3) * k);
    await expect.poll(() => page.evaluate(() => window.pdfEditor.studio.project.sections.find((s) => s.type === 'site').symbols.length)).toBe(2);
    const placed = await page.evaluate(() => window.pdfEditor.studio.project.sections.find((s) => s.type === 'site').symbols.at(-1));
    expect(placed.x).toBeCloseTo(0.8, 1);
    expect(placed.y).toBeCloseTo(0.3, 1);

    // zurück ins Hochformat: wieder dieselbe Stelle
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      st.select({ kind: 'section', id: st.project.sections.find((s) => s.type === 'site').id });
    });
    await page.locator('#sdIBody .sd-seg button', { hasText: 'Hochformat' }).click();
    await expect.poll(async () => (await onImage()).land).toBe(false);
    const back = await onImage();
    expect(back.land).toBe(false);
    expect(back.fx).toBeCloseTo(before.fx, 2);
    await page.locator('#sdIBody .sd-seg button', { hasText: 'Querformat' }).click();
    await expect.poll(async () => (await onImage()).land).toBe(true);

    // PDF: Deckblatt hoch, Lageplan quer
    const b64 = await page.evaluate(async () => {
      const bytes = await window.pdfEditor.studio.buildPdf();
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const pdf = await PDFDocument.load(Buffer.from(b64, 'base64'));
    const sizes = pdf.getPages().map((p) => (p.getWidth() > p.getHeight() ? 'quer' : 'hoch'));
    expect(sizes[0]).toBe('hoch');
    expect(sizes).toContain('quer');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

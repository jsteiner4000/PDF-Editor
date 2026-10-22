import { test, expect } from '@playwright/test';
import { launch } from './helpers.js';

/**
 * Fotos im Lageplan: zu einem Gerät hinzufügen, Fotostandort per Rechtsklick setzen (F 1),
 * Rechtsklick auf ein Foto > „Im Lageplan zeigen“, Fotostandorte ausblenden.
 */

// 1×1-PNG als Datei für den Dateidialog
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const file = (name) => ({ name, mimeType: 'image/png', buffer: PNG });

const sym = (id, kind, x, y) => ({ id, kind, x, y, name: { de: '', en: '' }, note: { de: '', en: '' }, scale: 1, fov: kind === 'camera', dir: 90, angle: 90, range: 60 });

/** Bildschirmpunkt zu Seitenkoordinaten einer Seite. */
const screenAt = (page, pred, fn) =>
  page.evaluate(
    ({ pred, fn }) => {
      const st = window.pdfEditor.studio;
      const i = st.doc.pages.findIndex(new Function('p', 'return ' + pred));
      const el = document.querySelectorAll('#sdPages .sd-page')[i];
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      const [x, y] = new Function('p', 'return ' + fn)(st.doc.pages[i]);
      return [r.left + x * st.scale, r.top + y * st.scale];
    },
    { pred, fn },
  );

test('Fotos zum Gerät, Fotostandort per Rechtsklick, „Im Lageplan zeigen“, ausblenden', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await page.locator('.dlg .btn.primary', { hasText: 'Erstellen' }).click();
    await page.evaluate((list) => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.change('Symbole', () => s.symbols.push(...list));
      st.select({ kind: 'sym', id: 'k1', section: s.id });
    }, [sym('k1', 'camera', 0.3, 0.3)]);

    // Kamera: „Foto hinzufügen …“ → Foto in der Fotodokumentation, verknüpft
    const chooser = page.waitForEvent('filechooser');
    await page.locator('#sdIBody .btn', { hasText: 'Foto hinzufügen' }).click();
    await (await chooser).setFiles([file('a.png')]);
    const photos = () =>
      page.evaluate(() => {
        const s = window.pdfEditor.studio.project.sections.find((x) => x.type === 'photos');
        return s ? s.items.map((p) => p.link) : null;
      });
    await expect.poll(photos).toEqual(['k1']);
    await expect(page.locator('#sdIBody h4', { hasText: 'Fotos (1)' })).toBeVisible();

    // Bild aufs Symbol ziehen: ebenfalls zu K 1
    const k1 = await screenAt(page, 'p.site', "(() => { const m = p.site.symbols.find((y) => y.id === 'k1'); return [m.x, m.y]; })()");
    await page.evaluate(([x, y]) => {
      const dt = new DataTransfer();
      dt.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='), (c) => c.charCodeAt(0))], 'c.png', { type: 'image/png' }));
      document.elementFromPoint(x, y).dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, clientX: x, clientY: y, dataTransfer: dt }));
    }, k1);
    await expect.poll(photos).toEqual(['k1', 'k1']);

    // Rechtsklick auf freie Stelle im Plan → „Foto hier einfügen …“ → Fotostandort F 3
    const free = await screenAt(page, 'p.site', '[p.site.area.x + p.site.area.w * 0.7, p.site.area.y + p.site.area.h * 0.7]');
    await page.mouse.click(...free, { button: 'right' });
    const chooser2 = page.waitForEvent('filechooser');
    await page.locator('.menu .mi', { hasText: 'Foto hier einfügen' }).click();
    await (await chooser2).setFiles([file('b.png')]);
    await expect.poll(async () => (await photos()).length).toBe(3);
    const spot = await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      return s.symbols.find((y) => y.kind === 'photo');
    });
    expect(spot).toBeTruthy();
    expect((await photos())[2]).toBe(spot.id);
    await expect(page.locator('#sdIBody h4').first()).toHaveText('F 3');
    // Fotostandort nicht in der Geräteliste
    const listText = await page.evaluate(() => window.pdfEditor.studio.doc.pages.filter((p) => p.kind === 'list').map((p) => p.svg).join(''));
    expect(listText).not.toContain('Fotostandort');

    // Fotostandorte ausblenden: nicht im Plan, „Im Lageplan zeigen“ findet ihn trotzdem
    await page.locator('#sdIBody .sd-f', { hasText: 'Fotostandorte im Plan' }).locator('button', { hasText: 'Aus' }).click();
    await expect.poll(() => page.evaluate(() => window.pdfEditor.studio.doc.pages.find((p) => p.site).site.symbols.map((y) => y.id))).toEqual(['k1']);
    const photo2 = await screenAt(page, "p.hits.some((h) => h.kind === 'photo')", "(() => { const h = p.hits.filter((h) => h.kind === 'photo')[2]; return [h.rect[0] + h.rect[2] / 2, h.rect[1] + h.rect[3] / 3]; })()");
    await page.mouse.click(...photo2, { button: 'right' });
    await page.locator('.menu .mi', { hasText: 'Im Lageplan zeigen' }).click();
    await expect(page.locator('.sd-pulse-dot')).toHaveCount(1);
    expect(await page.evaluate(() => window.pdfEditor.studio.sel.id)).toBe(spot.id);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('PDF: Fotodokumentation und Fotostandorte je Dokument ein/aus, Sprünge Foto ↔ Lageplan', async ({ browser }) => {
  const { PDFDocument, PDFName } = await import('pdf-lib');
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.exposeFunction('__pdfixMakePdf', async (html) => {
      const printer = await context.newPage();
      try {
        await printer.setContent(html);
        return Buffer.from(await printer.pdf({ preferCSSPageSize: true, printBackground: true })).toString('base64');
      } finally {
        await printer.close();
      }
    });
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await page.locator('.dlg .btn.primary', { hasText: 'Erstellen' }).click();
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      const mk = (id, kind, x) => ({ id, kind, x, y: 0.5, name: { de: '', en: '' }, note: { de: '', en: '' }, scale: 1, fov: true, dir: 0, angle: 60, range: 50 });
      st.change('x', (p) => {
        s.symbols.push(mk('k1', 'camera', 0.3), mk('f1', 'photo', 0.7));
        st.photosTarget(p).items.push(
          { id: 'p1', image: null, caption: { de: 'Einfahrt', en: '' }, date: '', link: 'k1' },
          { id: 'p2', image: null, caption: { de: 'Hof', en: '' }, date: '', link: 'f1' },
        );
      });
    });
    const build = async () => {
      const b64 = await page.evaluate(async () => {
        const bytes = await window.pdfEditor.studio.buildPdf();
        let s = '';
        for (const b of bytes) s += String.fromCharCode(b);
        return btoa(s);
      });
      const doc = await PDFDocument.load(Buffer.from(b64, 'base64'));
      const dests = doc.catalog.lookup(PDFName.of('Dests'));
      const links = doc.getPages().flatMap((pg) => {
        const a = pg.node.lookup(PDFName.of('Annots'));
        return a ? a.asArray().map((r) => String(doc.context.lookup(r).get(PDFName.of('Dest')))) : [];
      });
      return { pages: doc.getPageCount(), dests: dests ? dests.keys().map(String) : [], links };
    };
    const all = await build();
    // Kamera → Foto 1, Fotostandort → Foto 2; Foto 1 → Kamera, Foto 2 → Standort
    expect(all.links.sort()).toEqual(['/ph-p1', '/ph-p2', '/sy-f1', '/sy-k1']);
    expect(all.dests).toEqual(expect.arrayContaining(['/ph-p1', '/ph-p2', '/sy-k1', '/sy-f1']));

    // Fotostandorte nicht in der PDF: kein Sprung vom Standort und keiner ins Leere (Foto 2 ohne Ziel)
    const site = page.locator('#sdIBody .sd-check', { hasText: 'Fotostandorte in der fertigen PDF' });
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      st.select({ kind: 'section', id: st.project.sections.find((x) => x.type === 'site').id });
    });
    await site.click();
    expect((await build()).links.sort()).toEqual(['/ph-p1', '/sy-k1']);

    // Fotodokumentation nicht in der PDF: Seiten fehlen, im Programm gekennzeichnet
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      st.select({ kind: 'section', id: st.project.sections.find((x) => x.type === 'photos').id });
    });
    await page.locator('#sdIBody .sd-check', { hasText: 'In die fertige PDF übernehmen' }).click();
    await expect(page.locator('#sdPages .sd-page.sd-off')).toHaveCount(1);
    await expect(page.locator('.sd-sec', { hasText: 'nicht in der PDF' })).toHaveCount(1);
    const none = await build();
    expect(none.pages).toBe(all.pages - 1);
    expect(none.links).toEqual([]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

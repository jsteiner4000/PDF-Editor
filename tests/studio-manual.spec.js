import { test, expect } from '@playwright/test';
import { launch } from './helpers.js';

/** Bedienungsanleitung im Stil des Vorbilds: Seiten, Deckblatt, Positionen, Schritte, Vorlagen. */

const chapters = (page) =>
  page.evaluate(() => {
    const s = window.pdfEditor.studio.project.sections.find((x) => x.type === 'chapters');
    return JSON.parse(JSON.stringify(s));
  });

async function openManual(browser) {
  const ctx = await launch(browser, 'neubau');
  await ctx.page.locator('#wsDocs').click();
  await ctx.page.locator('.tpl[data-tpl="manual"]').click();
  await expect(ctx.page.locator('#prjTab')).toHaveClass(/on/);
  return ctx;
}

test('Anleitung: Vorlage im Stil des Vorbilds, Deckblatt-Felder, Gestaltung umschalten', async ({ browser }) => {
  const { page, context, errors } = await openManual(browser);
  try {
    const info = await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      return { design: st.project.design, lang: st.project.lang, pages: st.doc.pages.map((p) => p.kind), manual: st.doc.pages.filter((p) => p.manual).length };
    });
    expect(info.design).toBe('manual');
    expect(info.lang).toBe('de+en');
    expect(info.pages[0]).toBe('cover');
    expect(info.manual).toBeGreaterThanOrEqual(3);
    const first = page.locator('#studio .sd-page').nth(1);
    await expect(first).toContainText('Sicherheit');
    await expect(first).toContainText('VORSICHT');

    // Stand erscheint erst, wenn er ausgefüllt ist
    const cover = page.locator('#studio .sd-page').first();
    await expect(cover).not.toContainText('07/2031');
    await page.locator('#sdIBody input[placeholder="z. B. 03/2026"]').fill('07/2031');
    await expect(cover).toContainText('07/2031');

    // Gestaltung „Klassisch“: Kapitelköpfe des Vorbilds verschwinden, rückgängig machbar
    await page.locator('#sdIBody .sd-seg button', { hasText: 'Klassisch' }).click();
    await expect.poll(() => page.evaluate(() => window.pdfEditor.studio.doc.pages.filter((p) => p.manual).length)).toBe(0);
    await page.keyboard.press('Control+z');
    await expect.poll(() => page.evaluate(() => window.pdfEditor.studio.project.design)).toBe('manual');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Anleitung: Positionen per Klick setzen, ziehen, Esc beendet; Schritte und englische Tabellenzeilen', async ({ browser }) => {
  const { page, context, errors } = await openManual(browser);
  try {
    const id = await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'chapters');
      const b = s.blocks.find((x) => x.type === 'figure');
      const c = document.createElement('canvas');
      c.width = 400;
      c.height = 300;
      c.getContext('2d').fillRect(0, 0, 400, 300);
      st.project.images.tst = { mime: 'image/png', data: c.toDataURL('image/png'), w: 400, h: 300 };
      st.change('Bild', () => (b.image = 'tst'));
      st.select({ kind: 'block', id: b.id, section: s.id });
      return b.id;
    });
    await page.locator('#sdIBody .btn', { hasText: 'Positionen im Bild setzen' }).click();
    await expect(page.locator('#sdArm')).toBeVisible();
    const where = () =>
      page.evaluate((id) => {
        const st = window.pdfEditor.studio;
        const i = st.doc.pages.findIndex((p) => p.hits.some((h) => h.kind === 'figimg' && h.block === id));
        return { i, img: st.doc.pages[i].hits.find((h) => h.kind === 'figimg' && h.block === id).img };
      }, id);
    const click = async (fx, fy) => {
      const { i, img } = await where();
      const pg = page.locator('#studio .sd-page').nth(i);
      await pg.scrollIntoViewIfNeeded();
      const box = await pg.boundingBox();
      const k = box.width / 595.276;
      await page.mouse.click(box.x + (img[0] + img[2] * fx) * k, box.y + (img[1] + img[3] * fy) * k);
    };
    await click(0.3, 0.4);
    await page.keyboard.type('Taster');
    await click(0.7, 0.5);
    await page.keyboard.press('Escape');
    await expect(page.locator('#sdArm')).toHaveCount(0);
    let fig = (await chapters(page)).blocks.find((b) => b.id === id);
    expect(fig.marks.length).toBe(2);
    expect(fig.marks[0].name.de).toBe('Taster');
    expect(fig.marks[0].x).toBeCloseTo(0.3, 1);
    await expect(page.locator('#studio .sd-page', { hasText: 'Taster' }).first()).toBeVisible();

    // Punkt der ersten Position ziehen
    const pt = await page.evaluate((id) => {
      const st = window.pdfEditor.studio;
      const i = st.doc.pages.findIndex((p) => p.hits.some((h) => h.kind === 'mark' && h.block === id));
      const h = st.doc.pages[i].hits.find((h) => h.kind === 'mark' && h.part === 'pt');
      return { i, r: h.rect, img: h.img };
    }, id);
    const pg = page.locator('#studio .sd-page').nth(pt.i);
    const box = await pg.boundingBox();
    const k = box.width / 595.276;
    const sx = box.x + (pt.r[0] + pt.r[2] / 2) * k;
    const sy = box.y + (pt.r[1] + pt.r[3] / 2) * k;
    await page.mouse.move(sx, sy);
    await page.mouse.down();
    await page.mouse.move(sx + 40, sy + 20, { steps: 5 });
    await page.mouse.up();
    fig = (await chapters(page)).blocks.find((b) => b.id === id);
    expect(fig.marks[0].x).toBeGreaterThan(0.31);

    // Schritte mit Fotos: Schritt hinzufügen
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'chapters');
      st.select({ kind: 'block', id: s.blocks.find((x) => x.type === 'cards').id, section: s.id });
    });
    await page.locator('#sdIBody .btn', { hasText: 'Schritt hinzufügen' }).click();
    expect((await chapters(page)).blocks.find((b) => b.type === 'cards').items.length).toBe(3);

    // Störungstabelle: englische Zeile
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'chapters');
      st.select({ kind: 'block', id: s.blocks.filter((x) => x.type === 'table').at(-1).id, section: s.id });
    });
    await page.locator('#sdIBody .sd-grid input.en').first().fill('No power');
    await expect(page.locator('#studio .sd-page', { hasText: 'No power' }).first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Eigene Vorlage: speichern, auf der Startseite neu anlegen, entfernen', async ({ browser }) => {
  const { page, context, errors } = await openManual(browser);
  try {
    await page.locator('#sdIBody textarea').first().fill('Gerät X');
    await page.locator('#sdIBody .btn', { hasText: 'Als Vorlage speichern' }).click();
    await page.locator('.dlg [data-k="name"]').fill('Meine Vorlage');
    await page.locator('.dlg .btn.primary').click();
    await page.locator('#tHome').click();
    const tile = page.locator('.tpl[data-utpl]');
    await expect(tile).toHaveCount(1);
    await expect(tile).toContainText('Meine Vorlage');
    const before = await page.evaluate(() => window.pdfEditor.studio.project.id);
    await tile.click();
    await expect(page.locator('#prjTab')).toHaveClass(/on/);
    const after = await page.evaluate(() => ({ id: window.pdfEditor.studio.project.id, title: window.pdfEditor.studio.project.title.de, design: window.pdfEditor.studio.project.design }));
    expect(after.id).not.toBe(before);
    expect(after.title).toBe('Gerät X');
    expect(after.design).toBe('manual');

    await page.locator('#tHome').click();
    await page.locator('.tpl[data-utpl]').hover();
    await page.locator('.tpl[data-utpl] .tpl-x').click();
    await page.locator('.dlg .btn.primary').click();
    await expect(page.locator('.tpl[data-utpl]')).toHaveCount(0);
    await expect(page.locator('#hsOwn')).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

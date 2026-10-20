import { test, expect } from '@playwright/test';
import { launch } from './helpers.js';

/** Nummern der Symbole nachträglich ändern: einschieben, lückenlos, nach Lage neu nummerieren. */

const sym = (id, kind, x, y) => ({ id, kind, x, y, name: { de: '', en: '' }, note: { de: '', en: '' }, scale: 1, fov: kind === 'camera', dir: 90, angle: 90, range: 60 });

const labels = (page) =>
  page.evaluate(() => {
    const s = window.pdfEditor.studio.project.sections.find((x) => x.type === 'site');
    return { order: s.symbols.map((y) => y.id) };
  });

test('Lageplan: Nummer am Symbol ändern, andere rücken nach; Neu nummerieren nach Lage; rückgängig', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await page.evaluate((list) => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.change('Symbole', () => s.symbols.push(...list));
      st.select({ kind: 'sym', id: 'k4', section: s.id });
    }, [sym('k1', 'camera', 0.8, 0.8), sym('k2', 'camera', 0.1, 0.1), sym('m1', 'motion', 0.5, 0.5), sym('k3', 'camera', 0.5, 0.12), sym('k4', 'camera', 0.2, 0.6)]);
    await expect(page.locator('#sdIBody h4').first()).toHaveText('K 4');
    const field = page.locator('#sdIBody .sd-nr input');
    await expect(page.locator('#sdIBody .sd-nr-of')).toHaveText('von 4');

    // K 4 → K 2: die alte K 2 wird K 3, die alte K 3 wird K 4
    const order0 = (await labels(page)).order;
    await field.fill('2');
    await field.press('Enter');
    await expect(page.locator('#sdIBody h4').first()).toHaveText('K 2');
    // Liste „Im Plan“ in Nummernfolge
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.select({ kind: 'section', id: s.id });
    });
    const list = () => page.locator('#sdIBody .pin').allTextContents();
    expect(await list()).toEqual(['K 1', 'K 2', 'K 3', 'K 4', 'BM 1']);
    expect((await labels(page)).order).toEqual(order0); // Zeichenreihenfolge unverändert

    // Wer hat welche Nummer? (über das Auswählen)
    const who = async (id) => {
      await page.evaluate((id) => {
        const st = window.pdfEditor.studio;
        const s = st.project.sections.find((x) => x.type === 'site');
        st.select({ kind: 'sym', id, section: s.id });
      }, id);
      return page.locator('#sdIBody h4').first().textContent();
    };
    expect(await who('k1')).toBe('K 1');
    expect(await who('k4')).toBe('K 2');
    expect(await who('k2')).toBe('K 3');
    expect(await who('k3')).toBe('K 4');

    // Zu große Zahl: ans Ende (lückenlos)
    await page.locator('#sdIBody .sd-nr input').fill('9');
    await page.locator('#sdIBody .sd-nr input').press('Enter');
    await expect(page.locator('#sdIBody h4').first()).toHaveText('K 4');

    // Neu nummerieren nach Lage: k2 (oben links), k3 (oben Mitte), k4 (links Mitte), k1 (unten rechts)
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.select({ kind: 'section', id: s.id });
    });
    await page.locator('#sdIBody .btn', { hasText: 'Neu nummerieren nach Lage' }).click();
    expect(await who('k2')).toBe('K 1');
    expect(await who('k3')).toBe('K 2');
    expect(await who('k4')).toBe('K 3');
    expect(await who('k1')).toBe('K 4');
    expect(await who('m1')).toMatch(/ 1$/);

    // Rückgängig stellt die vorige Nummerierung wieder her
    await page.keyboard.press('Control+z');
    expect(await who('k3')).toBe('K 4');

    // Nummern bleiben nach Speichern und Laden erhalten
    const kept = await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      return JSON.parse(st.serialize()).sections.find((x) => x.type === 'site').symbols.map((y) => y.seq ?? null);
    });
    expect(kept.filter((v) => v !== null).length).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

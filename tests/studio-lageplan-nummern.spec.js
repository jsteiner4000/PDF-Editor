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
    await page.locator('.dlg .btn.primary', { hasText: 'Erstellen' }).click();
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

test('Mehrere Lagepläne: Nummern zählen durch, Nummer ändern bleibt im eigenen Plan', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await page.locator('.dlg .btn.primary', { hasText: 'Erstellen' }).click();
    // zweiten Lageplan über „+“ anlegen
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.select({ kind: 'section', id: s.id });
    });
    await page.locator('#sdAdd').click();
    await page.locator('.menu .mi', { hasText: 'Lageplan' }).click();
    await page.evaluate((mk) => {
      const st = window.pdfEditor.studio;
      const [a, b] = st.project.sections.filter((x) => x.type === 'site');
      const sym = (id, x, y) => ({ id, kind: 'camera', x, y, name: { de: '', en: '' }, note: { de: '', en: '' }, scale: 1, fov: true, dir: 90, angle: 90, range: 60 });
      st.change('Symbole', () => {
        a.symbols.push(sym('a1', 0.2, 0.2), sym('a2', 0.4, 0.2));
        b.symbols.push(sym('b1', 0.2, 0.2), sym('b2', 0.4, 0.2), sym('b3', 0.6, 0.2));
      });
      st.select({ kind: 'sym', id: 'b3', section: b.id });
    });
    const head = page.locator('#sdIBody h4').first();
    await expect(head).toHaveText('K 5');
    await expect(page.locator('#sdIBody .sd-nr-of')).toHaveText('3 bis 5');
    // Zugangsdaten (Kameras mit IP): jede Nummer nur einmal
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const ids = st.project.sections.filter((x) => x.type === 'site').flatMap((x) => x.symbols.map((y) => y.id));
      st.change('IP', () => ids.forEach((id, i) => (st.deviceFor(id).ip = '10.0.0.' + (i + 1))));
    });
    const names = await page.evaluate(() => {
      const acc = window.pdfEditor.studio.project.sections.find((x) => x.type === 'access');
      return acc.devices.map((d) => d.name.de || d.name);
    });
    expect(names.sort()).toEqual(['K 1 Kamera', 'K 2 Kamera', 'K 3 Kamera', 'K 4 Kamera', 'K 5 Kamera']);
    // K 5 → 1: bleibt im eigenen Plan, wird K 3
    const input = page.locator('#sdIBody .sd-nr input');
    await input.fill('1');
    await input.press('Enter');
    await expect(head).toHaveText('K 3');
    await expect(page.locator('#studio .sd-page', { hasText: 'K 5' }).first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Meldegruppenmodul: MGM-2-1, MGM-2-2, MGM-5-1; Typ ändern; Masten und Kästen in der Galerie', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await page.locator('.dlg .btn.primary', { hasText: 'Erstellen' }).click();
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      const mk = (id, groups, x) => ({ id, kind: 'mgm', groups, x, y: 0.5, name: { de: '', en: '' }, note: { de: '', en: '' }, scale: 1, fov: false, dir: 0, angle: 90, range: 60 });
      st.change('MGM', () => s.symbols.push(mk('g1', 2, 0.2), mk('g2', 2, 0.4), mk('g3', 5, 0.6)));
      st.select({ kind: 'section', id: s.id });
    });
    await expect(page.locator('#sdIBody .pin')).toHaveText(['MGM-2-1', 'MGM-2-2', 'MGM-5-1']);
    // Typ von g2 auf MGM 5: wird MGM-5-2, g1 bleibt MGM-2-1
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.select({ kind: 'sym', id: 'g2', section: s.id });
    });
    await page.locator('#sdIBody .sd-seg button', { hasText: 'MGM 5' }).click();
    await expect(page.locator('#sdIBody h4').first()).toHaveText('MGM-5-2');
    // Andere Zahl
    await page.locator('#sdIBody .sd-seg button', { hasText: 'Andere' }).click();
    await page.locator('#sdIBody input[aria-label="Meldegruppen"]').fill('8');
    await page.locator('#sdIBody input[aria-label="Meldegruppen"]').press('Enter');
    await expect(page.locator('#sdIBody h4').first()).toHaveText('MGM-8-1');
    await expect(page.locator('#studio .sd-page', { hasText: 'MGM-8-1' }).first()).toBeVisible();
    // Galerie: Gruppe Installation
    await page.locator('.rb[data-act="symbols"]').click();
    const infra = page.locator('.sd-gallery [data-g="infra"] .sd-symbol span');
    await expect(infra).toHaveText(['Meldegruppenmodul', 'Mast', 'Schaltkasten', 'Anschlusskasten', 'Netzwerkschrank']);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

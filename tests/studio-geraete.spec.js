import { test, expect } from '@playwright/test';
import { launch } from './helpers.js';

/**
 * Geräte aus dem Lageplan: erst mit eigenen Angaben in den Zugangsdaten; Melder mit Bus, Adresse,
 * Meldegruppe und Bereich; Kamera mit Rekorder und Kanal; Montagehöhe – alles in der Geräteliste.
 */

const sym = (id, kind, x, y) => ({ id, kind, x, y, name: { de: '', en: '' }, note: { de: '', en: '' }, scale: 1, fov: kind === 'camera', dir: 90, angle: 90, range: 60 });

test('Zugangsdaten nur mit Angaben; Bus, Meldegruppe, Bereich, Kanal und Höhe in der Geräteliste', async ({ browser }) => {
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
    }, [sym('k1', 'camera', 0.2, 0.2), sym('n1', 'recorder', 0.5, 0.2), sym('b1', 'motion', 0.7, 0.6), sym('g1', 'mgm', 0.3, 0.7)]);
    const devices = () => page.evaluate(() => window.pdfEditor.studio.project.sections.find((x) => x.type === 'access').devices.map((d) => d.sym));
    const listText = () =>
      page.evaluate(() => {
        const st = window.pdfEditor.studio;
        const id = st.project.sections.find((x) => x.type === 'site').id;
        return st.doc.pages.filter((p) => p.section === id).map((p) => p.svg).join('').replace(/<[^>]+>/g, ' ');
      });

    // ohne Angaben: nicht in den Zugangsdaten, Hinweis am Symbol
    expect(await devices()).toEqual([]);
    await expect(page.locator('#sdIBody')).toContainText('Erscheint unter „Zugangsdaten“, sobald etwas eingetragen ist.');
    // Seriennummer eintragen → steht drin; wieder leeren → verschwindet
    const sn = page.locator('.sd-grp', { hasText: 'Zugang' }).locator('.sd-f', { hasText: 'Seriennummer' }).locator('input');
    await sn.fill('ABC123');
    await expect.poll(devices).toEqual(['k1']);
    await sn.fill('');
    await expect.poll(devices).toEqual([]);

    // Kamera: Rekorder und Kanal, Montagehöhe
    await page.locator('#sdIBody select', { has: page.locator('option', { hasText: 'kein Rekorder' }) }).selectOption('n1');
    await page.locator('#sdIBody .sd-f', { hasText: 'Kanal' }).locator('input').fill('5');
    await page.locator('#sdIBody .sd-f', { hasText: 'Montagehöhe' }).locator('input').fill('3,5 m');
    await expect.poll(listText).toContain('NVR 1 / Kanal 5');
    await expect.poll(listText).toContain('Höhe 3,5 m');
    // Kanal ist keine Zugangsangabe: weiterhin nicht in den Zugangsdaten
    expect(await devices()).toEqual([]);

    // Melder: Bus, Adresse, Meldegruppe (Vorschlag aus den MGM), Bereich
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      st.select({ kind: 'sym', id: 'b1', section: st.project.sections.find((x) => x.type === 'site').id });
    });
    const grp = page.locator('.sd-grp', { hasText: 'Anschluss' });
    await grp.locator('.sd-f', { hasText: 'Bus' }).first().locator('input').fill('1');
    await grp.locator('.sd-f', { hasText: 'Adresse' }).locator('input').fill('12');
    await expect(page.locator('#sdGroups option')).toHaveCount(1);
    await grp.locator('.sd-f', { hasText: 'Meldegruppe' }).locator('input').fill('MGM-2-1');
    await grp.locator('.sd-f', { hasText: 'Bereich' }).locator('input').fill('2 – Halle');
    await expect.poll(listText).toContain('Bus 1 / Adr. 12');
    await expect.poll(listText).toContain('Bereich 2');
    expect(await listText()).toContain('MG MGM-2-1');

    // Bus/Adresse an den Symbolen im Plan
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      st.select({ kind: 'section', id: st.project.sections.find((x) => x.type === 'site').id });
    });
    await page.locator('#sdIBody .sd-check', { hasText: 'Bus/Adresse an den Symbolen' }).click();
    await expect.poll(listText).toContain('BM 1 · 1/12');

    // gespeichert und wieder geladen: alles bleibt
    const kept = await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = JSON.parse(st.serialize()).sections.find((x) => x.type === 'site');
      return s.symbols.filter((y) => ['k1', 'b1'].includes(y.id)).map((y) => [y.nvr, y.channel, y.height, y.bus, y.addr, y.group, y.area].filter(Boolean));
    });
    expect(kept).toEqual([['n1', '5', '3,5 m'], ['1', '12', 'MGM-2-1', '2 – Halle']]);

    // Art wechseln: unpassende Angaben fallen weg (Kamera → Rekorder: Kanal und Höhe weg)
    const after = await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.select({ kind: 'sym', id: 'k1', section: s.id });
      return s.id;
    });
    await page.locator('#sdIBody .sd-f', { hasText: 'Art' }).first().locator('select').selectOption('recorder');
    const k1 = await page.evaluate((id) => window.pdfEditor.studio.project.sections.find((x) => x.id === id).symbols.find((y) => y.id === 'k1'), after);
    expect([k1.nvr, k1.channel, k1.height]).toEqual([undefined, undefined, undefined]);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

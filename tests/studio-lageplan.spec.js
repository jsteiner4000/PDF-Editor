/**
 * Lageplan und Fotos – Fehler aus der unabhängigen Prüfung (Aufhellen, Anlage-Beschriftung, Duplizieren,
 * Platzieren, Verknüpfungen, stabile Planfläche, Zuschnitt, Legende, Entwurfsgröße). Nur gegen den Neubau.
 */
import { test, expect } from '@playwright/test';
import { launch } from './helpers.js';

const tick = (page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/** Neues Dokument mit Hintergrundbild im Lageplan. */
async function setup(page) {
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
    window.__png = c.toDataURL('image/png');
    st.project.images.bg = { mime: 'image/png', data: window.__png, w: 800, h: 500 };
    st.change('Hintergrund', () => (site.bg.image = 'bg'));
    st.select({ kind: 'section', id: site.id }, { reveal: true });
  });
}

test('Lageplan: Aufhellen, Anlage-Beschriftung, stabile Planfläche, Zuschnitt und Legende', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await setup(page);

    // Aufhellen: 40 % → 0,4 (nicht 4000)
    await page.locator('input.num[aria-label^="Aufhellen"]').fill('40');
    expect(await page.evaluate(() => window.pdfEditor.studio.project.sections.find((s) => s.type === 'site').bg.fade)).toBeCloseTo(0.4, 5);

    // Deckblatt: „Anlage“ bleibt „Anlage“
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      st.change('Anlage', (p) => (p.meta.site = 'Halle 2'));
    });
    await expect.poll(() => page.evaluate(() => window.pdfEditor.studio.doc.pages[0].svg)).toMatch(/>Anlage</);

    // Planfläche ändert sich weder mit der Zahl der Symbolarten noch mit langen Namen
    const area = () => page.evaluate(() => window.pdfEditor.studio.doc.pages.find((p) => p.kind === 'site').site.area);
    const before = await area();
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const site = st.project.sections.find((s) => s.type === 'site');
      st.change('Symbole', () => {
        for (const [i, kind] of ['camera', 'motion', 'smoke', 'contact', 'glass', 'siren', 'keypad'].entries()) {
          const y = { id: 'y' + i, kind, x: 0.1 + i * 0.1, y: 0.9, name: { de: '', en: '' }, note: { de: '', en: '' }, scale: 1, fov: false, dir: 0, angle: 90, range: 60 };
          if (kind === 'camera') Object.assign(y, { fov: true, dir: 180, angle: 90, range: 400, y: 0.98 });
          site.symbols.push(y);
        }
        site.custom.push({ id: 'cu1', image: 'bg', name: { de: 'L'.repeat(300), en: '' }, code: 'ES' });
        site.symbols.push({ id: 'z1', kind: 'custom:cu1', x: 0.5, y: 0.5, name: { de: '', en: '' }, note: { de: '', en: '' }, scale: 1, fov: false, dir: 0, angle: 90, range: 60 });
      });
    });
    await tick(page);
    expect(await area()).toEqual(before);
    const svg = await page.evaluate(() => window.pdfEditor.studio.doc.pages.find((p) => p.kind === 'site').svg);
    // Erfassungsbereich liegt in einem auf die Planfläche beschnittenen Rahmen
    expect(svg).toMatch(/<svg [^>]*overflow="hidden">(?:(?!<\/svg>).)*fill-opacity="0\.16"/s);
    expect(svg).not.toContain('clip-path');
    // lange Namen werden in der Legende gekürzt
    expect(svg).toContain('…');
    expect(svg).not.toContain('L'.repeat(100));
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Lageplan: Kopie, Platzieren im richtigen Plan, Verknüpfungen, Nummern, Entwurf', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await setup(page);
    const state = await page.evaluate(async () => {
      const st = window.pdfEditor.studio;
      const a = st.project.sections.find((s) => s.type === 'site');
      const sym = (id, kind) => ({ id, kind, x: 0.4, y: 0.4, name: { de: '', en: '' }, note: { de: '', en: '' }, scale: 1, fov: false, dir: 0, angle: 90, range: 60 });
      st.change('Eigene Symbole', () => {
        a.custom.push({ id: 'cu1', image: 'bg', name: { de: 'Tor', en: '' }, code: 'ES' }, { id: 'cu2', image: 'bg', name: { de: 'Schranke', en: '' }, code: 'ES' });
        a.symbols.push(sym('ya', 'camera'), sym('yb', 'custom:cu1'), sym('yc', 'custom:cu2'));
      });
      // Kopie
      st.duplicateSection(a.id);
      const copy = st.project.sections.filter((s) => s.type === 'site')[1];
      const ids = [...a.symbols, ...copy.symbols, ...a.custom, ...copy.custom].map((x) => x.id);
      const kindsOk = copy.symbols.every((y) => !y.kind.startsWith('custom:') || copy.custom.some((c) => 'custom:' + c.id === y.kind));
      // nach dem Speichern und Öffnen bleiben die eigenen Symbole der Kopie
      await st.flush();
      const id = st.project.id;
      await st.close();
      await st.openDraft(id);
      const sites = st.project.sections.filter((s) => s.type === 'site');
      return {
        unique: new Set(ids).size === ids.length,
        kindsOk,
        reopened: sites.map((s) => s.symbols.map((y) => y.kind).sort()),
      };
    });
    // Nummern je Kürzel: zwei eigene Arten ergeben ES 1 und ES 2
    const plans = () => page.evaluate(() => window.pdfEditor.studio.doc.pages.filter((p) => p.kind === 'site').map((p) => p.svg).join(''));
    await expect.poll(plans).toMatch(/>ES 1</);
    expect(await plans()).toMatch(/>ES 2</);
    expect(state.unique).toBe(true);
    expect(state.kindsOk).toBe(true);
    expect(state.reopened).toHaveLength(2);
    expect(state.reopened[1]).toEqual(state.reopened[0].map((k) => (k.startsWith('custom:') ? expect.stringMatching(/^custom:/) : k)));
    expect(state.reopened[1]).toHaveLength(3);

    const second = await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const [a, b] = st.project.sections.filter((s) => s.type === 'site');
      // Platzieren: gewählt ist Plan A, geklickt wird in Plan B
      st.select({ kind: 'section', id: a.id });
      st.armed = 'camera';
      const pageB = st.doc.pages.find((p) => p.section === b.id && p.kind === 'site');
      const area = pageB.site.area;
      const n = b.symbols.length;
      st.placeSymbol({ page: pageB, x: area.x + area.w / 2, y: area.y + area.h / 2 });
      const placedInB = b.symbols.length === n + 1;
      // eigene Art eines anderen Plans wird nicht gesetzt
      st.armed = 'custom:' + a.custom[0].id;
      const m = b.symbols.length;
      st.placeSymbol({ page: pageB, x: area.x + 10, y: area.y + 10 });
      return { placedInB, rejected: b.symbols.length === m };
    });
    expect(second.placedInB).toBe(true);
    expect(second.rejected).toBe(true);

    // Rückgängig: Platzieren endet, wenn die Art verschwindet
    const armed = await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const a = st.project.sections.find((s) => s.type === 'site');
      st.change('Eigenes Symbol hinzugefügt', () => a.custom.push({ id: 'cu9', image: 'bg', name: { de: 'Neu', en: '' }, code: 'ES' }));
      st.arm('custom:cu9');
      const on = st.armed;
      st.undo();
      return { on, after: st.armed };
    });
    expect(armed.on).toBe('custom:cu9');
    expect(armed.after).toBeNull();
    await expect(page.locator('#sdArm')).toHaveCount(0);

    // Verknüpfte Fotos: Symbol löschen löst die Verknüpfung, Rückgängig stellt sie wieder her
    const links = await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const a = st.project.sections.find((s) => s.type === 'site');
      const photos = st.project.sections.find((s) => s.type === 'photos');
      const target = a.symbols[0].id;
      st.change('Foto', () => photos.items.push({ id: 'fx', image: 'bg', caption: { de: '', en: '' }, date: '', link: target }));
      st.select({ kind: 'sym', id: target, section: a.id });
      st.removeSelected();
      const cleared = photos.items.find((p) => p.id === 'fx').link;
      st.undo();
      const restored = st.project.sections.find((s) => s.type === 'photos').items.find((p) => p.id === 'fx').link;
      return { cleared, restored, target };
    });
    expect(links.cleared).toBeNull();
    expect(links.restored).toBe(links.target);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Lageplan: eigene Symbole bearbeiten und entfernen, Entwurf ohne ungenutzte Bilder, Fotovorschau', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await setup(page);
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const a = st.project.sections.find((s) => s.type === 'site');
      const big = document.createElement('canvas');
      big.width = 1600;
      big.height = 1000;
      const g = big.getContext('2d');
      g.fillStyle = '#39c';
      g.fillRect(0, 0, 1600, 1000);
      st.project.images.ghost = { mime: 'image/png', data: window.__png, w: 800, h: 500 };
      st.project.images.photo1 = { mime: 'image/jpeg', data: big.toDataURL('image/jpeg', 0.9), w: 1600, h: 1000 };
      const photos = st.project.sections.find((s) => s.type === 'photos');
      st.change('Eigenes Symbol', () => {
        a.custom.push({ id: 'cu1', image: 'bg', name: { de: 'Tor', en: '' }, code: 'ES' });
        a.symbols.push({ id: 'y1', kind: 'custom:cu1', x: 0.5, y: 0.5, name: { de: '', en: '' }, note: { de: '', en: '' }, scale: 1, fov: false, dir: 0, angle: 90, range: 60 });
        photos.items.push({ id: 'f1', image: 'photo1', caption: { de: 'x', en: '' }, date: '', link: null });
      });
      st.select({ kind: 'section', id: a.id });
    });
    // Kürzel ändern wirkt auf die Nummer im Plan
    const code = page.locator('.sd-grp', { hasText: 'Eigenes Symbol · Tor' }).locator('input[maxlength="6"]');
    await code.fill('TOR');
    await expect.poll(() => page.evaluate(() => window.pdfEditor.studio.doc.pages.find((p) => p.kind === 'site').svg)).toContain('>TOR 1<');

    // Entwurf enthält nur verwendete Bilder (nicht „ghost“)
    await page.evaluate(() => window.pdfEditor.studio.flush());
    const saved = await page.evaluate(
      () =>
        new Promise((resolve, reject) => {
          const open = indexedDB.open('pdfix-studio');
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const get = open.result.transaction('data').objectStore('data').getAll();
            get.onsuccess = () => resolve(Object.keys(get.result[0].project.images).sort());
          };
        }),
    );
    expect(saved).toContain('bg');
    expect(saved).toContain('photo1');
    expect(saved).not.toContain('ghost');

    // Fotovorschau in der Liste ist klein
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      st.select({ kind: 'section', id: st.project.sections.find((s) => s.type === 'photos').id });
    });
    const thumb = page.locator('.sd-rows img[data-img="photo1"]');
    await expect.poll(async () => (await thumb.getAttribute('src')) || '').toMatch(/^data:image\/jpeg/);
    const small = await thumb.evaluate((el) => el.src.length);
    const full = await page.evaluate(() => window.pdfEditor.studio.project.images.photo1.data.length);
    expect(small).toBeLessThan(full / 4);

    // Entfernen: Symbol und Art verschwinden, Rückgängig bringt beides zurück
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      st.select({ kind: 'section', id: st.project.sections.find((s) => s.type === 'site').id });
    });
    await page.locator('.sd-grp', { hasText: 'Eigenes Symbol · Tor' }).getByRole('button', { name: 'Entfernen' }).click();
    const gone = await page.evaluate(() => {
      const a = window.pdfEditor.studio.project.sections.find((s) => s.type === 'site');
      return { custom: a.custom.length, symbols: a.symbols.length };
    });
    expect(gone).toEqual({ custom: 0, symbols: 0 });
    await page.keyboard.press('Control+z');
    const back = await page.evaluate(() => {
      const a = window.pdfEditor.studio.project.sections.find((s) => s.type === 'site');
      return { custom: a.custom.length, symbols: a.symbols.length };
    });
    expect(back).toEqual({ custom: 1, symbols: 1 });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

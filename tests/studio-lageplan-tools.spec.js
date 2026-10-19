/**
 * Lageplan-Werkzeuge: Symbol setzen und sofort anpassen, „Erneut“, Maßstab aus einer Bezugsstrecke,
 * Linie, Freihand, Zaun und Zone, Richtfunk Punkt-zu-Punkt und Punkt-zu-Mehrpunkt.
 */
import { test, expect } from '@playwright/test';
import { launch } from './helpers.js';

async function setup(page) {
  await page.locator('#wsDocs').click();
  await page.locator('.tpl[data-tpl="documentation"]').click();
  await page.evaluate(() => {
    const st = window.pdfEditor.studio;
    const site = st.project.sections.find((s) => s.type === 'site');
    const c = document.createElement('canvas');
    c.width = 800;
    c.height = 500;
    c.getContext('2d').fillStyle = '#dfe6dc';
    c.getContext('2d').fillRect(0, 0, 800, 500);
    st.project.images.bg = { mime: 'image/png', data: c.toDataURL('image/png'), w: 800, h: 500 };
    st.change('Hintergrund', () => (site.bg.image = 'bg'));
    st.select({ kind: 'section', id: site.id }, { reveal: true });
  });
  const plan = page.locator('#studio .sd-page').filter({ has: page.locator('svg') }).nth(2);
  await plan.scrollIntoViewIfNeeded();
  /** Anteile der Planfläche → Bildschirmpunkt. */
  const point = async (fx, fy) => {
    const area = await page.evaluate(() => window.pdfEditor.studio.doc.pages.find((p) => p.site).site.area);
    const b = await plan.boundingBox();
    const s = b.width / 595.276;
    return [b.x + (area.x + fx * area.w) * s, b.y + (area.y + fy * area.h) * s];
  };
  const site = () => page.evaluate(() => JSON.parse(JSON.stringify(window.pdfEditor.studio.project.sections.find((s) => s.type === 'site'))));
  const svg = () => page.evaluate(() => window.pdfEditor.studio.doc.pages.find((p) => p.site).svg);
  const drag = async (from, to, steps = 6) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    await page.mouse.up();
  };
  return { plan, point, site, svg, drag };
}

/** Aus der Galerie „Objekt“ wählen. */
async function pick(page, name) {
  await page.locator('.rb[data-act="symbols"]').click();
  await page.locator('.sd-gallery button', { hasText: name }).first().click();
}

test('Symbol setzen und direkt verschieben, dann „Erneut“ (Strg+D)', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    const { point, site, drag } = await setup(page);
    await pick(page, 'Kamera');
    await expect(page.locator('#sdArm')).toContainText('Kamera');
    // gedrückt halten und ziehen: setzen und verschieben in einem Zug
    await drag(await point(0.2, 0.2), await point(0.4, 0.3));
    let s = await site();
    expect(s.symbols).toHaveLength(1);
    expect(s.symbols[0].x).toBeCloseTo(0.4, 1);
    expect(s.symbols[0].y).toBeCloseTo(0.3, 1);
    // Setzen ist beendet, die Kamera ist gewählt, Griff für Richtung/Reichweite steht bereit
    await expect(page.locator('#sdArm')).toHaveCount(0);
    await expect(page.locator('.sd-handle:not(.sd-vertex)')).toBeVisible();
    // ein weiterer Klick setzt nichts
    await page.mouse.click(...(await point(0.8, 0.8)));
    expect((await site()).symbols).toHaveLength(1);
    // Strg+D: noch eine Kamera
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const sec = st.project.sections.find((x) => x.type === 'site');
      st.select({ kind: 'section', id: sec.id });
    });
    await expect(page.locator('.rb[data-act="again"]')).toContainText('Kamera');
    await page.keyboard.press('Control+d');
    await expect(page.locator('#sdArm')).toContainText('Kamera');
    await page.mouse.click(...(await point(0.6, 0.6)));
    s = await site();
    expect(s.symbols.map((y) => y.kind)).toEqual(['camera', 'camera']);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Maßstab, Linie, Freihand, Zaun und Zone mit Längen und Fläche', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    const { point, site, svg, drag } = await setup(page);
    const area = await page.evaluate(() => window.pdfEditor.studio.doc.pages.find((p) => p.site).site.area);

    // Maßstab: Strecke über die halbe Planbreite = 50 m
    await page.locator('.rb[data-act="scale"]').click();
    await expect(page.locator('#sdArm')).toContainText('Länge du kennst');
    await drag(await point(0.25, 0.9), await point(0.75, 0.9));
    await page.locator('.dlg input[type="number"]').fill('50');
    await page.locator('.dlg .btn.primary').click();
    let s = await site();
    expect(s.scale.m).toBe(50);
    const mpp = 50 / (0.5 * area.w);
    expect(await svg()).toContain('1 : ');
    // Bezugsstrecke im Editor sichtbar, nicht in der PDF
    await expect(page.locator('.sd-ovl-ref')).toHaveCount(1);

    // Linie über 80 % der Breite = 80 m
    await pick(page, 'Linie');
    await drag(await point(0.1, 0.1), await point(0.9, 0.1));
    s = await site();
    expect(s.shapes).toHaveLength(1);
    expect(s.shapes[0].type).toBe('line');
    await expect.poll(svg).toContain('>80 m<');
    expect(await page.evaluate(() => window.pdfEditor.studio.sel.kind)).toBe('shape');
    // Eckpunkt ziehen (Linie halbieren)
    const vertex = page.locator('.sd-vertex').nth(1);
    const vb = await vertex.boundingBox();
    await drag([vb.x + vb.width / 2, vb.y + vb.height / 2], await point(0.5, 0.1));
    await expect.poll(svg).toContain('>40 m<');
    expect((await site()).shapes[0].pts[1][0]).toBeCloseTo(0.5, 2);

    // Freihand
    await pick(page, 'Freihand');
    const f0 = await point(0.1, 0.4);
    await page.mouse.move(...f0);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++) await page.mouse.move(f0[0] + i * 8, f0[1] + Math.sin(i / 2) * 15);
    await page.mouse.up();
    s = await site();
    expect(s.shapes[1].type).toBe('free');
    expect(s.shapes[1].pts.length).toBeGreaterThan(3);

    // Zone: vier Ecken, Klick auf den ersten Punkt schließt – 20 % × 20 % der Fläche
    await pick(page, 'Zaun');
    const corners = [[0.6, 0.4], [0.8, 0.4], [0.8, 0.6], [0.6, 0.6]];
    for (const [x, y] of corners) await page.mouse.click(...(await point(x, y)));
    await expect(page.locator('#sdArm')).toContainText('schließt die Zone');
    await page.mouse.click(...(await point(0.6, 0.4)));
    s = await site();
    const zone = s.shapes[2];
    expect(zone).toMatchObject({ type: 'fence', closed: true });
    expect(zone.pts).toHaveLength(4);
    // Name der Zone direkt eingeben (Feld hat den Fokus)
    await page.keyboard.type('Zone 1 – Lager');
    await expect.poll(svg).toContain('Zone 1 – Lager');
    const m2 = Math.round(0.2 * area.w * mpp * 0.2 * area.h * mpp);
    await expect.poll(svg).toContain(`${m2.toLocaleString('de-DE')} m²`);

    // offener Zaun mit Enter beenden; Rücktaste nimmt den letzten Punkt zurück
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await pick(page, 'Zaun');
    await page.mouse.click(...(await point(0.1, 0.7)));
    await page.mouse.click(...(await point(0.3, 0.7)));
    await page.mouse.click(...(await point(0.3, 0.8)));
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Enter');
    s = await site();
    expect(s.shapes[3]).toMatchObject({ type: 'fence', closed: false });
    expect(s.shapes[3].pts).toHaveLength(2);
    // Legende: Zaun mit Gesamtlänge
    await expect.poll(svg).toMatch(/Zaun\s+\(/);

    // Farbe ändern (Farbfelder mit Namen für Screenreader)
    await page.getByRole('radio', { name: 'Rot' }).click();
    expect((await site()).shapes[3].color).toBe('#b91c1c');
    // Kopfzeile nennt die Art
    await expect(page.locator('.crumb')).toContainText('Zaun');

    // Pfeiltasten verschieben die Zeichnung (Umschalt = 10 pt), ein Schritt für Rückgängig
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const x0 = (await site()).shapes[3].pts[0][0];
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('ArrowRight');
    expect(((await site()).shapes[3].pts[0][0] - x0) * area.w).toBeCloseTo(11, 1);
    await page.keyboard.press('Control+z');
    expect((await site()).shapes[3].pts[0][0]).toBeCloseTo(x0, 5);

    // helle eigene Farbe: Name der Zone wird dunkel geschrieben
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const sec = st.project.sections.find((x) => x.type === 'site');
      st.change('Farbe', () => (sec.shapes[2].color = '#fde047'));
    });
    await expect.poll(svg).toMatch(/fill="#1f3b4d">Zone 1 – Lager</);

    // Löschen und Rückgängig
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Delete');
    expect((await site()).shapes).toHaveLength(3);
    await page.keyboard.press('Control+z');
    expect((await site()).shapes).toHaveLength(4);

    // Griffe: Klickfläche mindestens 22 × 22 px
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const sec = st.project.sections.find((x) => x.type === 'site');
      st.select({ kind: 'shape', id: sec.shapes[3].id, section: sec.id });
    });
    const hit = await page.locator('.sd-vertex').first().evaluate((el) => {
      const r = getComputedStyle(el, '::after');
      return [parseFloat(r.width), parseFloat(r.height)];
    });
    expect(Math.min(...hit)).toBeGreaterThanOrEqual(22);

    // Kamera-Reichweite in Metern
    await pick(page, 'Kamera');
    await page.mouse.click(...(await point(0.4, 0.5)));
    await expect(page.locator('.sd-range .num').last()).toHaveAttribute('aria-label', 'Reichweite (m)');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Richtfunk: Punkt-zu-Punkt und Punkt-zu-Mehrpunkt, Geräteliste, Stationen löschen', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    const { point, site, svg } = await setup(page);
    // Text der Seiten des Lageplans (ohne Auszeichnung, Zeilen zusammengefügt)
    const listText = () =>
      page.evaluate(() => {
        const st = window.pdfEditor.studio;
        const id = st.project.sections.find((s) => s.type === 'site').id;
        const html = st.doc.pages.filter((p) => p.section === id).map((p) => p.svg).join('');
        return [...new DOMParser().parseFromString(html.replace(/<svg/g, '<div').replace(/<\/svg>/g, '</div>'), 'text/html').querySelectorAll('text')].map((t) => t.textContent).join(' ');
      });

    // Punkt-zu-Punkt: zwei Klicks, zwei neue Antennen, eine Strecke – ein Schritt für Rückgängig
    const undoBefore = await page.evaluate(() => window.pdfEditor.studio.hist.undo.length);
    await pick(page, 'Punkt-zu-Punkt');
    await page.mouse.click(...(await point(0.1, 0.2)));
    await expect(page.locator('#sdArm')).toContainText('Gegenstelle');
    await page.mouse.click(...(await point(0.5, 0.2)));
    let s = await site();
    expect(s.symbols.map((y) => y.kind)).toEqual(['radio', 'radio']);
    expect(s.links).toHaveLength(1);
    expect(s.links[0]).toMatchObject({ mode: 'ptp', from: s.symbols[0].id, to: [s.symbols[1].id] });
    expect(await page.evaluate(() => window.pdfEditor.studio.hist.undo.length)).toBe(undoBefore + 1);
    expect(await page.evaluate(() => window.pdfEditor.studio.sel.kind)).toBe('link');
    await expect(page.locator('#sdArm')).toHaveCount(0);

    // Angaben: Band und SSID, IP an der Antenne
    await page.locator('.sd-f', { hasText: 'Frequenz / Band' }).locator('input').fill('5 GHz');
    await page.locator('.sd-f', { hasText: 'SSID' }).locator('input').fill('Hof-Link');
    await expect.poll(svg).toContain('5 GHz');
    // Beschriftung der Funkstrecke kontrastreicher als die Linie
    expect(await svg()).toMatch(/fill="#0e7490">5 GHz/);
    await page.locator('.sd-row', { hasText: 'Station A' }).click();
    await page.locator('.sd-f', { hasText: 'IP-Adresse' }).locator('input').fill('192.168.1.20');
    await expect.poll(listText).toContain('Richtfunk zu RF 2 (5 GHz, SSID Hof-Link) · IP 192.168.1.20');

    // Punkt-zu-Mehrpunkt: Basis ist die vorhandene Antenne RF 2, drei Gegenstellen, Enter beendet
    await pick(page, 'Punkt-zu-Mehrpunkt');
    await page.mouse.click(...(await point(0.5, 0.2)));
    await page.mouse.click(...(await point(0.8, 0.1)));
    await page.mouse.click(...(await point(0.8, 0.3)));
    await page.mouse.click(...(await point(0.8, 0.5)));
    await page.keyboard.press('Enter');
    s = await site();
    expect(s.symbols).toHaveLength(5);
    const multi = s.links[1];
    expect(multi.mode).toBe('ptmp');
    expect(multi.from).toBe(s.symbols[1].id);
    expect(multi.to).toHaveLength(3);
    // Gegenstelle ergänzen
    await page.locator('.sd-add', { hasText: 'Gegenstelle hinzufügen' }).click();
    await page.mouse.click(...(await point(0.9, 0.7)));
    s = await site();
    expect(s.links[1].to).toHaveLength(4);
    // Legende zeigt Richtfunk
    await expect.poll(svg).toContain('Richtfunk');

    // Basis löschen: Punkt-zu-Mehrpunkt fällt weg; Punkt-zu-Punkt auch (Gegenstelle fehlt)
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const sec = st.project.sections.find((x) => x.type === 'site');
      st.select({ kind: 'sym', id: sec.symbols[1].id, section: sec.id });
    });
    await page.keyboard.press('Delete');
    s = await site();
    expect(s.links).toHaveLength(0);
    await page.keyboard.press('Control+z');
    expect((await site()).links).toHaveLength(2);

    // Kopie und Wiederöffnen: Strecken zeigen auf die Antennen der Kopie, alles bleibt erhalten
    const again = await page.evaluate(async () => {
      const st = window.pdfEditor.studio;
      const a = st.project.sections.find((x) => x.type === 'site');
      st.change('Maßstab', () => (a.scale = { a: [0, 0], b: [1, 0], m: 100 }));
      st.duplicateSection(a.id);
      const copy = st.project.sections.filter((x) => x.type === 'site')[1];
      const own = new Set(copy.symbols.map((y) => y.id));
      const copyOk = copy.links.every((l) => own.has(l.from) && l.to.every((t) => own.has(t)));
      await st.flush();
      const id = st.project.id;
      await st.close();
      await st.openDraft(id);
      const sites = st.project.sections.filter((x) => x.type === 'site');
      return { copyOk, links: sites.map((x) => x.links.length), ip: st.project.sections.find((x) => x.type === 'access').devices.find((d) => d.sym === sites[0].symbols[0].id).ip, scale: sites[0].scale && sites[0].scale.m };
    });
    expect(again).toEqual({ copyOk: true, links: [2, 2], ip: '192.168.1.20', scale: 100 });
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Ausschnitt verschieben: vergrößert auf leerer Fläche ziehen, Leertaste, mittlere Maustaste', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await setup(page);
    const scroll = page.locator('#sdScroll');
    await page.evaluate(() => window.pdfEditor.studio.setZoom(3));
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.change('Kamera', () => s.symbols.push({ id: 'yk', kind: 'camera', x: 0.5, y: 0.5, name: { de: '', en: '' }, note: { de: '', en: '' }, ip: '', scale: 1, fov: false, dir: 0, angle: 90, range: 60 }));
    });
    /** Bildschirmpunkt eines Anteils der Planfläche; der Ausschnitt wird zuvor darauf zentriert. */
    const center = (fx, fy) =>
      page.evaluate(
        ([fx, fy]) => {
          const st = window.pdfEditor.studio;
          const pg = st.doc.pages.find((p) => p.site);
          const el = document.querySelectorAll('#sdPages .sd-page')[st.doc.pages.indexOf(pg)];
          const box = document.getElementById('sdScroll');
          const at = () => {
            const r = el.getBoundingClientRect();
            const sc = r.width / 595.276;
            const a = pg.site.area;
            return [r.left + (a.x + fx * a.w) * sc, r.top + (a.y + fy * a.h) * sc];
          };
          const b = box.getBoundingClientRect();
          const [x, y] = at();
          box.scrollLeft += x - (b.left + box.clientWidth / 2);
          box.scrollTop += y - (b.top + box.clientHeight / 2);
          return at();
        },
        [fx, fy],
      );
    const pos = () => scroll.evaluate((el) => [el.scrollLeft, el.scrollTop]);
    const dragFrom = async (from, dx, dy, button = 'left') => {
      await page.mouse.move(...from);
      await page.mouse.down({ button });
      for (let i = 1; i <= 5; i++) await page.mouse.move(from[0] + (dx * i) / 5, from[1] + (dy * i) / 5);
      await page.mouse.up({ button });
    };
    const camX = () => page.evaluate(() => window.pdfEditor.studio.project.sections.find((x) => x.type === 'site').symbols.find((y) => y.id === 'yk').x);

    // leere Stelle im Plan: Klick ohne Bewegung verschiebt nichts
    const empty = await center(0.3, 0.3);
    const [l0, t0] = await pos();
    await page.mouse.click(...empty);
    expect(await pos()).toEqual([l0, t0]);

    // Ziehen auf leerer Fläche verschiebt den Ausschnitt mit der Hand
    await dragFrom(empty, 120, 80);
    const [l1, t1] = await pos();
    expect(l0 - l1).toBeCloseTo(120, -1);
    expect(t0 - t1).toBeCloseTo(80, -1);

    // Leertaste + Ziehen über einem Symbol: verschiebt den Ausschnitt, nicht das Symbol
    const cam = await center(0.5, 0.5);
    // Fokus auf einer Schaltfläche: ein Klick in die Seite macht die Leertaste wieder zur Hand
    await page.locator('.rb[data-act="symbols"]').focus();
    await page.mouse.click(cam[0] - 150, cam[1] - 150);
    expect(await page.evaluate(() => document.activeElement.id)).toBe('sdScroll');
    const [l2] = await pos();
    await page.keyboard.down('Space');
    await expect(scroll).toHaveClass(/space-pan/);
    await dragFrom(cam, 100, 0);
    await page.keyboard.up('Space');
    await expect(scroll).not.toHaveClass(/space-pan/);
    expect(l2 - (await pos())[0]).toBeCloseTo(100, -1);
    expect(await camX()).toBe(0.5);

    // mittlere Maustaste, ebenfalls über dem Symbol
    const cam2 = await center(0.5, 0.5);
    const [, t3] = await pos();
    await dragFrom(cam2, 0, 90, 'middle');
    expect(t3 - (await pos())[1]).toBeCloseTo(90, -1);
    expect(await camX()).toBe(0.5);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

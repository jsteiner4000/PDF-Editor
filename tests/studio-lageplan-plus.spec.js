/**
 * Lageplan 2.11: Messen und Maßlinie mit Lupe, Bezugsstrecke nachziehen, Hintergrund nur in den
 * Eigenschaften, Ebenen und Aufhellen je Objekt, Plan ausdünnen, Benutzer je Gerät mit
 * automatischer Verknüpfung zu den Zugangsdaten, Aufleuchten aus Listen.
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
  const area = await page.evaluate(() => window.pdfEditor.studio.doc.pages.find((p) => p.site).site.area);
  const point = async (fx, fy) => {
    const b = await plan.boundingBox();
    const s = b.width / 595.276;
    return [b.x + (area.x + fx * area.w) * s, b.y + (area.y + fy * area.h) * s];
  };
  const site = () => page.evaluate(() => JSON.parse(JSON.stringify(window.pdfEditor.studio.project.sections.find((s) => s.type === 'site'))));
  const access = () => page.evaluate(() => JSON.parse(JSON.stringify(window.pdfEditor.studio.project.sections.find((s) => s.type === 'access'))));
  const svg = () => page.evaluate(() => window.pdfEditor.studio.doc.pages.find((p) => p.site).svg);
  const drag = async (from, to, steps = 6) => {
    await page.mouse.move(...from);
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps);
    await page.mouse.up();
  };
  return { plan, area, point, site, access, svg, drag };
}

const sym = (id, kind, x, y) => ({ id, kind, x, y, name: { de: '', en: '' }, note: { de: '', en: '' }, scale: 1, fov: kind === 'camera', dir: 90, angle: 90, range: 60 });

test('Messen: Länge sofort, Lupe, als Maßlinie behalten; Bezugsstrecke nachziehen; Hintergrund nur rechts', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    const { point, site, svg, drag, area } = await setup(page);
    await expect(page.locator('.rb[data-act="bg"]')).toHaveCount(0);
    await expect(page.locator('.sd-bg-acts [data-bg="image"]')).toContainText('Anderes Bild');

    // ohne Maßstab heißt der Knopf „Maßstab“, danach „Messen“
    await expect(page.locator('.rb[data-act="scale"]')).toBeVisible();
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.change('Maßstab', () => (s.scale = { a: [0, 0.5], b: [1, 0.5], m: 100 }));
      st.select({ kind: 'section', id: s.id });
    });
    await expect(page.locator('.rb[data-act="measure"]')).toContainText('Messen');

    // Bezugsstrecke: zwei Endpunkte als Ring mit Punkt, fein nachziehen
    await expect(page.locator('.sd-ref')).toHaveCount(2);
    const ref = await page.locator('.sd-ref[data-end="b"]').boundingBox();
    await drag([ref.x + ref.width / 2, ref.y + ref.height / 2], await point(0.5, 0.5));
    let s = await site();
    expect(s.scale.b[0]).toBeCloseTo(0.5, 2);
    expect(s.scale.m).toBe(100);
    // jetzt entsprechen 50 % der Breite 100 m

    // Messen: Lupe beim Ziehen, Länge im Hinweis, Maßlinie behalten
    await page.locator('.rb[data-act="measure"]').click();
    await expect(page.locator('#sdArm')).toContainText('Länge erscheint sofort');
    const from = await point(0.2, 0.3);
    const to = await point(0.45, 0.3);
    await page.mouse.move(...from);
    await expect(page.locator('#sdLoupe')).toBeVisible();
    await page.mouse.down();
    await page.mouse.move((from[0] + to[0]) / 2, from[1]);
    await expect(page.locator('#sdLoupe')).toBeVisible();
    await page.mouse.move(...to);
    await page.mouse.up();
    await expect(page.locator('#sdLoupe')).toHaveCount(0);
    await expect(page.locator('#sdArm')).toContainText('Länge: 50 m');
    expect((await site()).shapes).toHaveLength(0);
    await page.locator('#sdArm [data-keep]').click();
    s = await site();
    expect(s.shapes).toHaveLength(1);
    expect(s.shapes[0].type).toBe('dim');
    await expect.poll(svg).toContain('>50 m<');
    await expect(page.locator('.crumb')).toContainText('Maßlinie');
    expect(area.w).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Darstellung je Objekt: Ebene, Aufhellen, Beschriftung, Umriss; Plan ausdünnen', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    const { point, site, svg } = await setup(page);
    await page.evaluate((list) => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.change('Symbole', () => s.symbols.push(...list));
      st.select({ kind: 'sym', id: 'ya', section: s.id });
    }, [sym('ya', 'camera', 0.4, 0.4), sym('yb', 'motion', 0.42, 0.4)]);
    const order = () => page.evaluate(async () => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      return [...s.symbols].sort((a, b) => (a.layer ?? 0) - (b.layer ?? 0)).map((y) => y.id);
    });

    // Rechtsklick: Kontextmenü mit Ebenen und Aufhellen
    await page.mouse.click(...(await point(0.4, 0.4)), { button: 'right' });
    await expect(page.locator('.menu .mi', { hasText: 'In den Vordergrund' })).toBeVisible();
    await page.locator('.menu .mi', { hasText: 'In den Vordergrund' }).click();
    expect((await order()).at(-1)).toBe('ya');
    // Strg+Umschalt+↓: eine Ebene nach hinten
    await page.keyboard.press('Control+Shift+ArrowDown');
    expect((await order()).at(-1)).toBe('yb');
    // Eigenschaften: Ebene ganz vorne, Deckkraft 30 %
    await page.locator('.sd-layers [data-to="front"]').click();
    expect((await order()).at(-1)).toBe('ya');
    await page.locator('.sd-seg button', { hasText: '30 %' }).click();
    expect((await site()).symbols.find((y) => y.id === 'ya').fade).toBe(0.7);
    await expect.poll(svg).toContain('opacity="0.3"');
    // Beschriftung oben, Erfassungsbereich als Umriss
    await page.locator('.sd-f', { hasText: 'Beschriftung' }).locator('select').selectOption('top');
    await page.locator('.sd-check', { hasText: 'nur als Umriss' }).locator('input').check();
    let s = await site();
    expect(s.symbols.find((y) => y.id === 'ya')).toMatchObject({ labelPos: 'top', cone: 'outline' });
    await expect.poll(svg).toContain('stroke-dasharray="3 2"');
    // Rückgängig: ein Schritt je Änderung
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('Control+z');
    expect((await site()).symbols.find((y) => y.id === 'ya').cone).toBeUndefined();

    // Plan ausdünnen: Bewegungsmelder aus – nicht mehr im Plan, Legende vollständig
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.select({ kind: 'section', id: s.id });
    });
    const row = page.locator('.sd-grp', { hasText: 'Plan ausdünnen' }).locator('.sd-f', { hasText: 'Bewegungsmelder' });
    await row.locator('button', { hasText: 'Aus' }).click();
    s = await site();
    expect(s.thin.motion).toBe('hidden');
    const hits = await page.evaluate(() => window.pdfEditor.studio.doc.pages.find((p) => p.site).hits.filter((h) => h.kind === 'sym').map((h) => h.id));
    expect(hits).toEqual(['ya']);
    expect(await svg()).toContain('Bewegungsmelder');
    await row.locator('button', { hasText: 'Blass' }).click();
    expect((await site()).thin.motion).toBe('faded');
    await expect.poll(svg).toContain('opacity="0.35"');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Benutzer je Gerät, Zugangsdaten beidseitig verknüpft, Richtfunk-WLAN, Aufleuchten', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    const { site, access } = await setup(page);
    // Rekorder und zwei Antennen mit Strecke
    await page.evaluate((list) => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.change('Geräte', () => {
        s.symbols.push(...list);
        s.links.push({ id: 'lk', mode: 'ptp', from: 'r1', to: ['r2'], band: '5 GHz', ssid: '', key: '' });
      });
      st.select({ kind: 'sym', id: 'nv', section: s.id });
    }, [sym('nv', 'recorder', 0.3, 0.3), sym('r1', 'radio', 0.6, 0.3), sym('r2', 'radio', 0.8, 0.6), sym('mo', 'motion', 0.5, 0.7)]);
    // jedes Netzwerkgerät hat einen Eintrag in den Zugangsdaten, Melder nicht
    let acc = await access();
    expect(acc.devices.map((d) => d.sym).sort()).toEqual(['nv', 'r1', 'r2']);
    expect(acc.devices.find((d) => d.sym === 'nv').name.de).toBe('NVR 1 Rekorder');

    // Zugang am Symbol: IP und zwei Benutzer mit Rolle
    await page.locator('.sd-grp', { hasText: 'Zugang' }).locator('.sd-f', { hasText: 'IP-Adresse' }).locator('input').fill('192.168.1.10');
    const users = page.locator('.sd-user');
    await users.nth(0).locator('.sd-f', { hasText: 'Benutzer' }).locator('input').fill('admin');
    await users.nth(0).locator('.sd-f', { hasText: 'Passwort' }).locator('input').fill('geheim1');
    await users.nth(0).locator('.sd-f', { hasText: 'Rolle' }).locator('input').fill('Administrator');
    await page.locator('.sd-add', { hasText: 'Benutzer hinzufügen' }).click();
    await expect(users).toHaveCount(2);
    await users.nth(1).locator('.sd-f', { hasText: 'Benutzer' }).locator('input').fill('wache');
    await users.nth(1).locator('.sd-f', { hasText: 'Rolle' }).locator('input').fill('Nur ansehen');
    acc = await access();
    const nvr = acc.devices.find((d) => d.sym === 'nv');
    expect(nvr).toMatchObject({ ip: '192.168.1.10', user: 'admin', password: 'geheim1', role: 'Administrator' });
    expect(nvr.users.map((u) => [u.user, u.role])).toEqual([['wache', 'Nur ansehen']]);

    // Zugangsdaten-Tabelle: Gerät mit beiden Benutzern, Passwörter ausgeblendet
    const accessText = () =>
      page.evaluate(() => {
        const st = window.pdfEditor.studio;
        const id = st.project.sections.find((s) => s.type === 'access').id;
        const html = st.doc.pages.filter((p) => p.section === id).map((p) => p.svg).join('');
        return [...new DOMParser().parseFromString(html.replace(/<svg/g, '<div').replace(/<\/svg>/g, '</div>'), 'text/html').querySelectorAll('text')].map((t) => t.textContent).join(' | ');
      });
    await expect.poll(accessText).toContain('wache');
    let text = await accessText();
    expect(text).toContain('NVR 1 Rekorder');
    expect(text).toContain('Nur ansehen');
    expect(text).not.toContain('geheim1');
    // Name im Lageplan ändern → Zugangsdaten folgen
    await page.locator('.sd-f', { hasText: 'Bezeichnung' }).first().locator('input').first().fill('NVR Halle');
    expect((await access()).devices.find((d) => d.sym === 'nv').name.de).toBe('NVR Halle');
    // „In Zugangsdaten zeigen“: Eintrag öffnen und aufleuchten; dort Name ändern → Symbol folgt
    await page.locator('.sd-add', { hasText: 'In Zugangsdaten zeigen' }).click();
    expect(await page.evaluate(() => window.pdfEditor.studio.sel.kind)).toBe('device');
    await expect(page.locator('.sd-pulse-box')).toHaveCount(1);
    await expect(page.locator('.sd-linked')).toContainText('NVR 1');
    await page.locator('.sd-f', { hasText: 'Gerät' }).first().locator('input').first().fill('Rekorder Halle');
    expect((await site()).symbols.find((y) => y.id === 'nv').name.de).toBe('Rekorder Halle');
    // verknüpfte Einträge lassen sich dort nicht löschen
    await page.evaluate(() => document.activeElement.blur());
    await page.keyboard.press('Delete');
    await expect(page.locator('#toasts')).toContainText('gehört zum Lageplan');
    expect((await access()).devices).toHaveLength(3);
    // „Im Lageplan zeigen“: Symbol leuchtet im Plan
    await page.locator('.sd-linkbtn', { hasText: 'Im Lageplan zeigen' }).click();
    expect(await page.evaluate(() => window.pdfEditor.studio.sel)).toMatchObject({ kind: 'sym', id: 'nv' });
    await expect(page.locator('.sd-pulse-dot')).toHaveCount(1);

    // Richtfunk: SSID und Schlüssel → WLAN in den Zugangsdaten, Änderung dort → Strecke
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.select({ kind: 'link', id: 'lk', section: s.id });
    });
    await page.locator('.sd-f', { hasText: 'SSID' }).locator('input').fill('Hof-Link');
    await page.locator('.sd-f', { hasText: 'WLAN-Schlüssel' }).locator('input').fill('k3y');
    acc = await access();
    const wl = acc.wifi.find((w) => w.link === 'lk');
    expect(wl).toMatchObject({ ssid: 'Hof-Link', key: 'k3y' });
    expect(wl.note.de).toBe('Richtfunk RF 1 ↔ RF 2');
    await page.evaluate((id) => {
      const st = window.pdfEditor.studio;
      const a = st.project.sections.find((x) => x.type === 'access');
      st.select({ kind: 'wifi', id, section: a.id });
    }, wl.id);
    await expect(page.locator('.sd-linked')).toContainText('RF 1 ↔ RF 2');
    await page.locator('.sd-f', { hasText: 'WLAN-Name' }).locator('input').fill('Hof-Link-2');
    expect((await site()).links[0].ssid).toBe('Hof-Link-2');

    // Symbol löschen nimmt den Eintrag mit; Rückgängig bringt beides zurück
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.select({ kind: 'sym', id: 'nv', section: s.id });
    });
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    await page.keyboard.press('Delete');
    expect((await access()).devices.map((d) => d.sym).sort()).toEqual(['r1', 'r2']);
    await page.keyboard.press('Control+z');
    acc = await access();
    expect(acc.devices.find((d) => d.sym === 'nv').users).toHaveLength(1);

    // Geräteliste im Dokument: Klick auf eine Zeile zeigt das Gerät im Plan und lässt es aufleuchten
    const listRow = await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      const i = st.doc.pages.findIndex((p) => p.section === s.id && !p.site && p.hits.some((h) => h.kind === 'sym'));
      const hit = st.doc.pages[i].hits.find((h) => h.kind === 'sym' && h.id === 'r2');
      const el = document.querySelectorAll('#sdPages .sd-page')[i];
      el.scrollIntoView();
      const r = el.getBoundingClientRect();
      const k = r.width / 595.276;
      return [r.left + (hit.rect[0] + 30) * k, r.top + (hit.rect[1] + hit.rect[3] / 2) * k];
    });
    await page.mouse.click(...listRow);
    expect(await page.evaluate(() => window.pdfEditor.studio.sel)).toMatchObject({ kind: 'sym', id: 'r2' });
    await expect(page.locator('.sd-pulse-dot')).toHaveCount(1);
    // Geräteliste: IP aus den Zugangsdaten
    text = await page.evaluate(() => window.pdfEditor.studio.doc.pages.filter((p) => p.section === window.pdfEditor.studio.project.sections.find((x) => x.type === 'site').id).map((p) => p.svg).join(''));
    expect(text).toContain('IP 192.168.1.10');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

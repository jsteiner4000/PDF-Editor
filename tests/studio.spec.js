/**
 * „Dokumentation erstellen“: Anschlussplan wie das Vorbild, Bedienung (Auswahl, Ziehen, Rückgängig,
 * Eigenschaften, Sprache), Entwürfe und die PDF mit eingebettetem Projekt. Nur gegen den Neubau.
 */
import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { launch, extractText } from './helpers.js';
import { exampleProject } from './fixtures/wiring-example.mjs';

/** Beispiel-Anschlussplan (Testdaten) öffnen. */
async function openExample(page) {
  await page.evaluate((p) => window.pdfEditor.studio.open(p, { kind: 'section', id: p.sections[0].id }), exampleProject());
  await expect(page.locator('#studio .sd-page')).toHaveCount(2);
  await expect(page.locator('#prjTab')).toHaveClass(/on/);
}

test('Beispiel-Anschlussplan: Lage aller Teile wie im Vorbild', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await openExample(page);
    const geo = await page.evaluate(() => {
      const L = window.pdfEditor.studio.doc.pages[0].layout;
      const r = (v) => Math.round(v * 100) / 100;
      return {
        scale: L.scale,
        hub: [L.hub.x, r(L.hub.y), L.hub.w, r(L.hub.h)],
        boxes: Object.fromEntries(L.boxes.map((b) => [b.id, [b.x, r(b.y), b.w, r(b.h)]])),
        conns: L.conns.map((c) => [c.label, r(c.y)]),
      };
    });
    // Maße aus der Vorlage (PDF-Koordinaten in pt, hier von oben gemessen: 841.89 − y)
    const top = (yPdf, h) => Math.round((841.89 - yPdf - h) * 100) / 100;
    expect(geo.scale).toBe(1);
    expect(geo.hub).toEqual([232, top(230, 476), 132, 476]);
    expect(geo.boxes).toEqual({
      display: [46, top(606, 84), 152, 84],
      key: [46, top(530, 56), 152, 56],
      ls1: [46, top(434, 72), 152, 72],
      ls2: [46, top(340, 72), 152, 72],
      relay: [398, top(600, 90), 152, 90],
      lights: [398, top(526, 58), 152, 58],
      amp: [398, top(458, 58), 152, 58],
      sd: [398, top(382, 66), 152, 66],
      rtc: [398, top(300, 58), 152, 58],
      psu: [46, top(132, 82), 504, 82],
    });
    const y = (yPdf) => Math.round((841.89 - yPdf) * 100) / 100;
    expect(geo.conns).toEqual([
      ['D2', y(636)],
      ['D3', y(620)],
      ['A0', y(556)],
      ['A2', y(470)],
      ['A3', y(376)],
      ['D5', y(640)],
      ['D6', y(626)],
      ['D7', y(612)],
      ['D9', y(500)],
      ['D10-D13', y(424)],
      ['A4 / A5', y(330)],
    ]);
    const text = await page.locator('#studio .sd-page').nth(1).textContent();
    expect(text).toContain('Belegung der Arduino-Anschlüsse');
    expect(text).toContain('Hinweise zur Verdrahtung');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Bedienung: Baugruppe ziehen, Rückgängig, Eigenschaften, Sprache, Entwurf', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await openExample(page);
    const boxY = () =>
      page.evaluate(() => window.pdfEditor.studio.doc.pages[0].layout.boxes.find((b) => b.id === 'key').y);
    const before = await boxY();
    // Kasten „Schlüsselschalter“ um 30 pt nach unten ziehen
    const pageEl = page.locator('#studio .sd-page').first();
    const box = await pageEl.boundingBox();
    const s = box.width / 595.276;
    const x = box.x + (46 + 76) * s;
    const yy = box.y + (before + 20) * s;
    await page.mouse.move(x, yy);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(x, yy + (30 * s * i) / 6);
    await page.mouse.up();
    await expect.poll(boxY).toBeCloseTo(before + 30, 0);
    await expect(page.locator('.sd-ihead')).toContainText('Baugruppe');
    await page.keyboard.press('Control+z');
    await expect.poll(boxY).toBeCloseTo(before, 1);

    // Titel im Eigenschaftenfeld ändern: die Seite zeigt ihn sofort
    const title = page.locator('#sdIBody input').first();
    await title.fill('Schlüsselschalter Tor');
    await expect(pageEl).toContainText('Schlüsselschalter Tor');

    // Sprache „Beide“: englische Beschriftungen erscheinen zusätzlich
    await page.locator('#sdProj').click();
    await page.locator('.sd-seg button', { hasText: 'Beide' }).click();
    await expect(pageEl).toContainText('Anschlussplan / Wiring diagram');
    await expect(page.locator('.sd-seg button[aria-checked="true"]', { hasText: 'Beide' })).toBeVisible();
    // Sprache, Schrift und Logo stehen nur in den Projekteigenschaften, nicht auch im Werkzeugband
    await expect(page.locator('.rb[data-act="lang"], .rb[data-act="font"], .rb[data-act="logo"]')).toHaveCount(0);

    // Entwurf: auf der Startseite unter „Dokumentationen“, von dort wieder zu öffnen
    // Bereich „Dokumentation“: Startseite mit „Zuletzt bearbeitet“
    await page.locator('#tHome').click();
    await expect(page.locator('#hsRecent h3')).toHaveText('Zuletzt bearbeitet');
    const row = page.locator('#recentList .ri', { hasText: 'Anschlussplan Testaufbau' });
    await expect(row).toBeVisible();
    await page.locator('#bPrjClose').click({ force: true });
    await expect(page.locator('#prjTab')).toBeHidden();
    await row.click();
    await expect(page.locator('#studio .sd-page').first()).toContainText('Schlüsselschalter Tor');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('PDF erstellen: Projekt eingebettet, beim Öffnen weiterbearbeiten', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    // Ersatz für den Hauptprozess der Desktop-App: Chromium setzt die Druckfassung in eine PDF
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
    await openExample(page);
    const b64 = await page.evaluate(async () => {
      const bytes = await window.pdfEditor.studio.buildPdf();
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const bytes = Buffer.from(b64, 'base64');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    expect(doc.getTitle()).toBe('Anschlussplan Testaufbau');
    expect(doc.catalog.has(PDFName.of('PDFixProject'))).toBe(true);
    const [p1, p2] = await extractText(bytes);
    expect(p1).toContain('Testaufbau - Übersicht der Anschlüsse');
    expect(p1).toContain('Seite 1 von 2');
    expect(p2).toContain('Belegung der Arduino-Anschlüsse');

    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await window.pdfEditor.openBytes(bytes, 'plan.pdf', null);
    }, b64);
    await expect(page.locator('#docTab')).toHaveClass(/on/);
    await expect(page.locator('#sdOffer')).toBeVisible();
    await page.locator('#sdOffer .btn.primary').click();
    await expect(page.locator('#prjTab')).toHaveClass(/on/);
    expect(await page.evaluate(() => window.pdfEditor.studio.project.sections[0].hub.pins.length)).toBe(20);
    // beide bleiben offen: Umschalter zurück zum Bereich „PDF“ zeigt die PDF wieder
    await expect(page.locator('#docTab')).toBeHidden();
    await expect(page.locator('#wsPdf')).toHaveClass(/open/);
    await page.locator('#wsPdf').click();
    await expect(page.locator('#docTab')).toHaveClass(/on/);
    await expect(page.locator('#scroller')).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Zugangsdaten: Passwörter je PDF ein- oder ausgeblendet – ausgeblendet auch nicht eingebettet', async ({
  browser,
}) => {
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
    await page.locator('.sd-sec', { has: page.locator('b', { hasText: /^Zugangsdaten$/ }) }).click();
    await page.locator('.rb[data-act="device"]').click();
    await page.locator('#sdIBody input').first().fill('Rekorder (NVR)');
    const field = (label) => page.locator('.sd-f', { hasText: label }).locator('input').first();
    await field('IP-Adresse').fill('192.168.10.20');
    await field('Benutzer').fill('admin');
    await field('Passwort').fill('Geheim#2026');
    const accessPage = page.locator('#studio .sd-page[data-section]').filter({ hasText: 'Geräte-Zugänge' });
    await expect(accessPage).toContainText('192.168.10.20');
    await expect(accessPage).not.toContainText('Geheim#2026');

    const build = (show) =>
      page.evaluate(async (show) => {
        const bytes = await window.pdfEditor.studio.buildPdf(show);
        let s = '';
        for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        return s;
      }, show);
    const hidden = Buffer.from(await build(false), 'latin1');
    const shown = Buffer.from(await build(true), 'latin1');
    const textOf = async (bytes) => (await extractText(bytes)).join('\n');
    expect(await textOf(hidden)).not.toContain('Geheim#2026');
    expect(await textOf(hidden)).toContain('Passwörter und Schlüssel sind in dieser Fassung ausgeblendet.');
    expect(await textOf(shown)).toContain('Geheim#2026');
    // eingebettetes Projekt: ohne Passwort, wenn ausgeblendet
    const project = async (bytes) => {
      const doc = await PDFDocument.load(bytes);
      const stream = doc.context.lookup(doc.catalog.get(PDFName.of('PDFixProject')));
      const { decodePDFRawStream } = await import('pdf-lib');
      return JSON.parse(new TextDecoder().decode(decodePDFRawStream(stream).decode()));
    };
    const access = (p) => p.sections.find((s) => s.type === 'access').devices[0];
    expect(access(await project(hidden)).password).toBe('');
    expect(access(await project(shown)).password).toBe('Geheim#2026');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Seitenumbruch: langes Inhaltsverzeichnis und überlanger Hinweis bleiben über der Fußzeile', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await page.locator('.dlg .btn.primary', { hasText: 'Erstellen' }).click();
    const result = await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      st.change('Test', (p) => {
        const wiring = p.sections.find((s) => s.type === 'wiring');
        wiring.hints.push({ id: 'long', cat: 'sig', title: { de: 'Langer Hinweis', en: '' }, text: { de: 'Zeile mit etwas Text. '.repeat(600), en: '' } });
        for (let i = 0; i < 14; i++) p.sections.push({ ...JSON.parse(JSON.stringify(wiring)), id: 'w' + i, hints: [] });
      });
      st.renderPages();
      const doc = st.doc;
      const bottoms = doc.pages.map((pg) => Math.max(0, ...pg.hits.filter((h) => h.kind !== 'legend').map((h) => h.rect[1] + h.rect[3])));
      const toc = doc.pages.filter((pg) => pg.kind === 'toc').length;
      const hintParts = doc.pages.flatMap((pg) => pg.hits.filter((h) => h.id === 'long')).length;
      return { pages: doc.pages.length, toc, maxBottom: Math.max(...bottoms), hintParts };
    });
    expect(result.toc).toBe(2);
    expect(result.hintParts).toBeGreaterThan(1);
    expect(result.maxBottom).toBeLessThanOrEqual(770);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Sicherheit: präparierte Projektdaten in einer PDF gelangen nicht als HTML in die Oberfläche', async ({
  browser,
}) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    const doc = await PDFDocument.create();
    doc.addPage([595, 842]);
    const evil = '"><img src=x onerror="window.__pwned=1">';
    const project = {
      id: evil,
      lang: '"><b>x</b>',
      font: 'barlow',
      title: { de: 'Test', en: '' },
      company: { name: 'Firma', logo: 'l1' },
      images: { l1: { data: 'javascript:alert(1)', w: 10, h: 10 } },
      meta: {},
      sections: [{ id: evil, type: 'wiring', boxes: [{ id: evil, side: 'top', title: { de: evil } }], hub: { pins: [] } }],
    };
    const stream = doc.context.flateStream(new TextEncoder().encode(JSON.stringify(project)), { Type: 'PDFixProject' });
    doc.catalog.set(PDFName.of('PDFixProject'), doc.context.register(stream));
    const bytes = await doc.save();
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await window.pdfEditor.openBytes(bytes, 'evil.pdf', null);
    }, Buffer.from(bytes).toString('base64'));
    await page.locator('#sdOffer .btn.primary').click();
    await page.locator('#showDialog, .dlg .btn.primary').first().click(); // „verändert“-Rückfrage bestätigen
    await expect(page.locator('#studio')).toBeVisible();
    await page.waitForTimeout(300);
    const state = await page.evaluate(() => {
      const p = window.pdfEditor.studio.project;
      return {
        pwned: !!window.__pwned,
        imgs: document.querySelectorAll('#studio img[src="x"]').length,
        id: p.id,
        sectionId: p.sections[0].id,
        side: p.sections[0].boxes[0].side,
        lang: p.lang,
        logo: p.company.logo,
      };
    });
    expect(state.pwned).toBe(false);
    expect(state.imgs).toBe(0);
    expect(state.id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(state.sectionId).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(state.side).toBe('left');
    expect(state.lang).toBe('de');
    expect(state.logo).toBe(null);
    // Box-Titel erscheint als Text, nicht als Element
    await expect(page.locator('#studio .sd-page').first()).toContainText('<img src=x');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});


/** Erzeugt PDF-Bytes über den Ersatz für den Hauptprozess (Chromium). */
async function stubPdfMaker(page, context) {
  await page.exposeFunction('__pdfixMakePdf', async (html) => {
    const printer = await context.newPage();
    try {
      await printer.setContent(html);
      return Buffer.from(await printer.pdf({ preferCSSPageSize: true, printBackground: true })).toString('base64');
    } finally {
      await printer.close();
    }
  });
}

const sitePage = (page) => page.locator('#studio .sd-page').filter({ has: page.locator('svg') }).nth(2);

test('Lageplan: Symbole setzen, ziehen, Erfassungsbereich per Griff, Nummern, Rückgängig', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
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
      st.change('Hintergrund', () => (site.bg.image = 'bg'));
      st.select({ kind: 'section', id: site.id }, { reveal: true });
    });
    const plan = sitePage(page);
    await plan.scrollIntoViewIfNeeded();
    // Planfläche (pt) wie der Seitensatz sie berechnet – Anteile (fx, fy) → Bildschirmpunkt
    const point = async (fx, fy) => {
      const area = await page.evaluate(() => window.pdfEditor.studio.doc.pages.find((p) => p.kind === 'site').site.area);
      const b = await plan.boundingBox();
      const s = b.width / 595.276;
      return [b.x + (area.x + fx * area.w) * s, b.y + (area.y + fy * area.h) * s];
    };
    const symbols = () => page.evaluate(() => window.pdfEditor.studio.project.sections.find((s) => s.type === 'site').symbols.map((y) => ({ ...y })));

    // Platzieren: Kamera setzen – Setzen endet, die Kamera ist gewählt; „Erneut“ setzt die zweite
    await page.evaluate(() => window.pdfEditor.studio.arm('camera'));
    await expect(page.locator('#sdArm')).toContainText('Kamera');
    await page.mouse.click(...(await point(0.3, 0.3)));
    await expect(page.locator('#sdArm')).toHaveCount(0);
    expect(await page.evaluate(() => window.pdfEditor.studio.sel.kind)).toBe('sym');
    await page.locator('.rb[data-act="again"]').click();
    await expect(page.locator('#sdArm')).toContainText('Kamera');
    await page.mouse.click(...(await point(0.7, 0.5)));
    await expect(page.locator('#sdArm')).toHaveCount(0);
    await page.evaluate(() => window.pdfEditor.studio.arm('motion'));
    await page.mouse.click(...(await point(0.5, 0.2)));
    const placed = await symbols();
    expect(placed.map((y) => y.kind)).toEqual(['camera', 'camera', 'motion']);
    expect(placed[0].x).toBeCloseTo(0.3, 1);
    // Nummern je Art, Legende und Liste
    await expect(plan).toContainText('K 1');
    await expect(plan).toContainText('K 2');
    await expect(plan).toContainText('BM 1');
    await expect(plan).toContainText('Kamera');

    // Verschieben: erste Kamera um 20 % nach rechts ziehen
    const [x0, y0] = await point(0.3, 0.3);
    const [x1] = await point(0.5, 0.3);
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    for (let i = 1; i <= 5; i++) await page.mouse.move(x0 + ((x1 - x0) * i) / 5, y0);
    await page.mouse.up();
    expect((await symbols())[0].x).toBeCloseTo(0.5, 1);
    await page.keyboard.press('Control+z');
    expect((await symbols())[0].x).toBeCloseTo(0.3, 1);

    // Griff: Blickrichtung nach rechts (90°), Reichweite ≈ 100 pt
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      st.select({ kind: 'sym', id: s.symbols[0].id, section: s.id });
    });
    const handle = page.locator('.sd-handle');
    await expect(handle).toBeVisible();
    const hb = await handle.boundingBox();
    const b = await plan.boundingBox();
    const pt = b.width / 595.276;
    const [cx, cy] = await point(0.3, 0.3);
    await page.mouse.move(hb.x + hb.width / 2, hb.y + hb.height / 2);
    await page.mouse.down();
    await page.mouse.move(cx + 40 * pt, cy + 5 * pt);
    await page.mouse.move(cx + 100 * pt, cy);
    await page.mouse.up();
    const cam = (await symbols())[0];
    expect(cam.dir).toBe(90);
    expect(Math.abs(cam.range - 100)).toBeLessThan(3);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Fotodokumentation: Fotos mit EXIF-Datum, 2 je Seite, Verknüpfung, leere Abschnitte nicht in der PDF', async ({
  browser,
}) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await stubPdfMaker(page, context);
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await page.locator('.dlg .btn.primary', { hasText: 'Erstellen' }).click();
    // leere Vorlage: in der PDF nur Deckblatt und Inhalt
    const empty = await page.evaluate(() => {
      const d = window.pdfEditor.studio;
      const { renderDocument } = {};
      return d.doc.pages.length;
    });
    expect(empty).toBeGreaterThan(2);
    const bytesEmpty = await page.evaluate(async () => {
      const b = await window.pdfEditor.studio.buildPdf();
      return b.length;
    });
    expect(bytesEmpty).toBeGreaterThan(1000);
    const pagesEmpty = await page.evaluate(async () => {
      const bytes = await window.pdfEditor.studio.buildPdf();
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    expect((await PDFDocument.load(Buffer.from(pagesEmpty, 'base64'))).getPageCount()).toBe(2);

    // Fotos hinzufügen (JPEG mit EXIF-Datum)
    await page.evaluate(async () => {
      const st = window.pdfEditor.studio;
      const section = st.project.sections.find((s) => s.type === 'photos');
      const make = async (w, h, color) => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const g = c.getContext('2d');
        g.fillStyle = color;
        g.fillRect(0, 0, w, h);
        const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
        const bytes = new Uint8Array(await blob.arrayBuffer());
        // minimaler EXIF-Block mit DateTimeOriginal 2025:06:17 08:30:00
        const date = new TextEncoder().encode('2025:06:17 08:30:00\0');
        const tiff = new Uint8Array(8 + 2 + 12 + 4 + 2 + 12 + 4 + date.length);
        const v = new DataView(tiff.buffer);
        tiff.set([0x4d, 0x4d, 0, 42], 0);
        v.setUint32(4, 8);
        v.setUint16(8, 1);
        v.setUint16(10, 0x8769);
        v.setUint16(12, 4);
        v.setUint32(14, 1);
        v.setUint32(18, 26);
        v.setUint32(22, 0);
        v.setUint16(26, 1);
        v.setUint16(28, 0x9003);
        v.setUint16(30, 2);
        v.setUint32(32, date.length);
        v.setUint32(36, 44);
        v.setUint32(40, 0);
        tiff.set(date, 44);
        const exif = new Uint8Array(10 + tiff.length);
        exif.set([0x45, 0x78, 0x69, 0x66, 0, 0], 0);
        exif.set(tiff, 6);
        const seg = new Uint8Array(4 + exif.length);
        seg.set([0xff, 0xe1], 0);
        new DataView(seg.buffer).setUint16(2, 2 + exif.length);
        seg.set(exif, 4);
        const out = new Uint8Array(2 + seg.length + bytes.length - 2);
        out.set(bytes.subarray(0, 2), 0);
        out.set(seg, 2);
        out.set(bytes.subarray(2), 2 + seg.length);
        return new File([out], 'foto.jpg', { type: 'image/jpeg', lastModified: Date.UTC(2020, 0, 1) });
      };
      await st.addPhotos(section, [await make(1200, 800, '#3366aa'), await make(800, 1200, '#aa6633'), await make(1000, 700, '#33aa66')]);
      st.change('Test', () => (section.perPage = 2));
    });
    const dates = await page.evaluate(() => window.pdfEditor.studio.project.sections.find((s) => s.type === 'photos').items.map((p) => p.date));
    expect(dates).toEqual(['2025-06-17', '2025-06-17', '2025-06-17']);
    const photoPages = page.locator('#studio .sd-page').filter({ hasText: 'Foto 1' });
    await expect(photoPages).toHaveCount(1);
    await expect(page.locator('#studio .sd-page').filter({ hasText: 'Foto 3' })).toHaveCount(1); // 2 je Seite → 2 Seiten
    await expect(photoPages).toContainText('17.06.2025');

    // Verknüpfung mit einem Symbol des Lageplans
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const site = st.project.sections.find((s) => s.type === 'site');
      const photos = st.project.sections.find((s) => s.type === 'photos');
      st.change('Symbol', () => site.symbols.push({ id: 'ysym', kind: 'camera', x: 0.5, y: 0.5, name: { de: 'Einfahrt', en: '' }, note: { de: '', en: '' }, scale: 1, fov: true, dir: 0, angle: 90, range: 60 }));
      st.change('Link', () => (photos.items[0].link = 'ysym'));
    });
    await expect(photoPages).toContainText('K 1 Einfahrt');

    // PDF: Lageplan + Fotos jetzt enthalten, Anschlussplan/Zugangsdaten (leer) nicht
    const b64 = await page.evaluate(async () => {
      const bytes = await window.pdfEditor.studio.buildPdf();
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const pdf = Buffer.from(b64, 'base64');
    const texts = (await extractText(pdf)).join('\n');
    expect(texts).toContain('Lageplan');
    expect(texts).toContain('Fotodokumentation');
    expect(texts).not.toContain('Zugangsdaten  ');
    expect(texts).toContain('Foto 3');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Lageplan: Hintergrund aus Bild und aus PDF-Seite, eigenes Symbol', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await page.locator('.dlg .btn.primary', { hasText: 'Erstellen' }).click();
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      st.select({ kind: 'section', id: st.project.sections.find((s) => s.type === 'site').id });
    });
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 40;
      const g = c.getContext('2d');
      g.fillStyle = '#c33';
      g.fillRect(0, 0, 64, 40);
      return c.toDataURL('image/png').split(',')[1];
    });
    const site = () => page.evaluate(() => {
      const s = window.pdfEditor.studio.project.sections.find((x) => x.type === 'site');
      return { bg: s.bg.image, custom: s.custom.length, images: Object.keys(window.pdfEditor.studio.project.images).length };
    });

    // 1. Bild
    let chooser = page.waitForEvent('filechooser');
    // Hintergrund nur in den Eigenschaften (nicht im Werkzeugband)
    await expect(page.locator('.rb[data-act="bg"]')).toHaveCount(0);
    await page.locator('.sd-bg-acts [data-bg="image"]').click();
    await (await chooser).setFiles({ name: 'karte.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await expect.poll(async () => (await site()).bg).not.toBeNull();
    const first = (await site()).bg;

    // 2. Seite einer PDF
    const doc = await PDFDocument.create();
    const p = doc.addPage([400, 300]);
    p.drawRectangle({ x: 20, y: 20, width: 200, height: 100 });
    doc.addPage([400, 300]);
    const pdf = Buffer.from(await doc.save());
    chooser = page.waitForEvent('filechooser');
    await page.locator('.sd-bg-acts [data-bg="pdf"]').click();
    await (await chooser).setFiles({ name: 'grundriss.pdf', mimeType: 'application/pdf', buffer: pdf });
    await page.locator('.dlg input[type="number"]').fill('2');
    await page.locator('.dlg .btn.primary').click();
    await expect.poll(async () => (await site()).bg).not.toBe(first);
    const bg = await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'site');
      const img = st.project.images[s.bg.image];
      return { mime: img.mime, w: img.w, h: img.h };
    });
    expect(bg.mime).toBe('image/jpeg');
    expect(Math.max(bg.w, bg.h)).toBe(2400);

    // 3. Symbol-Galerie: Symbol wählen, dann eigenes Symbol hochladen
    await page.locator('.rb[data-act="symbols"]').click();
    await expect(page.locator('.sd-gallery .sd-symbol')).toHaveCount(21);
    await page.locator('.sd-gallery .sd-symbol', { hasText: 'Kamera' }).click();
    await expect(page.locator('#sdArm')).toContainText('Kamera');
    await expect(page.locator('.sd-gallery')).toHaveCount(0);
    chooser = page.waitForEvent('filechooser');
    await page.locator('.rb[data-act="symbols"]').click();
    await page.locator('.sd-gallery .mi', { hasText: 'Eigenes Symbol' }).click();
    await (await chooser).setFiles({ name: 'tor.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    await page.locator('.dlg input[type="text"]').fill('Torantrieb');
    await page.locator('.dlg .btn.primary').click();
    await expect.poll(async () => (await site()).custom).toBe(1);
    await expect(page.locator('#sdArm')).toContainText('Torantrieb');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Kapitel: Vorlage, Bausteine, Nummern und Verweise, Seitenumbruch, Verzeichnis, Ersetzen', async ({
  browser,
}) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="tech"]').click();
    await expect(page.locator('#prjTab')).toHaveClass(/on/);
    const toc = page.locator('#studio .sd-page').nth(1);
    await expect(toc).toContainText('1  Aufgabe und Einsatz');
    await expect(toc).toContainText('3  Funktionsbeschreibung');

    // Baustein über das Werkzeugband einfügen und einen Verweis auf Kapitel 2 setzen
    await page.locator('.sd-sec', { has: page.locator('b', { hasText: /^Technische Beschreibung$/ }) }).click();
    await page.locator('.rb[data-act="block"]').click();
    await page.locator('.menu .mi', { hasText: 'Absatz' }).click();
    const ids = await page.evaluate(() => {
      const s = window.pdfEditor.studio.project.sections.find((x) => x.type === 'chapters');
      return { h2: s.blocks[2].id, count: s.blocks.length };
    });
    expect(ids.count).toBe(9);
    const area = page.locator('#sdIBody textarea').first();
    await area.fill('Siehe ');
    await area.press('End');
    await page.locator('#sdIBody select', { hasText: 'Verweis einfügen' }).selectOption(ids.h2);
    await expect(page.locator('#studio .sd-page').nth(2)).toContainText('Siehe Abschnitt 2');

    // Seitenumbruch: viele Absätze – nichts ragt in die Fußzeile, keine Überschrift allein am Seitenende
    const result = await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      const s = st.project.sections.find((x) => x.type === 'chapters');
      st.change('Test', () => {
        for (let i = 0; i < 12; i++) {
          s.blocks.push({ id: 'hh' + i, type: 'h', level: 1, text: { de: 'Kapitel ' + i, en: '' } });
          s.blocks.push({ id: 'pp' + i, type: 'p', text: { de: 'Zeile mit Text. '.repeat(300), en: '' } });
        }
      });
      st.renderPages();
      const pages = st.doc.pages.filter((p) => p.kind === 'chapters');
      const kinds = new Map(s.blocks.map((b) => [b.id, b.type]));
      const lastIsHeading = pages.slice(0, -1).some((p) => {
        const last = p.hits.filter((h) => h.kind === 'block').at(-1);
        return last && kinds.get(last.id) === 'h';
      });
      const bottom = Math.max(...pages.flatMap((p) => p.hits.map((h) => h.rect[1] + h.rect[3])));
      const tocPages = st.doc.pages.filter((p) => p.kind === 'toc').length;
      return { pages: pages.length, lastIsHeading, bottom, tocPages };
    });
    expect(result.pages).toBeGreaterThan(5);
    expect(result.lastIsHeading).toBe(false);
    expect(result.bottom).toBeLessThanOrEqual(770.5);
    expect(result.tocPages).toBeGreaterThanOrEqual(1);

    // Suchen und Ersetzen über alle Kapitel, rückgängig machbar
    await page.keyboard.press('Control+h');
    await page.locator('.dlg input[data-k="find"]').fill('Kapitel');
    await page.locator('.dlg input[data-k="repl"]').fill('Teil');
    await expect(page.locator('.sd-find-n')).toContainText('12 Treffer');
    await page.locator('.dlg .btn.primary').click();
    await expect(page.locator('#studio .sd-page', { hasText: 'Teil 3' }).first()).toBeVisible();
    await page.keyboard.press('Control+z');
    await expect(page.locator('#studio .sd-page', { hasText: 'Kapitel 3' }).first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Anleitung: Tabelle bearbeiten, Abbildung per Drag & Drop, Störungstabelle', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="tech"]').click();
    await page.locator('.sd-sec', { has: page.locator('b', { hasText: /^Technische Beschreibung$/ }) }).click();
    await page.locator('.rb[data-act="block"]').click();
    await page.locator('.menu .mi', { hasText: 'Störungstabelle' }).click();
    const cell = page.locator('#sdIBody .sd-grid input').nth(3);
    await cell.fill('Kein Strom');
    await page.locator('#sdIBody .btn', { hasText: 'Zeile' }).first().click();
    await page.locator('#sdIBody .sd-grid input').nth(7).fill('Sicherung prüfen');
    const table = await page.evaluate(() => {
      const s = window.pdfEditor.studio.project.sections.find((x) => x.type === 'chapters');
      const b = s.blocks.at(-1);
      return { head: b.head, rows: b.rows };
    });
    expect(table.head).toEqual(['Störung', 'Mögliche Ursache', 'Abhilfe']);
    expect(table.rows[0][0]).toBe('Kein Strom');
    expect(table.rows.length).toBe(2);
    await expect(page.locator('#studio .sd-page', { hasText: 'Sicherung prüfen' }).first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

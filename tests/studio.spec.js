/**
 * „Dokumentation erstellen“: Anschlussplan wie das Vorbild, Bedienung (Auswahl, Ziehen, Rückgängig,
 * Eigenschaften, Sprache), Entwürfe und die PDF mit eingebettetem Projekt. Nur gegen den Neubau.
 */
import { test, expect } from '@playwright/test';
import { PDFDocument, PDFName } from 'pdf-lib';
import { launch, extractText } from './helpers.js';

async function openExample(page) {
  await page.locator('.tpl[data-tpl="example"]').click();
  await expect(page.locator('#studio .sd-page')).toHaveCount(2);
  await expect(page.locator('#prjTab')).toHaveClass(/on/);
}

test('Beispiel „Zufallsgenerator“: Lage aller Teile wie im Vorbild', async ({ browser }) => {
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
    await expect(page.locator('.rb[data-act="lang"]')).toContainText('Deutsch und Englisch');

    // Entwurf: auf der Startseite unter „Dokumentationen“, von dort wieder zu öffnen
    await page.locator('#tHome').click();
    await page.locator('.hs-tabs [data-list="drafts"]').click();
    const row = page.locator('#recentList .ri', { hasText: 'Anschlussplan Zufallsgenerator' });
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
    expect(doc.getTitle()).toBe('Anschlussplan Zufallsgenerator');
    expect(doc.catalog.has(PDFName.of('PDFixProject'))).toBe(true);
    const [p1, p2] = await extractText(bytes);
    expect(p1).toContain('Zufallsgenerator - Übersicht der Anschlüsse');
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
    // beide Reiter bleiben offen: zurück zur PDF
    await page.locator('#docTab').click();
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
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await page.locator('.sd-sec', { has: page.locator('b', { hasText: /^Zugangsdaten$/ }) }).click();
    await page.locator('.rb[data-act="device"]').click();
    await page.locator('#sdIBody input').first().fill('Rekorder (NVR)');
    const field = (label) => page.locator('.sd-f', { hasText: label }).locator('input').first();
    await field('IP-Adresse').fill('192.168.10.20');
    await field('Benutzer').fill('admin');
    await field('Passwort').fill('Geheim#2026');
    await expect(page.locator('#studio .sd-page').nth(3)).toContainText('192.168.10.20');
    await expect(page.locator('#studio .sd-page').nth(3)).not.toContainText('Geheim#2026');

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
    await page.locator('.tpl[data-tpl="documentation"]').click();
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

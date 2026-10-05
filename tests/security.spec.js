/**
 * Sicherheit: aktive PDF-Inhalte beim Speichern (Schalter) und Grenze beim Entpacken.
 * Nur gegen den Neubau.
 */
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';
import { launch, openPdf, idle, savedBytes, extractText } from './helpers.js';

const N = (name) => PDFName.of(name);

/** PDF mit JavaScript-Start, Launch-Link, Web-Link, Anhang, Seiten-Aktion und Datei-Anmerkung. */
async function activePdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Datenblatt Zulieferer', { x: 50, y: 780, size: 20, font });
  const ctx = doc.context;
  const action = (dict) => ctx.register(ctx.obj(dict));
  doc.catalog.set(
    N('OpenAction'),
    action({ Type: 'Action', S: 'JavaScript', JS: PDFString.of('app.alert(1)') }),
  );
  doc.catalog.set(N('AA'), ctx.obj({ WC: action({ S: 'JavaScript', JS: PDFString.of('x') }) }));
  page.node.set(N('AA'), ctx.obj({ O: action({ S: 'JavaScript', JS: PDFString.of('y') }) }));
  const launch = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [50, 700, 200, 720],
      A: { S: 'Launch', F: PDFString.of('calc.exe') },
    }),
  );
  const web = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [50, 650, 200, 670],
      A: { S: 'URI', URI: PDFString.of('https://example.org/') },
    }),
  );
  const chained = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [50, 600, 200, 620],
      A: {
        S: 'URI',
        URI: PDFString.of('https://example.org/2'),
        Next: { S: 'JavaScript', JS: PDFString.of('z') },
      },
    }),
  );
  const attachment = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'FileAttachment',
      Rect: [50, 550, 70, 570],
      Contents: PDFString.of('Beilage'),
    }),
  );
  page.node.set(N('Annots'), ctx.obj([launch, web, chained, attachment]));
  await doc.attach(Buffer.from('GEHEIME-NUTZLAST'), 'beilage.exe', { mimeType: 'application/octet-stream' });
  return doc.save({ useObjectStreams: false });
}

async function inspect(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const names = doc.catalog.lookup(N('Names'));
  const page = doc.getPage(0);
  const annots = page.node.lookup(N('Annots'));
  const subtypeAndAction = [];
  if (annots instanceof PDFArray)
    for (let i = 0; i < annots.size(); i++) {
      const annot = annots.lookup(i, PDFDict);
      const action = annot.lookup(N('A'));
      subtypeAndAction.push(
        annot.lookup(N('Subtype')).decodeText() +
          ':' +
          (action instanceof PDFDict ? action.lookup(N('S')).decodeText() : '-'),
      );
    }
  return {
    openAction: doc.catalog.has(N('OpenAction')),
    docAA: doc.catalog.has(N('AA')),
    pageAA: page.node.has(N('AA')),
    embedded: !!(names && names.has(N('EmbeddedFiles'))),
    annots: subtypeAndAction,
    payloadInFile:
      Buffer.from(bytes).includes('GEHEIME-NUTZLAST') ||
      Buffer.from(bytes).includes(deflateSync(Buffer.from('GEHEIME-NUTZLAST'))),
    text: (await extractText(bytes))[0],
  };
}

test('Aktive Inhalte werden beim Speichern entfernt – Web-Links und Text bleiben', async ({ browser }) => {
  const { page, context } = await launch(browser, 'neubau');
  await openPdf(page, await activePdf(), 'aktiv.pdf');
  expect(await page.evaluate(() => window.pdfEditor.stripActive)).toBe(true);

  const saved = await inspect(await savedBytes(page));
  expect(saved.openAction).toBe(false);
  expect(saved.docAA).toBe(false);
  expect(saved.pageAA).toBe(false);
  expect(saved.embedded).toBe(false);
  expect(saved.payloadInFile).toBe(false);
  // Launch-Link: Anmerkung bleibt, Aktion weg; Web-Link bleibt; Web-Link mit angehängtem Skript: Aktion weg;
  // Datei-Anmerkung ganz entfernt
  expect(saved.annots).toEqual(['Link:-', 'Link:URI', 'Link:-']);
  expect(saved.text).toContain('Datenblatt Zulieferer');

  // Meldung nennt, was entfernt wurde
  const messages = await page.evaluate(() => window.__toastLog);
  expect(messages.join(' ')).toMatch(
    /Aktive Inhalte entfernt: 4 Skripte, 1 Programmstart oder Medium, 2 Anhänge\./,
  );
  await context.close();
});

test('Entfernen gilt nur für den Speichervorgang: Dokument im Speicher bleibt unverändert', async ({
  browser,
}) => {
  const { page, context } = await launch(browser, 'neubau');
  await openPdf(page, await activePdf(), 'aktiv.pdf');
  await savedBytes(page); // mit Schalter an
  await page.evaluate(() => window.pdfEditor.toggleStripActive(false));
  const kept = await inspect(await savedBytes(page));
  expect(kept.openAction).toBe(true);
  expect(kept.docAA).toBe(true);
  expect(kept.pageAA).toBe(true);
  expect(kept.embedded).toBe(true);
  expect(kept.annots).toEqual(['Link:Launch', 'Link:URI', 'Link:URI', 'FileAttachment:-']);
  expect(await page.evaluate(() => window.pdfEditor.session.dirty)).toBe(false);
  await context.close();
});

test('Schalter im Datei-Menü: Zustand wird gemerkt', async ({ browser }) => {
  const { page, context } = await launch(browser, 'neubau');
  const item = () => page.locator('.menu .mi', { hasText: 'Aktive Inhalte beim Speichern entfernen' });
  await page.locator('#bFile').click();
  await expect(item()).toHaveAttribute('aria-checked', 'true');
  await item().click();
  await page.locator('#bFile').click();
  await expect(item()).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('Escape');
  await page.reload();
  await page.waitForFunction(() => window.pdfEditor && window.pdfEditor.library.items.size >= 10);
  expect(await page.evaluate(() => window.pdfEditor.stripActive)).toBe(false);
  await context.close();
});

/** Seite, deren Inhalt entpackt weit über der Grenze liegt (400 KB gepackt → 100 MB). */
async function bombPdf() {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const packed = deflateSync(Buffer.alloc(100 * 1024 * 1024, 0x20), { level: 9 });
  const stream = doc.context.stream(packed, { Filter: 'FlateDecode', Length: packed.length });
  page.node.set(N('Contents'), doc.context.register(stream));
  return doc.save({ useObjectStreams: false });
}

test('Zu großer Seiteninhalt: kein Hänger, Seite bleibt unverändert und nicht bearbeitbar', async ({
  browser,
}) => {
  const { page, context } = await launch(browser, 'neubau');
  const t0 = Date.now();
  await openPdf(page, await bombPdf(), 'bombe.pdf');
  const model = await page.evaluate(() => {
    const m = window.pdfEditor.session.model(0);
    return { unreadable: m.unreadable, blocks: m.blocks.length, objects: m.objects.length };
  });
  expect(model).toEqual({ unreadable: true, blocks: 0, objects: 0 });
  expect(Date.now() - t0).toBeLessThan(20_000);

  // Eine Bearbeitung scheitert mit klarer Fehlerart und überschreibt nichts
  const before = createHash('sha256')
    .update(await savedBytes(page))
    .digest('hex');
  const outcome = await page.evaluate(async () => {
    try {
      await window.pdfEditor.session.appendRaw(0, 'q Q', 'Test');
      return 'ok';
    } catch (err) {
      return err.name;
    }
  });
  expect(outcome).toBe('StreamTooLargeError');
  await idle(page);
  expect(
    createHash('sha256')
      .update(await savedBytes(page))
      .digest('hex'),
  ).toBe(before);
  await context.close();
});

test('Normal große Seiteninhalte (unter der Grenze) bleiben bearbeitbar', async ({ browser }) => {
  const { page, context } = await launch(browser, 'neubau');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText('Normaler Text', { x: 50, y: 700, size: 14, font });
  // 20 MB Leerraum im Inhalt: groß, aber erlaubt
  const extra = doc.context.flateStream(Buffer.alloc(20 * 1024 * 1024, 0x20));
  const contents = p.node.lookup(N('Contents'));
  p.node.set(
    N('Contents'),
    doc.context.obj([
      ...(contents instanceof PDFArray ? contents.asArray() : [p.node.get(N('Contents'))]),
      doc.context.register(extra),
    ]),
  );
  await openPdf(page, await doc.save({ useObjectStreams: false }), 'gross.pdf');
  const model = await page.evaluate(() => {
    const m = window.pdfEditor.session.model(0);
    return { unreadable: m.unreadable, text: m.blocks.map((b) => b.text) };
  });
  expect(model.unreadable).toBe(false);
  expect(model.text).toContain('Normaler Text');
  await context.close();
});

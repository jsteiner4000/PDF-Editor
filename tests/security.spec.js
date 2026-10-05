/**
 * Sicherheit: aktive PDF-Inhalte beim Speichern (Schalter) und Grenze beim Entpacken.
 * Nur gegen den Neubau.
 */
import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import {
  PDFArray,
  PDFContext,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFRawStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib';
import { launch, openPdf, idle, savedBytes, extractText } from './helpers.js';
import { assertDecodedSize, lzwDecodedLength } from '../src/pdf/stream-limit.js';

const N = (name) => PDFName.of(name);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const LIMIT = 16 * 1024 * 1024;

/** Alle Objekte (auch aus Objekt-Streams) als Klartext – zum Suchen nach Resten. */
async function plainText(bytes) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  return Buffer.from(await doc.save({ useObjectStreams: false })).toString('latin1');
}

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
  const annot = (dict) => ctx.register(ctx.obj({ Type: 'Annot', ...dict }));
  const launch = annot({
    Subtype: 'Link',
    Rect: [50, 700, 200, 720],
    A: { S: 'Launch', F: PDFString.of('calc.exe') },
  });
  const web = annot({
    Subtype: 'Link',
    Rect: [50, 650, 200, 670],
    A: { S: 'URI', URI: PDFString.of('https://example.org/') },
  });
  const chained = annot({
    Subtype: 'Link',
    Rect: [50, 600, 200, 620],
    A: {
      S: 'URI',
      URI: PDFString.of('https://example.org/2'),
      Next: { S: 'JavaScript', JS: PDFString.of('z') },
    },
  });
  const attachment = annot({
    Subtype: 'FileAttachment',
    Rect: [50, 550, 70, 570],
    Contents: PDFString.of('Beilage'),
    FS: ctx.register(
      ctx.obj({
        Type: 'Filespec',
        F: PDFString.of('anmerkung.bin'),
        EF: { F: ctx.register(ctx.stream(Buffer.from('ANMERKUNGS-NUTZLAST'))) },
      }),
    ),
  });
  page.node.set(N('Annots'), ctx.obj([launch, web, chained, attachment]));
  await doc.attach(Buffer.from('GEHEIME-NUTZLAST'), 'beilage.exe', { mimeType: 'application/octet-stream' });
  return doc.save({ useObjectStreams: false });
}

const entries = (dict) => (dict instanceof PDFDict ? dict.keys().length : 0) > 0;

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
    // /AA darf als leeres Wörterbuch bleiben; entscheidend ist, dass kein Eintrag (Aktion) übrig ist
    docAA: entries(doc.catalog.lookup(N('AA'))),
    pageAA: entries(page.node.lookup(N('AA'))),
    embedded: !!(names && names.has(N('EmbeddedFiles'))),
    annots: subtypeAndAction,
    text: (await extractText(bytes))[0],
  };
}

test('Aktive Inhalte werden beim Speichern entfernt – Web-Links und Text bleiben', async ({ browser }) => {
  const { page, context } = await launch(browser, 'neubau');
  await openPdf(page, await activePdf(), 'aktiv.pdf');
  expect(await page.evaluate(() => window.pdfEditor.stripActive)).toBe(true);

  const bytes = await savedBytes(page);
  const saved = await inspect(bytes);
  expect(saved.openAction).toBe(false);
  expect(saved.docAA).toBe(false);
  expect(saved.pageAA).toBe(false);
  expect(saved.embedded).toBe(false);
  // Launch-Link: Anmerkung bleibt, Aktion weg; Web-Link bleibt; Web-Link mit angehängtem Skript:
  // Link bleibt, nur das Skript in /Next ist weg; Datei-Anmerkung ganz entfernt
  expect(saved.annots).toEqual(['Link:-', 'Link:URI', 'Link:URI']);
  expect(saved.text).toContain('Datenblatt Zulieferer');
  const text = await plainText(bytes);
  for (const rest of [
    '/JavaScript',
    '/Launch',
    'GEHEIME-NUTZLAST',
    'ANMERKUNGS-NUTZLAST',
    '/EmbeddedFile',
    '/FileAttachment',
  ])
    expect(text, rest).not.toContain(rest);
  expect(text).toContain('https://example.org/2');
  await context.close();
});

test('Meldung nennt, was entfernt wurde – nur wenn es etwas gab', async ({ browser }) => {
  const { page, context } = await launch(browser, 'neubau');
  const announce = () =>
    page.evaluate(async () => {
      await window.pdfEditor.bytesForSave();
      window.pdfEditor.announceStripped();
      await new Promise((resolve) => setTimeout(resolve, 100)); // Meldung wird asynchron mitgeschrieben
      return window.__toastLog.filter((t) => t.startsWith('Aktive Inhalte entfernt'));
    });
  await openPdf(page); // Standard-Fixture ohne aktive Inhalte
  expect(await announce()).toEqual([]);
  await openPdf(page, await activePdf(), 'aktiv.pdf');
  expect(await announce()).toEqual([
    'Aktive Inhalte entfernt: 4 Skripte, 1 Programmstart oder Medium, 2 Anhänge.',
  ]);
  await context.close();
});

/**
 * Korpus für Stellen, die nicht auf der Hand liegen: Lesezeichen mit Aktionen, Popup mit
 * /Parent auf eine Datei-Anmerkung (Nutzlast bleibt sonst erreichbar), /AF an Anmerkungen,
 * gemischte /AA, Startansicht mit angehängtem Skript, JavaScript-Namensbaum, XFA.
 */
async function trickyPdf() {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.drawText('Formular mit Tricks', { x: 50, y: 780, size: 20, font });
  const ctx = doc.context;
  const reg = (dict) => ctx.register(ctx.obj(dict));
  const payload = (text) => ctx.register(ctx.stream(Buffer.from(text)));
  const filespec = (text) => reg({ Type: 'Filespec', F: PDFString.of('x.bin'), EF: { F: payload(text) } });

  // Lesezeichen: eines mit JavaScript, eines mit Launch, eines mit URI
  const bookmarkJs = reg({ Title: PDFString.of('Skript'), A: { S: 'JavaScript', JS: PDFString.of('1') } });
  const bookmarkLaunch = reg({ Title: PDFString.of('Start'), A: { S: 'Launch', F: PDFString.of('a.exe') } });
  const bookmarkWeb = reg({
    Title: PDFString.of('Web'),
    A: { S: 'URI', URI: PDFString.of('https://example.org/bookmark') },
  });
  const outlines = reg({ Type: 'Outlines', First: bookmarkJs, Last: bookmarkWeb, Count: 3 });
  for (const ref of [bookmarkJs, bookmarkLaunch, bookmarkWeb]) ctx.lookup(ref).set(N('Parent'), outlines);
  ctx.lookup(bookmarkJs).set(N('Next'), bookmarkLaunch);
  ctx.lookup(bookmarkLaunch).set(N('Next'), bookmarkWeb);
  ctx.lookup(bookmarkLaunch).set(N('Prev'), bookmarkJs);
  ctx.lookup(bookmarkWeb).set(N('Prev'), bookmarkLaunch);
  doc.catalog.set(N('Outlines'), outlines);

  // Datei-Anmerkung mit Popup, das per /Parent darauf zeigt; Anhang auch über /AF an einer Anmerkung
  const fileAnnot = reg({
    Type: 'Annot',
    Subtype: 'FileAttachment',
    Rect: [10, 10, 30, 30],
    FS: filespec('NUTZLAST-ANMERKUNG'),
  });
  const popup = reg({ Type: 'Annot', Subtype: 'Popup', Rect: [40, 10, 140, 60], Parent: fileAnnot });
  ctx.lookup(fileAnnot).set(N('Popup'), popup);
  const square = reg({
    Type: 'Annot',
    Subtype: 'Square',
    Rect: [10, 100, 60, 150],
    AF: ctx.obj([filespec('NUTZLAST-AF')]),
  });
  // gemischte /AA: Berechnung (JavaScript) und Fokus-Sprung (URI) im selben Feld
  const widget = reg({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Tx',
    T: PDFString.of('feld'),
    Rect: [100, 100, 200, 120],
    AA: {
      C: { S: 'JavaScript', JS: PDFString.of('event.value=1') },
      Fo: { S: 'URI', URI: PDFString.of('https://example.org/fokus') },
    },
  });
  page.node.set(N('Annots'), ctx.obj([fileAnnot, popup, square, widget]));
  doc.catalog.set(
    N('AcroForm'),
    ctx.obj({ Fields: [widget], XFA: ctx.obj([PDFString.of('xdp'), payload('XFA-SKRIPT')]) }),
  );
  // Startansicht (GoTo) mit angehängtem Skript: Ansicht bleibt, Skript geht
  doc.catalog.set(
    N('OpenAction'),
    ctx.obj({ S: 'GoTo', D: [page.ref, N('Fit')], Next: { S: 'JavaScript', JS: PDFString.of('boese()') } }),
  );
  // Namensbaum mit JavaScript
  const jsAction = reg({ S: 'JavaScript', JS: PDFString.of('baum()') });
  doc.catalog.set(N('Names'), ctx.obj({ JavaScript: { Names: [PDFString.of('start'), jsAction] } }));
  return doc.save({ useObjectStreams: false });
}

test('Aktive Inhalte an versteckten Stellen: Lesezeichen, Popup-Parent, /AF, gemischte /AA, Startansicht', async ({
  browser,
}) => {
  const { page, context } = await launch(browser, 'neubau');
  await openPdf(page, await trickyPdf(), 'tricks.pdf');
  await page.evaluate(() => window.pdfEditor.toggleStripActive(false));
  const kept = await plainText(await savedBytes(page));
  for (const marker of ['/JavaScript', '/Launch', 'NUTZLAST-ANMERKUNG', 'NUTZLAST-AF', 'XFA-SKRIPT'])
    expect(kept, `Schalter aus: ${marker} bleibt`).toContain(marker);

  await page.evaluate(() => window.pdfEditor.toggleStripActive(true));
  const bytes = await savedBytes(page);
  const text = await plainText(bytes);
  for (const marker of [
    '/JavaScript',
    '/Launch',
    'NUTZLAST-ANMERKUNG',
    'NUTZLAST-AF',
    'XFA-SKRIPT',
    'boese()',
    'event.value',
    'baum()',
  ])
    expect(text, `Schalter an: ${marker} ist weg`).not.toContain(marker);
  // Harmloses bleibt: URI-Lesezeichen, URI-Eintrag der gemischten /AA, Startansicht (GoTo), Text
  for (const marker of ['https://example.org/bookmark', 'https://example.org/fokus', '/GoTo', '/Fit'])
    expect(text, `Schalter an: ${marker} bleibt`).toContain(marker);
  expect((await extractText(bytes))[0]).toContain('Formular mit Tricks');

  // Das Dokument im Speicher blieb unverändert: Speichern mit Schalter aus enthält wieder alles
  await page.evaluate(() => window.pdfEditor.toggleStripActive(false));
  const again = await plainText(await savedBytes(page));
  for (const marker of ['/JavaScript', '/Launch', 'NUTZLAST-ANMERKUNG', 'NUTZLAST-AF', 'boese()'])
    expect(again, `nach dem Speichern mit Schalter an: ${marker} noch im Speicher`).toContain(marker);
  await context.close();
});

test('Strukturelemente mit Aktions-Namen (/S /Sound) sind keine Aktionen und bleiben erhalten', async ({
  browser,
}) => {
  const { page, context } = await launch(browser, 'neubau');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText('Getaggt', { x: 50, y: 780, size: 20, font });
  const ctx = doc.context;
  const element = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Sound', P: p.ref }));
  const root = ctx.register(ctx.obj({ Type: 'StructTreeRoot', K: [element] }));
  ctx.lookup(element).set(N('P'), root);
  doc.catalog.set(N('StructTreeRoot'), root);
  await openPdf(page, await doc.save({ useObjectStreams: false }), 'getaggt.pdf');
  const text = await plainText(await savedBytes(page));
  expect(text).toContain('/StructElem');
  expect(text).toMatch(/\/S \/Sound/);
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

test('Fehler mitten im Speichern: das Dokument wird trotzdem vollständig wiederhergestellt', async ({
  browser,
}) => {
  const { page, context } = await launch(browser, 'neubau');
  await openPdf(page, await activePdf(), 'aktiv.pdf');
  const result = await page.evaluate(async () => {
    const app = window.pdfEditor;
    const plain = { clean: false, strip: false };
    const before = (await app.session.save(plain)).length;
    // Serialisierung schlägt fehl, nachdem alles entfernt wurde
    const original = app.session.doc.save;
    app.session.doc.save = () => Promise.reject(new Error('Testfehler'));
    let failed = false;
    try {
      await app.session.save({ clean: false, strip: true });
    } catch {
      failed = true;
    }
    app.session.doc.save = original;
    return { failed, same: (await app.session.save(plain)).length === before };
  });
  expect(result).toEqual({ failed: true, same: true });
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

/** Seite mit einem Content-Stream aus `packed` (zlib-Daten). */
async function pdfWithContent(packed) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const stream = doc.context.stream(packed, { Filter: 'FlateDecode', Length: packed.length });
  page.node.set(N('Contents'), doc.context.register(stream));
  return doc.save({ useObjectStreams: false });
}

/** Seite, deren Inhalt entpackt weit über der Grenze liegt (400 KB gepackt → 100 MB). */
const bombPdf = () => pdfWithContent(deflateSync(Buffer.alloc(100 * 1024 * 1024, 0x20), { level: 9 }));

/** Dieselbe Bombe mit ungültiger Fenstergröße im zlib-Kopf (CINFO 8): pdf-lib entpackt sie trotzdem. */
function badWindowBomb() {
  const packed = Buffer.from(deflateSync(Buffer.alloc(100 * 1024 * 1024, 0x20), { level: 9 }));
  packed[0] = 0x88;
  packed[1] = (31 - ((0x88 << 8) % 31)) % 31;
  return pdfWithContent(packed);
}

async function expectUnreadable(browser, bytes) {
  const { page, context } = await launch(browser, 'neubau');
  const t0 = Date.now();
  await openPdf(page, bytes, 'bombe.pdf');
  const model = await page.evaluate(() => {
    const m = window.pdfEditor.session.model(0);
    return { unreadable: m.unreadable, blocks: m.blocks.length, objects: m.objects.length };
  });
  expect(model).toEqual({ unreadable: true, blocks: 0, objects: 0 });
  expect(Date.now() - t0).toBeLessThan(20_000);
  // Hinweis beim Öffnen (einmal gesammelt), kein Hänger
  await page.waitForFunction(() => window.__toastLog.some((t) => t.includes('kann nicht bearbeitet')));
  const notes = await page.evaluate(() =>
    window.__toastLog.filter((t) => t.includes('kann nicht bearbeitet')),
  );
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain('Seite 1 kann nicht bearbeitet werden');
  return { page, context };
}

test('Zu großer Seiteninhalt: kein Hänger, Hinweis, Seite bleibt unverändert und nicht bearbeitbar', async ({
  browser,
}) => {
  const { page, context } = await expectUnreadable(browser, await bombPdf());

  const before = sha(await savedBytes(page));
  const outcomes = await page.evaluate(async () => {
    const session = window.pdfEditor.session;
    const results = {};
    for (const [name, fn] of Object.entries({
      appendRaw: () => session.appendRaw(0, 'q Q', 'Test'),
      beginEdit: () => session.beginEdit(0, null),
      insertImage: () => session.insertImage(0, new Uint8Array([1]), 'image/png', [0, 0, 10, 10]),
    }))
      try {
        await fn();
        results[name] = 'ok';
      } catch (err) {
        results[name] = err.name;
      }
    return { results, dirty: session.dirty, pending: session.pending };
  });
  expect(outcomes.results).toEqual({
    appendRaw: 'StreamTooLargeError',
    beginEdit: 'StreamTooLargeError',
    insertImage: 'StreamTooLargeError',
  });
  expect(outcomes.dirty).toBe(false);
  expect(outcomes.pending).toBeNull();
  await idle(page);
  // auch Bild und Ressourcen wurden nicht angelegt: die Datei ist byte-gleich
  expect(sha(await savedBytes(page))).toBe(before);

  // Bedienung: Text-Werkzeug, Bild und Unterschrift fragen das vorher ab und melden es verständlich
  const ui = await page.evaluate(async () => {
    const app = window.pdfEditor;
    const editable = app.edit.pageEditable(app.pvs[0]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    return { editable, toasts: window.__toastLog.filter((t) => t.includes('kann nicht bearbeitet')).length };
  });
  expect(ui).toEqual({ editable: false, toasts: 2 });
  await context.close();
});

/** Seite mit rohem Inhalt `content` (Schrift F1 vorhanden). */
async function textPdf(content) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([595, 842]);
  page.node.set(N('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
  page.node.set(N('Contents'), doc.context.register(doc.context.flateStream(Buffer.from(content))));
  return doc.save({ useObjectStreams: false });
}

async function modelAfterOpen(browser, bytes) {
  const { page, context } = await launch(browser, 'neubau');
  // ohne auf die Darstellung zu warten: pdf.js braucht für solche Seiten sehr lange (nicht Thema hier)
  await page.evaluate(
    (b64) =>
      window.pdfEditor.openBytes(
        Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
        'komplex.pdf',
        null,
      ),
    Buffer.from(bytes).toString('base64'),
  );
  const result = await page.evaluate(() => {
    const t = performance.now();
    try {
      const m = window.pdfEditor.session.model(0);
      return { ok: true, unreadable: m.unreadable, blocks: m.blocks.length, ms: performance.now() - t };
    } catch (err) {
      return { ok: false, error: err.name };
    }
  });
  await context.close();
  return result;
}

test('Zu viele Befehle, Zeichen oder absurde Einzelwerte: Seite nur zum Ansehen, kein Absturz', async ({
  browser,
}) => {
  // 3 Millionen Befehle (nur 6 MB roh, wenige KB gepackt)
  expect(await modelAfterOpen(browser, await textPdf('q '.repeat(3_000_000)))).toMatchObject({
    ok: true,
    unreadable: true,
  });
  // 120 000 winzige Textstücke an derselben Stelle: über der Zeichen-Obergrenze
  const overlapping = (n) => Array.from({ length: n }, () => 'BT /F1 8 Tf (a) Tj ET').join('\n');
  expect(await modelAfterOpen(browser, await textPdf(overlapping(120_000)))).toMatchObject({
    ok: true,
    unreadable: true,
  });
  // riesiges TJ-Array und riesiger String (Stapel-/Speicherüberlauf in der Auswertung)
  const tj = 'BT /F1 10 Tf 50 700 Td [' + '(a) 5 '.repeat(600_000) + '] TJ ET';
  expect(await modelAfterOpen(browser, await textPdf(tj))).toMatchObject({ ok: true, unreadable: true });
});

test('Viele übereinanderliegende Textstücke: Auswertung bleibt in Sekunden (nicht quadratisch)', async ({
  browser,
}) => {
  const content = Array.from({ length: 30_000 }, () => 'BT /F1 8 Tf (a) Tj ET').join('\n');
  const result = await modelAfterOpen(browser, await textPdf(content));
  expect(result.ok).toBe(true);
  expect(result.unreadable).toBe(false); // unter den Obergrenzen: weiter bearbeitbar
  expect(result.ms).toBeLessThan(15_000); // vorher: über 20 Sekunden
});

test('Bombe mit ungültiger Fenstergröße im zlib-Kopf wird ebenfalls begrenzt', async ({ browser }) => {
  const { context } = await expectUnreadable(browser, await badWindowBomb());
  await context.close();
});

/** ASCII85-Kodierung (nur für den Test). */
function ascii85(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 4) {
    const chunk = Buffer.alloc(4);
    bytes.copy(chunk, 0, i, Math.min(i + 4, bytes.length));
    let value = chunk.readUInt32BE(0);
    const group = [];
    for (let k = 0; k < 5; k++) {
      group.unshift(String.fromCharCode((value % 85) + 33));
      value = Math.floor(value / 85);
    }
    out += group.slice(0, Math.min(4, bytes.length - i) + 1).join('');
  }
  return out + '~>';
}

/** Seitentext, der sich schlecht komprimieren lässt: Zufallswörter. */
function randomContent(lines) {
  let seed = 7;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const word = () =>
    Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(rnd() * 26))).join('');
  const out = ['BT', '/F1 8 Tf'];
  for (let i = 0; i < lines; i++)
    out.push(`1 0 0 1 ${20 + (i % 30) * 15} ${800 - (i % 90) * 8} Tm (${word()} ${word()}) Tj`);
  out.push('ET');
  return out.join('\n');
}

test('Legitime Seiten mit ASCII85+Flate (alte Distiller-Dateien) bleiben bearbeitbar', async ({
  browser,
}) => {
  const { page, context } = await launch(browser, 'neubau');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.node.set(N('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
  const content = 'BT /F1 14 Tf 50 800 Td (Distiller Seite) Tj ET\n' + randomContent(4000);
  const raw = ascii85(deflateSync(Buffer.from(content)));
  expect(raw.length).toBeGreaterThan(20_000); // über der Schwelle, ab der gezählt werden muss
  const stream = doc.context.stream(Buffer.from(raw, 'latin1'), {
    Filter: ['ASCII85Decode', 'FlateDecode'],
    Length: raw.length,
  });
  p.node.set(N('Contents'), doc.context.register(stream));
  await openPdf(page, await doc.save({ useObjectStreams: false }), 'distiller.pdf');
  const model = await page.evaluate(() => {
    const m = window.pdfEditor.session.model(0);
    return { unreadable: m.unreadable, text: m.blocks.map((b) => b.text).join('|') };
  });
  expect(model.unreadable).toBe(false);
  expect(model.text).toContain('Distiller Seite');
  await context.close();
});

test('Normal große Seiteninhalte (unter der Grenze) bleiben bearbeitbar', async ({ browser }) => {
  const { page, context } = await launch(browser, 'neubau');
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([595, 842]);
  p.drawText('Normaler Text', { x: 50, y: 700, size: 14, font });
  // 5 MB Leerraum im Inhalt: groß, aber erlaubt
  const extra = doc.context.flateStream(Buffer.alloc(5 * 1024 * 1024, 0x20));
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

/** LZW-Kodierung im PDF-Format mit EarlyChange 1 (nur für den Test). */
function lzwEncode(data, early = 1) {
  const bits = [];
  const put = (code, length) => {
    for (let i = length - 1; i >= 0; i--) bits.push((code >> i) & 1);
  };
  let table = new Map();
  const reset = () => {
    table = new Map();
    for (let i = 0; i < 256; i++) table.set(String.fromCharCode(i), i);
  };
  reset();
  let next = 258;
  let length = 9;
  put(256, length);
  let current = '';
  for (const byte of data) {
    const symbol = String.fromCharCode(byte);
    if (table.has(current + symbol)) {
      current += symbol;
      continue;
    }
    put(table.get(current), length);
    table.set(current + symbol, next++);
    if (next >= 4094) {
      put(256, length);
      reset();
      next = 258;
      length = 9;
    } else if (next + early - 1 >= 1 << length) length++; // der Entpacker liegt einen Eintrag zurück
    current = symbol;
  }
  if (current) put(table.get(current), length);
  put(257, length);
  while (bits.length % 8) bits.push(0);
  const out = Buffer.alloc(bits.length / 8);
  bits.forEach((bit, i) => (out[i >> 3] |= bit << (7 - (i & 7))));
  return out;
}

test('LZW-Längenzähler stimmt mit dem Entpacker von pdf-lib überein und begrenzt Bomben', () => {
  const samples = [
    Buffer.from('Hallo Welt, Hallo Welt, Hallo Welt'),
    Buffer.alloc(50_000, 0x41),
    Buffer.from(Array.from({ length: 20_000 }, (_, i) => (i * 7919 + (i >> 3)) & 0xff)),
    Buffer.from(randomContent(1500)),
  ];
  const ctx = PDFContext.create();
  for (const data of samples) {
    const packed = lzwEncode(data);
    const stream = PDFRawStream.of(ctx.obj({ Filter: 'LZWDecode' }), packed);
    expect(Buffer.from(decodePDFRawStream(stream).decode()).equals(data)).toBe(true); // Testkodierer stimmt
    expect(lzwDecodedLength(packed, 1)).toBe(data.length);
  }
  // Bombe: 6 MB gleiche Bytes bei einer Grenze von 1 MB → bricht ab
  const small = 1024 * 1024;
  const bomb = lzwEncode(Buffer.alloc(6 * 1024 * 1024, 0x20));
  expect(() => lzwDecodedLength(bomb, 1, small)).toThrow(/zu groß/);
  const lzw = (bytes) => PDFRawStream.of(ctx.obj({ Filter: 'LZWDecode' }), bytes);
  expect(() => assertDecodedSize(ctx, lzw(bomb), small)).toThrow(/zu groß/);
  // legitimer LZW-Stream über der rechnerischen Schwelle wird nicht abgelehnt
  const legit = lzwEncode(Buffer.from(randomContent(6000)));
  expect(legit.length).toBeGreaterThan(LIMIT / 3000);
  expect(() => assertDecodedSize(ctx, lzw(legit), LIMIT)).not.toThrow();
});

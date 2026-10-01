/**
 * Interaktionstests (nur Neubau): Ziehen ohne „Mitnehmen“ des nächsten Objekts (Ursachen 1a–1d
 * der Analyse), Treffertests über die Geometrie, „Pfad bearbeiten“, Linien-Endpunkte, Skalieren
 * mit erhaltener Strichstärke, Feinverschiebung, Speichern und erneutes Laden.
 *
 * Grundlage ist tests/fixtures/grafik.pdf (siehe generate.mjs). Objekte (Malreihenfolge):
 *   0 re-Rechteck (ungefüllt, 100/560 200×120, 1,5 pt)   1–4 Rechteck aus vier Linien (350–550/560–680)
 *   5 rotes Rechteck (gefüllt, 100/400 120×60)           6 grüne Linie y = 395 (2 pt)
 *   7 Linie y = 400 (350–550)   8 Linie y = 380 (350–550)   9 geschlossener Pfad m/l/l/l/h
 *   10 Kreis + 11 Linie (Gruppe)   12 dunkle Fläche   13 weiße Linie darauf (3 pt)
 */
import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PDFDocument, PDFName } from 'pdf-lib';
import { launch, openPdf, idle, settled, savedBytes } from './helpers.js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const GRAFIK = readFileSync(path.join(DIR, 'fixtures', 'grafik.pdf'));

/** grafik.pdf + 8 Seiten mit je einem 900×900-Rauschbild (≈ 19 MB): Speichern/Neuladen dauert spürbar. */
let bigCache = null;
async function bigPdf() {
  if (bigCache) return bigCache;
  const doc = await PDFDocument.load(GRAFIK);
  let seed = 7;
  for (let p = 0; p < 8; p++) {
    const raw = Buffer.alloc(900 * 900 * 3);
    for (let i = 0; i < raw.length; i += 4) {
      seed ^= seed << 13;
      seed ^= seed >>> 17;
      seed ^= seed << 5;
      raw.writeInt32LE(seed | 0, Math.min(i, raw.length - 4));
    }
    const dict = doc.context.obj({
      Type: 'XObject',
      Subtype: 'Image',
      Width: 900,
      Height: 900,
      ColorSpace: 'DeviceRGB',
      BitsPerComponent: 8,
      Filter: 'FlateDecode',
    });
    const ref = doc.context.register(doc.context.stream(deflateSync(raw, { level: 1 }), dict));
    const page = doc.addPage([595, 842]);
    page.node.setXObject(PDFName.of('Im' + p), ref);
    page.node.addContentStream(
      doc.context.register(doc.context.stream(`q 495 0 0 742 50 50 cm /Im${p} Do Q`)),
    );
  }
  bigCache = Buffer.from(await doc.save({ useObjectStreams: false }));
  return bigCache;
}

async function setup(browser, bytes = GRAFIK) {
  const { page, context, errors } = await launch(browser, 'neubau');
  await openPdf(page, bytes, 'grafik.pdf');
  await page.evaluate(() => window.pdfEditor.setTool('edit'));
  await idle(page);
  // Hinweise ausblenden (sie können sonst über Klickpunkten liegen)
  await page.addStyleTag({ content: '#toasts{display:none!important}' });
  return { page, context, errors };
}

/** Zustand von Seite 1: Objekte (uid, vis, Knoten in Seitenkoordinaten), Auswahl, Pfadbearbeitung, Verlauf. */
async function state(page) {
  return page.evaluate(() => {
    const app = window.pdfEditor;
    const e = app.edit;
    const m = app.session.model(0);
    const r = (v) => Math.round(v * 1000) / 1000;
    const tp = (c, p) => [r(p[0] * c[0] + p[1] * c[2] + c[4]), r(p[0] * c[1] + p[1] * c[3] + c[5])];
    return {
      objs: m.objects.map((o) => ({
        uid: o.uid,
        type: o.type,
        vis: o.vis.map(r),
        lw: o.lw,
        group: o.cluster ? o.cluster.members.map((x) => x.uid) : [],
        nodes: o.geom ? o.geom.subpaths.map((sp) => sp.nodes.map((n) => tp(o.ctm, n))) : null,
        closed: o.geom ? o.geom.subpaths.map((sp) => sp.closed) : null,
      })),
      sel: e.sel ? e.sel.objs.map((o) => o.uid) : [],
      pe: e.pe ? { uid: e.pe.uid, nodes: [...e.pe.nodes].sort(), seg: e.pe.seg } : null,
      drag: !!e.drag,
      gesture: !!e.gesture,
      undo: app.session.hist.undo.map((x) => x.label),
      handles: [...document.querySelectorAll('.sel .h')].map((h) => h.dataset.h),
    };
  });
}

/**
 * Bildschirmpunkte zu PDF-Koordinaten (Seite 1). Scrollt einmal so, dass alle Punkte sichtbar
 * sind, und rechnet dann alle um – frühere Punkte bleiben also gültig.
 */
async function pts(page, ...points) {
  return page.evaluate((points) => {
    const pv = window.pdfEditor.pvs[0];
    const sc = document.getElementById('scroller');
    const r = sc.getBoundingClientRect();
    const at = () => points.map(([x, y]) => pv.layerToClient(...pv.pdfToLayer(x, y)));
    let c = at();
    const ys = c.map((p) => p[1]);
    const xs = c.map((p) => p[0]);
    if (Math.min(...ys) < r.top + 120 || Math.max(...ys) > r.bottom - 150)
      sc.scrollTop += (Math.min(...ys) + Math.max(...ys)) / 2 - (r.top + r.height / 2);
    if (Math.min(...xs) < r.left + 120 || Math.max(...xs) > r.right - 120)
      sc.scrollLeft += (Math.min(...xs) + Math.max(...xs)) / 2 - (r.left + r.width / 2);
    return at();
  }, points);
}

const pt = async (page, x, y) => (await pts(page, [x, y]))[0];

const scale = (page) => page.evaluate(() => window.pdfEditor.pvs[0].scale);

async function clickAt(page, x, y) {
  const [cx, cy] = await pt(page, x, y);
  await page.mouse.click(cx, cy);
  await settled(page);
  return state(page);
}

/** Ziehen von PDF-Punkt (x, y) um (dx, dy) Bildschirmpixel. */
async function drag(page, x, y, dx, dy, { steps = 8, modifiers = [], before = [] } = {}) {
  const [cx, cy] = await pt(page, x, y);
  await page.mouse.move(cx, cy);
  for (const m of before) await page.keyboard.down(m);
  await page.mouse.down();
  for (const m of modifiers) await page.keyboard.down(m);
  for (let i = 1; i <= steps; i++) await page.mouse.move(cx + (dx * i) / steps, cy + (dy * i) / steps);
  await page.mouse.up();
  for (const m of [...modifiers, ...before]) await page.keyboard.up(m);
  await settled(page);
  return state(page);
}

async function escape(page) {
  await page.keyboard.press('Escape');
  await settled(page);
}

const uidsByIndex = (s) => s.objs.map((o) => o.uid);
const byUid = (s, uid) => s.objs.find((o) => o.uid === uid);
const close = (a, b, eps = 0.01) => a.every((v, i) => Math.abs(v - b[i]) <= eps);

async function throttle(page, rate) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return cdp;
}

test.describe('Ziehen: kein Mitnehmen des nächsten Objekts', () => {
  test('1a: Klick während der Textübernahme (CPU gedrosselt) – nichts klebt an der Maus', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { page, context, errors } = await setup(browser, await bigPdf());
    try {
      const s0 = await state(page);
      const red = uidsByIndex(s0)[5];
      // Text bearbeiten
      await clickAt(page, 120, 744);
      await page.locator('.te').waitFor();
      await page.keyboard.type('XYZ');
      // Dauer der Übernahme messen; Auflösung des Klicks protokollieren
      await page.evaluate(() => {
        const ed = window.pdfEditor.edit;
        const fe = ed.finishEdit.bind(ed);
        ed.finishEdit = function () {
          const t = performance.now();
          const p = fe();
          p.then(() => (window.__finishMs = performance.now() - t));
          return p;
        };
        const rd = ed.resolveDown.bind(ed);
        window.__resolved = [];
        ed.resolveDown = function (down, gesture) {
          window.__resolved.push(gesture ? 'gedrückt' : 'losgelassen');
          return rd(down, gesture);
        };
      });
      const cdp = await throttle(page, 4);
      const [x, y] = await pt(page, 160, 430);
      const hold = 100;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.waitForTimeout(hold);
      await page.mouse.up();
      await idle(page);
      const finishMs = await page.evaluate(() => window.__finishMs);
      // Voraussetzung der Ursache 1a: Die Übernahme (Speichern + Neuladen) dauert länger als der Klick
      expect(finishMs).toBeGreaterThan(hold);
      let s = await state(page);
      expect(s.drag).toBe(false);
      expect(s.gesture).toBe(false);
      expect(s.sel).toEqual([red]);
      // Maus ohne Taste bewegen und woanders klicken: nichts darf sich bewegen
      await page.mouse.move(x + 150, y + 90, { steps: 6 });
      await page.mouse.click(x + 150, y + 90);
      await idle(page);
      s = await state(page);
      expect(s.undo).toEqual(['Text bearbeitet']);
      expect(byUid(s, red).vis).toEqual(byUid(s0, red).vis);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('1a: Taste vor Ende der Übernahme losgelassen – nur auswählen, nie ziehen', async ({ browser }) => {
    const { page, context, errors } = await setup(browser);
    try {
      const s0 = await state(page);
      const red = uidsByIndex(s0)[5];
      await clickAt(page, 120, 744);
      await page.locator('.te').waitFor();
      await page.keyboard.type('XYZ');
      // Übernahme künstlich verlangsamen, damit das Loslassen sicher davor liegt
      await page.evaluate(() => {
        const s = window.pdfEditor.session;
        const commit = s.commitEdit.bind(s);
        s.commitEdit = async (...a) => {
          await new Promise((r) => setTimeout(r, 600));
          return commit(...a);
        };
        const ed = window.pdfEditor.edit;
        const rd = ed.resolveDown.bind(ed);
        window.__resolved = [];
        ed.resolveDown = (down, gesture) => (window.__resolved.push(!!gesture), rd(down, gesture));
      });
      const [x, y] = await pt(page, 160, 430);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 10, y + 10);
      await page.mouse.up();
      // während die Übernahme noch läuft, ohne Taste weiterbewegen
      await page.mouse.move(x + 120, y + 80, { steps: 5 });
      await idle(page);
      expect(await page.evaluate(() => window.__resolved)).toEqual([false]);
      await page.mouse.move(x + 200, y + 100, { steps: 5 });
      let s = await state(page);
      expect(s.sel).toEqual([red]);
      expect(s.drag).toBe(false);
      await page.mouse.click(x + 200, y + 100);
      await idle(page);
      s = await state(page);
      expect(s.undo).toEqual(['Text bearbeitet']);
      expect(byUid(s, red).vis).toEqual(byUid(s0, red).vis);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('1a: nach Ziehen am Griff ⠿ des Texteditors klebt kein Objekt', async ({ browser }) => {
    const { page, context, errors } = await setup(browser);
    try {
      const s0 = await state(page);
      const red = uidsByIndex(s0)[5];
      await clickAt(page, 120, 744);
      await page.locator('.te').waitFor();
      const g = await page.evaluate(() => {
        const r = document.querySelector('.te-frame .mvg').getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      });
      await page.mouse.move(...g);
      await page.mouse.down();
      await page.mouse.move(g[0] + 40, g[1] + 30, { steps: 6 });
      await page.mouse.up();
      const [x, y] = await pt(page, 160, 430);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.up();
      await page.mouse.move(x + 100, y + 60, { steps: 6 });
      await idle(page);
      await page.mouse.click(x + 300, y + 200);
      await idle(page);
      const s = await state(page);
      expect(s.undo).toEqual(['Text bearbeitet']);
      expect(byUid(s, red).vis).toEqual(byUid(s0, red).vis);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('1b: zweites Objekt greifen, während die erste Änderung noch läuft (CPU gedrosselt)', async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const { page, context, errors } = await setup(browser, await bigPdf());
    try {
      const s0 = await state(page);
      const [red, line8] = [uidsByIndex(s0)[5], uidsByIndex(s0)[8]];
      const k = await scale(page);
      const cdp = await throttle(page, 4);
      const [[x, y], [x2, y2]] = await pts(page, [160, 430], [450, 380]);
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 20, y + 30, { steps: 4 });
      // beim zweiten Drücken festhalten, ob die erste Änderung noch läuft (Speichern + Neuladen);
      // das Neuladen wartet zusätzlich, bis das zweite Objekt losgelassen ist – so wird das
      // Zeitfenster unabhängig von der Rechnerlast sicher getroffen
      await page.evaluate(() => {
        const r = window.pdfEditor.renderer;
        const load = r.load.bind(r);
        window.__gate = new Promise((res) => (window.__openGate = res));
        r.load = async (bytes) => {
          await window.__gate;
          return load(bytes);
        };
        window.__downWhileBusy = [];
        window.addEventListener(
          'pointerdown',
          () => window.__downWhileBusy.push(!!window.pdfEditor._syncP || window.pdfEditor.edit.busy),
          true,
        );
      });
      await page.mouse.up();
      await page.waitForTimeout(30);
      await page.mouse.move(x2, y2);
      await page.mouse.down();
      await page.mouse.move(x2 + 40, y2 - 60, { steps: 6 });
      await page.waitForTimeout(150);
      await page.mouse.up();
      await page.evaluate(() => window.__openGate());
      await idle(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      // Voraussetzung der Ursache 1b: Das zweite Objekt wurde gegriffen, während die erste Änderung lief
      expect(await page.evaluate(() => window.__downWhileBusy)).toEqual([true]);
      const s = await state(page);
      expect(s.undo).toEqual(['Verschoben', 'Verschoben']);
      const moved = s.objs.filter((o, i) => !close(o.vis, s0.objs[i].vis, 0.001)).map((o) => o.uid);
      expect(moved.sort()).toEqual([red, line8].sort());
      // jeweils die eigene Verschiebung (± Einrasten an Hilfslinien, höchstens 6 px)
      const d = (uid, i) => byUid(s, uid).vis[i] - byUid(s0, uid).vis[i];
      const near = (v, want) => expect(Math.abs(v - want)).toBeLessThanOrEqual(6 / k + 0.01);
      near(d(red, 0), 20 / k);
      near(d(red, 1), -30 / k);
      near(d(line8, 0), 40 / k);
      near(d(line8, 1), 60 / k);
      expect(s.sel).toEqual([line8]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('1b: Pfeiltasten und direkt danach ein anderes Objekt ziehen', async ({ browser }) => {
    test.setTimeout(180_000);
    const { page, context, errors } = await setup(browser, await bigPdf());
    try {
      const s0 = await state(page);
      const [red, line8] = [uidsByIndex(s0)[5], uidsByIndex(s0)[8]];
      const cdp = await throttle(page, 4);
      const [[x, y], [x2, y2]] = await pts(page, [160, 430], [450, 380]);
      await page.mouse.click(x, y);
      await settled(page);
      for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
      await page.mouse.move(x2, y2);
      await page.mouse.down();
      await page.mouse.move(x2 + 40, y2 - 60, { steps: 8 });
      await page.waitForTimeout(200);
      await page.mouse.up();
      await idle(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
      const s = await state(page);
      expect(byUid(s, red).vis[0] - byUid(s0, red).vis[0]).toBeCloseTo(3, 3);
      expect(byUid(s, red).vis[1]).toBeCloseTo(byUid(s0, red).vis[1], 3);
      expect(byUid(s, line8).vis[1]).toBeGreaterThan(byUid(s0, line8).vis[1] + 20);
      expect(s.undo).toEqual(['Verschoben', 'Verschoben']);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('1c: Einrasten an einem Nachbarn gruppiert nicht neu', async ({ browser }) => {
    const { page, context, errors } = await setup(browser);
    try {
      const s0 = await state(page);
      const [red, green] = [uidsByIndex(s0)[5], uidsByIndex(s0)[6]];
      expect(byUid(s0, green).group).toEqual([green]);
      // grüne Linie an die Unterkante des roten Rechtecks schieben (rastet ein)
      const k = await scale(page);
      let s = await drag(page, 160, 395, 0, -4 * k);
      expect(byUid(s, green).vis[3]).toBeGreaterThan(byUid(s0, green).vis[3] + 2);
      expect(byUid(s, green).group).toEqual([green]);
      expect(byUid(s, red).group).toEqual([red]);
      await escape(page);
      // erneut nur die Linie ziehen: das Rechteck bleibt, wo es ist
      const g = byUid(s, green);
      s = await drag(page, 160, (g.vis[1] + g.vis[3]) / 2, 60, 60);
      expect(byUid(s, red).vis).toEqual(byUid(s0, red).vis);
      expect(s.sel).toEqual([green]);
      expect(s.undo).toEqual(['Verschoben', 'Verschoben']);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('1d: deckungsgleich auf ein anderes Objekt gezogen – Auswahl bleibt beim gezogenen', async ({
    browser,
  }) => {
    const { page, context, errors } = await setup(browser);
    try {
      const s0 = await state(page);
      const [line7, line8] = [uidsByIndex(s0)[7], uidsByIndex(s0)[8]];
      const k = await scale(page);
      let s = await drag(page, 450, 380, 0, -20 * k, { modifiers: ['Alt'] });
      expect(byUid(s, line8).vis[1]).toBeCloseTo(byUid(s0, line7).vis[1], 1);
      expect(s.sel).toEqual([line8]);
      // zweites Ziehen an derselben Stelle bewegt wieder Linie 8, nicht Linie 7
      s = await drag(page, 450, 400, 50, 50);
      expect(byUid(s, line7).vis).toEqual(byUid(s0, line7).vis);
      expect(byUid(s, line8).vis[0]).toBeGreaterThan(byUid(s0, line8).vis[0] + 20);
      expect(s.sel).toEqual([line8]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('pointercancel, Capture-Verlust und Esc brechen das Ziehen ab', async ({ browser }) => {
    const { page, context, errors } = await setup(browser);
    try {
      const s0 = await state(page);
      const red = uidsByIndex(s0)[5];
      const [x, y] = await pt(page, 160, 430);
      // pointercancel
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 30, y + 30, { steps: 4 });
      await page.evaluate(() =>
        document
          .getElementById('pages')
          .dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })),
      );
      let s = await state(page);
      expect(s.drag).toBe(false);
      expect(s.gesture).toBe(false);
      await page.mouse.move(x + 80, y + 80, { steps: 4 });
      await page.mouse.up();
      await settled(page);
      // Verlust des Pointer-Captures
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 30, y + 30, { steps: 4 });
      await page.evaluate(() => document.getElementById('pages').releasePointerCapture(1));
      // der Verlust wird mit dem nächsten Zeigerereignis zugestellt
      await page.mouse.move(x + 35, y + 35);
      s = await state(page);
      expect(s.gesture).toBe(false);
      await page.mouse.up();
      // Esc
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 30, y + 30, { steps: 4 });
      await page.keyboard.press('Escape');
      await page.mouse.move(x + 60, y + 60, { steps: 4 });
      await page.mouse.up();
      await idle(page);
      s = await state(page);
      expect(s.undo).toEqual([]);
      expect(byUid(s, red).vis).toEqual(byUid(s0, red).vis);
      // Texteditor: Ziehen am Griff ⠿ endet auch bei pointercancel
      await escape(page);
      await clickAt(page, 120, 744);
      await page.locator('.te').waitFor();
      const g = await page.evaluate(() => {
        const r = document.querySelector('.te-frame .mvg').getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      });
      await page.mouse.move(...g);
      await page.mouse.down();
      await page.mouse.move(g[0] + 20, g[1] + 10, { steps: 3 });
      await page.evaluate(() =>
        document
          .querySelector('.te-frame')
          .dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })),
      );
      const before = await page.evaluate(() => document.querySelector('.te-frame').style.left);
      await page.mouse.move(g[0] + 120, g[1] + 60, { steps: 3 });
      expect(await page.evaluate(() => document.querySelector('.te-frame').style.left)).toBe(before);
      await page.mouse.up();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

test.describe('Treffertests und Pfad bearbeiten', () => {
  test('Geometrie statt Rechteck: leeres Inneres, Kanten, nächstes Objekt', async ({ browser }) => {
    const { page, context, errors } = await setup(browser);
    try {
      const s0 = await state(page);
      const ids = uidsByIndex(s0);
      // Klick ins leere Innere eines ungefüllten Rechtecks trifft nichts
      expect((await clickAt(page, 200, 620)).sel).toEqual([]);
      expect((await clickAt(page, 200, 250)).sel).toEqual([]);
      // Kante des re-Rechtecks
      expect((await clickAt(page, 200, 680)).sel).toEqual([ids[0]]);
      await escape(page);
      // Rechteck aus vier Linien: erst die Gruppe, dann die Linie, dann „Pfad bearbeiten“
      expect((await clickAt(page, 450, 680)).sel.sort()).toEqual(ids.slice(1, 5).sort());
      await page.waitForTimeout(600); // langsamer zweiter Klick, kein Doppelklick
      let s = await clickAt(page, 450, 680);
      expect(s.sel).toEqual([ids[3]]);
      expect(s.handles).toEqual(['p0', 'p1']);
      await page.waitForTimeout(600); // kein Doppelklick
      s = await clickAt(page, 450, 680);
      expect(s.pe).toEqual({ uid: ids[3], nodes: ['0:0', '0:1'], seg: { sp: 0, k: 0 } });
      await escape(page);
      expect((await state(page)).sel).toEqual([ids[3]]);
      await escape(page);
      // zwischen roter Fläche (Unterkante 400) und grüner Linie (395 ± 1): das nähere Objekt gewinnt
      expect((await clickAt(page, 160, 397.2)).sel).toEqual([ids[6]]);
      await page.waitForTimeout(600); // kein Doppelklick
      expect((await clickAt(page, 160, 398.8)).sel).toEqual([ids[5]]);
      await escape(page);
      // Kreis und Linie bilden weiterhin eine Gruppe
      expect((await clickAt(page, 480, 250)).sel.sort()).toEqual([ids[10], ids[11]].sort());
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('Hover-Hervorhebung und Cursor', async ({ browser }) => {
    const { page, context, errors } = await setup(browser);
    try {
      const hover = async (x, y) => {
        const [cx, cy] = await pt(page, x, y);
        await page.mouse.move(cx, cy, { steps: 2 });
        return page.evaluate(() => ({
          paths: document.querySelectorAll('.page .hl path').length,
          cursor: window.pdfEditor.pvs[0].layer.style.cursor,
        }));
      };
      expect(await hover(450, 380)).toEqual({ paths: 1, cursor: 'move' });
      expect(await hover(450, 680)).toEqual({ paths: 4, cursor: 'move' });
      expect(await hover(200, 620)).toEqual({ paths: 0, cursor: '' });
      expect(await hover(120, 744)).toEqual({ paths: 0, cursor: 'text' });
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('re-Rechteck: Kante wählen und verschieben, Ecke zieht beide Kanten mit, Rückgängig', async ({
    browser,
  }) => {
    const { page, context, errors } = await setup(browser);
    try {
      const s0 = await state(page);
      const rect = uidsByIndex(s0)[0];
      const k = await scale(page);
      const [cx, cy] = await pt(page, 200, 680);
      await page.mouse.dblclick(cx, cy);
      await settled(page);
      let s = await state(page);
      expect(s.pe).toEqual({ uid: rect, nodes: ['0:2', '0:3'], seg: { sp: 0, k: 2 } });
      expect(await page.locator('.pe .pa').count()).toBe(4);
      expect(await page.locator('.pe .pa.on').count()).toBe(2);
      // obere Kante 20 pt nach oben: bleibt ein Rechteck
      s = await drag(page, 200, 680, 0, -20 * k);
      expect(byUid(s, rect).nodes[0]).toEqual([
        [100, 560],
        [300, 560],
        [300, 700],
        [100, 700],
      ]);
      expect(byUid(s, rect).lw).toBe(1.5);
      expect(s.undo).toEqual(['Kante verschoben']);
      expect(s.pe.uid).toBe(rect);
      // obere Kante schräg (Umschalt = 45°): kein Rechteck mehr → m/l/l/l/h
      s = await drag(page, 200, 700, 30 * k, -30 * k, { modifiers: ['Shift'] });
      expect(byUid(s, rect).nodes[0]).toEqual([
        [100, 560],
        [300, 560],
        [330, 730],
        [130, 730],
      ]);
      const src = await page.evaluate(() => window.pdfEditor.session.model(0).src);
      expect(src).toMatch(/100 560 m\s+300 560 l\s+330 730 l\s+130 730 l\s+h/);
      expect(src).not.toMatch(/100 560 200 120 re/);
      // Ecke oben rechts anklicken (wählt nur diesen Punkt) und ziehen: beide anliegenden Kanten folgen
      s = await clickAt(page, 330, 730);
      expect(s.pe.nodes).toEqual(['0:2']);
      s = await drag(page, 330, 730, 10 * k, 0, { modifiers: ['Shift'] });
      expect(s.pe.nodes).toEqual(['0:2']);
      expect(byUid(s, rect).nodes[0][2]).toEqual([340, 730]);
      expect(byUid(s, rect).closed).toEqual([true]);
      expect(byUid(s, rect).lw).toBe(1.5);
      // Pfeiltasten verschieben den Ankerpunkt (Alt = 0,1 pt)
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('Alt+ArrowRight');
      await settled(page);
      s = await state(page);
      expect(byUid(s, rect).nodes[0][2]).toEqual([340.1, 731]);
      // Rückgängig bis zum Original
      for (let i = 0; i < 4; i++) {
        await page.keyboard.press('Control+z');
        await idle(page);
      }
      s = await state(page);
      expect(byUid(s, rect).nodes).toEqual(byUid(s0, rect).nodes);
      expect(await page.evaluate(() => window.pdfEditor.session.model(0).src)).toMatch(/100 560 200 120 re/);
      expect(s.undo).toEqual([]);
      // Esc bzw. Klick daneben verlässt den Modus
      await page.mouse.dblclick(...(await pt(page, 200, 680)));
      await settled(page);
      expect((await state(page)).pe).not.toBeNull();
      s = await clickAt(page, 200, 620);
      expect(s.pe).toBeNull();
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('Rechteck aus vier Linien: verbundene Endpunkte wandern mit, Alt löst', async ({ browser }) => {
    const { page, context, errors } = await setup(browser);
    try {
      const s0 = await state(page);
      const ids = uidsByIndex(s0);
      const k = await scale(page);
      // Doppelklick auf die obere Linie (Objekt 3: 550/680 → 350/680)
      const [cx, cy] = await pt(page, 450, 680);
      await page.mouse.dblclick(cx, cy);
      await settled(page);
      let s = await state(page);
      expect(s.pe.uid).toBe(ids[3]);
      // linken Endpunkt (350/680) anklicken und ziehen: die linke Linie (Objekt 4) folgt
      expect((await clickAt(page, 350, 680)).pe.nodes).toEqual(['0:1']);
      s = await drag(page, 350, 680, -20 * k, -10 * k);
      expect(byUid(s, ids[3]).nodes[0]).toEqual([
        [550, 680],
        [330, 690],
      ]);
      expect(byUid(s, ids[4]).nodes[0]).toEqual([
        [330, 690],
        [350, 560],
      ]);
      expect(byUid(s, ids[2]).nodes).toEqual(byUid(s0, ids[2]).nodes);
      expect(s.undo).toEqual(['Punkt verschoben']);
      // mit Alt: nur diese Linie
      s = await drag(page, 330, 690, 20 * k, 0, { modifiers: ['Alt'] });
      expect(byUid(s, ids[3]).nodes[0][1]).toEqual([350, 690]);
      expect(byUid(s, ids[4]).nodes[0][0]).toEqual([330, 690]);
      // Segment mit Alt ziehen: in einem geschlossenen Pfad wird die Kante herausgelöst
      await escape(page);
      await escape(page);
      const ids9 = ids[9];
      const [px, py] = await pt(page, 200, 300);
      await page.mouse.dblclick(px, py);
      await settled(page);
      s = await drag(page, 200, 300, 0, -20 * k, { before: ['Alt'] });
      const nodes = byUid(s, ids9).nodes;
      expect(nodes.length).toBe(2);
      expect(nodes[1]).toEqual([
        [300, 320],
        [100, 320],
      ]);
      expect(byUid(s, ids9).closed).toEqual([false, false]);
      expect(s.undo.at(-1)).toBe('Kante gelöst');
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

test.describe('Linien-Griffe und Skalieren', () => {
  test('Endpunkt-Griffe: Größe, Strichstärke, Shift-Winkel, Einrasten', async ({ browser }) => {
    const { page, context, errors } = await setup(browser);
    try {
      const s0 = await state(page);
      const [line7, line8] = [uidsByIndex(s0)[7], uidsByIndex(s0)[8]];
      const k = await scale(page);
      let s = await clickAt(page, 450, 380);
      expect(s.sel).toEqual([line8]);
      expect(s.handles).toEqual(['p0', 'p1']);
      const handleBox = () =>
        page.evaluate(() =>
          [...document.querySelectorAll('.sel .h.ep')].map((h) => {
            const r = h.getBoundingClientRect();
            const v = getComputedStyle(h, '::after');
            return [r.width, r.height, parseFloat(v.width)];
          }),
        );
      expect(await handleBox()).toEqual([
        [28, 28, 12],
        [28, 28, 12],
      ]);
      // rechten Endpunkt frei ziehen (Alt): Strichstärke bleibt, keine cm-Skalierung
      s = await drag(page, 550, 380, 30 * k, -20 * k, { modifiers: ['Alt'] });
      expect(byUid(s, line8).nodes[0]).toEqual([
        [350, 380],
        [580, 400],
      ]);
      expect(byUid(s, line8).lw).toBe(1);
      expect(s.sel).toEqual([line8]);
      expect(s.undo).toEqual(['Linie geändert']);
      expect(await page.evaluate(() => window.pdfEditor.session.model(0).src)).toMatch(
        /350 380 m\s+580 400 l/,
      );
      // Umschalt: auf 45° einrasten (Richtung ≈ 40° → 45°)
      s = await drag(page, 580, 400, 0, -170 * k, { modifiers: ['Shift'] });
      const [[ax, ay], [bx, by]] = byUid(s, line8).nodes[0];
      expect(Math.abs(bx - ax)).toBeCloseTo(Math.abs(by - ay), 2);
      expect(bx - ax).toBeCloseTo(210, 1);
      // Einrasten am Endpunkt einer anderen Linie (Linie 7 beginnt bei 350/400)
      s = await drag(page, ax, ay, 3, -(20 * k - 3));
      expect(byUid(s, line8).nodes[0][0]).toEqual([350, 400]);
      expect(byUid(s, line7).nodes).toEqual(byUid(s0, line7).nodes);
      // bei hohem Zoom: gleiche Griffgröße, Ziehen in Bildschirmpixeln exakt
      await page.evaluate(() => window.pdfEditor.setZoom(4));
      await idle(page);
      await escape(page);
      const [p0, p1] = byUid(s, line8).nodes[0];
      s = await clickAt(page, (p0[0] + p1[0]) / 2, (p0[1] + p1[1]) / 2);
      expect(s.sel).toEqual([line8]);
      expect(await handleBox()).toEqual([
        [28, 28, 12],
        [28, 28, 12],
      ]);
      const k4 = await scale(page);
      const end = byUid(s, line8).nodes[0][1];
      s = await drag(page, end[0], end[1], 8, 0, { modifiers: ['Alt'] });
      expect(byUid(s, line8).nodes[0][1][0]).toBeCloseTo(end[0] + 8 / k4, 2);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('Rahmengriffe: Skalieren eines Pfads über die Geometrie, schmale Rahmen ohne gestapelte Griffe', async ({
    browser,
  }) => {
    const { page, context, errors } = await setup(browser);
    try {
      const s0 = await state(page);
      const ids = uidsByIndex(s0);
      const k = await scale(page);
      let s = await clickAt(page, 200, 680);
      expect(s.handles.length).toBe(8);
      // rechten Griff 40 pt nach rechts (Umschalt = nicht proportional, Alt = ohne Einrasten)
      const [hx, hy] = await page.evaluate(() => {
        const r = document.querySelector('.sel .h[data-h=e]').getBoundingClientRect();
        return [r.x + r.width / 2, r.y + r.height / 2];
      });
      await page.mouse.move(hx, hy);
      await page.mouse.down();
      await page.keyboard.down('Alt');
      for (let i = 1; i <= 6; i++) await page.mouse.move(hx + (40 * k * i) / 6, hy);
      await page.mouse.up();
      await page.keyboard.up('Alt');
      await settled(page);
      s = await state(page);
      // Rahmen = sichtbares Rechteck (inkl. halber Linienbreite); links fest, rechts +40 pt
      const [l, , r] = byUid(s0, ids[0]).vis;
      const f = (r - l + 40) / (r - l);
      const n = byUid(s, ids[0]).nodes[0];
      expect(n[0][0]).toBeCloseTo(l + (100 - l) * f, 2);
      expect(n[1][0]).toBeCloseTo(l + (300 - l) * f, 2);
      expect(n[2][1]).toBe(680);
      expect(byUid(s, ids[0]).lw).toBe(1.5);
      const src = await page.evaluate(() => window.pdfEditor.session.model(0).src);
      expect(src).toMatch(/ re\b/);
      expect(src.split('\n').filter((l) => / cm$/.test(l)).length).toBe(0);
      expect(s.undo).toEqual(['Größe geändert']);
      // schmale Rahmen: nie übereinanderliegende Griffe
      const sets = await page.evaluate(() =>
        [
          [300, 10],
          [10, 300],
          [10, 10],
          [300, 40],
          [40, 300],
          [300, 200],
        ].map(([w, h]) => window.pdfEditor.edit.boxHandles(w, h).map((x) => x[0])),
      );
      expect(sets).toEqual([
        ['e', 'w'],
        ['n', 's'],
        ['se'],
        ['nw', 'n', 'ne', 'se', 's', 'sw'],
        ['nw', 'ne', 'e', 'se', 'sw', 'w'],
        ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'],
      ]);
      // zwei Linien mit Umschalt: Mehrfachauswahl mit Rahmengriffen
      await escape(page);
      await clickAt(page, 450, 400);
      await page.keyboard.down('Shift');
      s = await clickAt(page, 450, 380);
      await page.keyboard.up('Shift');
      expect(s.sel.length).toBe(2);
      expect(s.handles).toEqual(['nw', 'n', 'ne', 'se', 's', 'sw']);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('Pfeiltasten: 1 pt, Umschalt 10 pt, Alt 0,1 pt', async ({ browser }) => {
    const { page, context, errors } = await setup(browser);
    try {
      const s0 = await state(page);
      const red = uidsByIndex(s0)[5];
      await clickAt(page, 160, 430);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Shift+ArrowUp');
      await page.keyboard.press('Alt+ArrowLeft');
      await page.keyboard.press('Alt+ArrowLeft');
      await settled(page);
      const s = await state(page);
      expect(byUid(s, red).vis[0] - byUid(s0, red).vis[0]).toBeCloseTo(0.8, 6);
      expect(byUid(s, red).vis[1] - byUid(s0, red).vis[1]).toBeCloseTo(10, 6);
      expect(s.undo).toEqual(['Verschoben']);
      expect(s.sel).toEqual([red]);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

  test('Speichern und neu laden: Geometrie im gespeicherten PDF stimmt', async ({ browser }) => {
    const { page, context, errors } = await setup(browser);
    try {
      const s0 = await state(page);
      const ids = uidsByIndex(s0);
      const k = await scale(page);
      // Kante des re-Rechtecks schräg, Linie verlängern, Linie skalieren
      const [cx, cy] = await pt(page, 200, 680);
      await page.mouse.dblclick(cx, cy);
      await settled(page);
      await drag(page, 200, 680, 20 * k, -10 * k);
      await escape(page);
      await escape(page);
      await clickAt(page, 450, 380);
      await drag(page, 550, 380, 25 * k, 0, { modifiers: ['Alt'] });
      const before = await state(page);
      const bytes = await savedBytes(page);
      await page.evaluate(() => window.pdfEditor.markSaved()); // sonst fragt „Öffnen“ nach dem Speichern
      await openPdf(page, bytes, 'neu.pdf');
      await page.evaluate(() => window.pdfEditor.setTool('edit'));
      await idle(page);
      const after = await state(page);
      const shape = (s) => s.objs.map((o) => ({ type: o.type, lw: o.lw, nodes: o.nodes, closed: o.closed }));
      expect(shape(after)).toEqual(shape(before));
      expect(byUid(before, ids[0]).nodes[0]).toEqual([
        [100, 560],
        [300, 560],
        [320, 690],
        [120, 690],
      ]);
      expect(byUid(before, ids[8]).nodes[0]).toEqual([
        [350, 380],
        [575, 380],
      ]);
      // gespeichertes PDF mit pdf-lib prüfen: Pfadoperatoren im Content-Stream
      const doc = await PDFDocument.load(bytes);
      const pageNode = doc.getPage(0).node;
      const contents = doc.context.lookup(pageNode.get(PDFName.of('Contents')));
      const { inflateSync } = await import('node:zlib');
      const raw = Buffer.from(inflateSync(contents.contents)).toString('latin1');
      expect(raw).toMatch(/100 560 m\s+300 560 l\s+320 690 l\s+120 690 l\s+h/);
      expect(raw).toMatch(/350 380 m\s+575 380 l/);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });
});

/**
 * Feine Grafik für hohen Zoom: sehr kurze Linie S (1,5 pt), Linie B, deren Anfang 1,5 pt neben dem
 * Ende von S liegt, und ein kleines re-Rechteck R (4 × 3 pt); alle mit 0,25 pt Strichstärke.
 */
async function finePdf() {
  const doc = await PDFDocument.create({ updateMetadata: false });
  const page = doc.addPage([595, 842]);
  const ops = `q 0.25 w 0 0 0 RG
100 100 m 101.5 100 l S
Q
q 0.25 w 0 0 1 RG
103 100.5 m 110 104 l S
Q
q 0.25 w 1 0 0 RG
112 96 4 3 re S
Q
`;
  page.node.addContentStream(doc.context.register(doc.context.stream(ops)));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

/** Zoom mit dem PDF-Punkt (x, y) von Seite 1 in der Fenstermitte; wartet auf Vorschau und Detail. */
async function zoomTo(page, zoom, x, y) {
  await page.evaluate(
    ({ zoom, x, y }) => {
      const app = window.pdfEditor;
      const s = document.getElementById('scroller');
      const r = s.getBoundingClientRect();
      app.setZoom(zoom, null, true, {
        pv: app.pvs[0],
        pdf: [x, y],
        clientX: r.left + s.clientWidth / 2,
        clientY: r.top + s.clientHeight / 2,
      });
    },
    { zoom, x, y },
  );
  for (let i = 0; i < 2; i++) {
    await idle(page);
    await page.waitForFunction(() => !window.pdfEditor.detail || !window.pdfEditor.detail.pending, null, {
      polling: 30,
    });
  }
}

/** Mittelpunkt eines Griffs (Client-Koordinaten). */
const handleCenter = (page, sel) =>
  page.evaluate((sel) => {
    const r = document.querySelector(sel).getBoundingClientRect();
    return [r.x + r.width / 2, r.y + r.height / 2];
  }, sel);

for (const zoom of [16, 32])
  test(`Hoher Zoom ${zoom * 100} %: Treffer, kurze Linie am Endpunkt ziehen und fangen, Pfad bearbeiten, Speichern`, async ({
    browser,
  }) => {
    const { page, context, errors } = await setup(browser, await finePdf());
    try {
      await zoomTo(page, zoom, 107, 100);
      const k = await scale(page);
      expect(k).toBeCloseTo(zoom * (96 / 72), 6);
      const s0 = await state(page);
      const [S, B, R] = uidsByIndex(s0);
      // Treffer: halbe Linienbreite + 3 px über der Linie ja, + 9 px nein
      expect((await clickAt(page, 100.75, 100 + 0.125 + 3 / k)).sel).toEqual([S]);
      await escape(page);
      await page.waitForTimeout(600);
      expect((await clickAt(page, 100.75, 100 + 0.125 + 9 / k)).sel).toEqual([]);
      // kurze Linie wählen: zwei Endpunkt-Griffe in Bildschirmgröße, nicht übereinander
      await page.waitForTimeout(600);
      let s = await clickAt(page, 100.75, 100);
      expect(s.sel).toEqual([S]);
      expect(s.handles).toEqual(['p0', 'p1']);
      const [h0, h1] = [
        await handleCenter(page, '.sel .h[data-h=p0]'),
        await handleCenter(page, '.sel .h[data-h=p1]'),
      ];
      expect(h1[0] - h0[0]).toBeCloseTo(1.5 * k, 0);
      expect(h1[0] - h0[0]).toBeGreaterThanOrEqual(28);
      // Endpunkt frei (Alt) um 12 px nach rechts
      await page.mouse.move(...h1);
      await page.mouse.down();
      await page.keyboard.down('Alt');
      for (let i = 1; i <= 6; i++) await page.mouse.move(h1[0] + 2 * i, h1[1]);
      await page.mouse.up();
      await page.keyboard.up('Alt');
      await settled(page);
      s = await state(page);
      expect(byUid(s, S).nodes[0][1][0]).toBeCloseTo(101.5 + 12 / k, 2);
      expect(byUid(s, S).nodes[0][1][1]).toBe(100);
      expect(byUid(s, S).lw).toBe(0.25);
      // Endpunkt bis 3 px neben den Anfang von B ziehen: rastet exakt ein
      const p1 = await handleCenter(page, '.sel .h[data-h=p1]');
      const [bx, by] = await pt(page, 103, 100.5);
      await page.mouse.move(...p1);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++)
        await page.mouse.move(p1[0] + ((bx + 3 - p1[0]) * i) / 8, p1[1] + ((by - 2 - p1[1]) * i) / 8);
      await page.mouse.up();
      await settled(page);
      s = await state(page);
      expect(byUid(s, S).nodes[0]).toEqual([
        [100, 100],
        [103, 100.5],
      ]);
      expect(byUid(s, B).nodes).toEqual(byUid(s0, B).nodes);
      // Pfad bearbeiten: Doppelklick auf die Oberkante von R, Ecke oben rechts 10 px nach rechts
      await escape(page);
      await page.mouse.dblclick(...(await pt(page, 114, 99)));
      await settled(page);
      s = await state(page);
      expect(s.pe).toEqual({ uid: R, nodes: ['0:2', '0:3'], seg: { sp: 0, k: 2 } });
      expect((await clickAt(page, 116, 99)).pe.nodes).toEqual(['0:2']);
      s = await drag(page, 116, 99, 10, 0, { modifiers: ['Shift'] });
      expect(byUid(s, R).nodes[0][2][0]).toBeCloseTo(116 + 10 / k, 2);
      expect(byUid(s, R).nodes[0][2][1]).toBe(99);
      expect(byUid(s, R).nodes[0][1]).toEqual([116, 96]);
      expect(byUid(s, R).lw).toBe(0.25);
      expect(s.undo).toEqual(['Linie geändert', 'Linie geändert', 'Punkt verschoben']);
      // speichern und das Ergebnis im gespeicherten PDF prüfen
      const bytes = await savedBytes(page);
      const doc = await PDFDocument.load(bytes);
      const contents = doc.context.lookup(doc.getPage(0).node.get(PDFName.of('Contents')));
      const { inflateSync } = await import('node:zlib');
      const raw = Buffer.from(inflateSync(contents.contents)).toString('latin1');
      expect(raw).toMatch(/100 100 m\s+103 100\.5 l/);
      const corner = raw.match(/112 96 m\s+116 96 l\s+([\d.]+) 99 l\s+112 99 l\s+h/);
      expect(corner).not.toBeNull();
      expect(+corner[1]).toBeCloseTo(116 + 10 / k, 2);
      expect(raw).toMatch(/0\.25 w/);
      expect(raw).not.toMatch(/ cm\b/);
      expect(errors).toEqual([]);
    } finally {
      await context.close();
    }
  });

test('Hand-Werkzeug (Leertaste, mittlere Maustaste) wählt und zieht nichts', async ({ browser }) => {
  const { page, context, errors } = await setup(browser);
  try {
    const s0 = await state(page);
    const red = uidsByIndex(s0)[5];
    const [x, y] = await pt(page, 160, 430);
    await page.mouse.move(x, y);
    // Leertaste + Ziehen über einem Objekt: Ansicht verschieben, keine Auswahl
    const top0 = await page.evaluate(() => document.getElementById('scroller').scrollTop);
    await page.keyboard.down(' ');
    await page.mouse.down();
    await page.mouse.move(x, y - 80, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.up(' ');
    await settled(page);
    let s = await state(page);
    expect(await page.evaluate(() => document.getElementById('scroller').scrollTop)).toBeGreaterThan(
      top0 + 40,
    );
    expect(s.sel).toEqual([]);
    expect(s.gesture).toBe(false);
    // mittlere Maustaste
    const [x2, y2] = await pt(page, 160, 430);
    await page.mouse.move(x2, y2);
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(x2, y2 + 60, { steps: 5 });
    await page.mouse.up({ button: 'middle' });
    await settled(page);
    s = await state(page);
    expect(s.sel).toEqual([]);
    // linkes Ziehen und dazu die mittlere Taste: Ziehen wird abgebrochen
    const [x3, y3] = await pt(page, 160, 430);
    await page.mouse.move(x3, y3);
    await page.mouse.down();
    await page.mouse.move(x3 + 30, y3 + 30, { steps: 4 });
    await page.mouse.down({ button: 'middle' });
    await page.mouse.move(x3 + 60, y3 + 60, { steps: 4 });
    await page.mouse.up({ button: 'middle' });
    await page.mouse.up();
    await idle(page);
    s = await state(page);
    expect(s.drag).toBe(false);
    expect(s.undo).toEqual([]);
    expect(byUid(s, red).vis).toEqual(byUid(s0, red).vis);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

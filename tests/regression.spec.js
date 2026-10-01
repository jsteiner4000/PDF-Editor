/**
 * Regressionstests: Original 1.0 (legacy/) und Neubau (dist/) müssen sich gleich verhalten.
 * Jeder Test führt dieselbe Szene in beiden Builds aus und vergleicht die Ergebnisse;
 * zusätzliche Plausibilitätsprüfungen verhindern, dass beide „gleich falsch“ sind.
 */
import { test, expect } from '@playwright/test';
import {
  runBoth,
  openPdf,
  idle,
  canvasHashes,
  savedBytes,
  extractText,
  clientPoint,
  findBlock,
  objectsOf,
  uiState,
  toasts,
  sha,
  screenshots,
  LAYOUT,
  settled,
} from './helpers.js';

const noErrors = (r) => {
  expect(r.originalErrors, 'Fehler im Original').toEqual([]);
  expect(r.neubauErrors, 'Fehler im Neubau').toEqual([]);
};

async function chooseTool(page, label) {
  await page.locator('#lpBody .tool', { hasText: label }).click();
  await idle(page);
}

/** Klickt ans Ende einer Textzeile, tippt Text und übernimmt mit Esc. */
async function appendToLine(page, needle, lineIndex, text) {
  const block = await findBlock(page, 0, needle);
  expect(block, `Textblock „${needle}“`).not.toBeNull();
  const line = block.lines[lineIndex];
  const [x, y] = await clientPoint(page, 0, line.ex - 1, line.y + 3);
  await page.mouse.click(x, y);
  await page.locator('.te').waitFor();
  await page.waitForFunction(() => document.activeElement && document.activeElement.classList.contains('te'));
  await page.keyboard.press('End');
  await page.keyboard.type(text);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !window.pdfEditor.edit.editor && !window.pdfEditor.edit._finishing);
  await idle(page);
}

/** Zieht mit der Maus; liefert die während des Ziehens angezeigten Hilfslinien. */
async function dragBy(page, from, dx, dy) {
  await page.mouse.move(from[0], from[1]);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(from[0] + (dx * i) / 8, from[1] + (dy * i) / 8);
  const guides = await page.evaluate(() =>
    [...document.querySelectorAll('.guide')].map((g) => g.className + '|' + g.style.cssText),
  );
  await page.mouse.up();
  await page.waitForFunction(() => !window.pdfEditor.edit.drag);
  await idle(page);
  return guides;
}

test('Laden und Darstellen', async ({ browser }) => {
  const r = await runBoth(browser, async (page) => {
    const opened = await openPdf(page);
    const state = await uiState(page);
    const canvases = await canvasHashes(page);
    const shot = await screenshots(page);
    const model = await page.evaluate(() => {
      const s = window.pdfEditor.session;
      return [0, 1, 2].map((i) => ({
        blocks: s.model(i).blocks.map((b) => ({
          text: b.text,
          align: b.align,
          editable: b.editable,
          bbox: b.bbox.map((v) => Math.round(v * 100) / 100),
        })),
        objects: s.model(i).objects.length,
      }));
    });
    // Miniaturansicht einblenden
    await page.locator('#rThumbs').click();
    await page.waitForFunction(() =>
      [...document.querySelectorAll('#thumbs .th')].every(
        (t) => t.dataset.sig && t.querySelector('canvas').width > 0,
      ),
    );
    await idle(page);
    await page.waitForTimeout(300);
    const thumbs = await page.evaluate(() =>
      [...document.querySelectorAll('#thumbs .th canvas')].map((c) => c.toDataURL()),
    );
    const shotThumbs = await screenshots(page, ['#right', '#thumbs .th']);
    return { opened, state, canvases, shot, model, thumbs: thumbs.map(sha), shotThumbs };
  });
  noErrors(r);
  expect(r.original.opened).toBe(true);
  expect(r.original.state.pages).toBe(3);
  expect(r.original.model[0].blocks.map((b) => b.text)).toContain('Regressionstest');
  expect(r.original.canvases[0]).toBeTruthy();
  expect(r.neubau).toEqual(r.original);
});

test('Text bearbeiten und speichern (Standardschrift)', async ({ browser }) => {
  const r = await runBoth(browser, async (page) => {
    await openPdf(page);
    await chooseTool(page, 'PDF bearbeiten');
    await appendToLine(page, 'Zeilen läuft', 1, ' Ergänzt');
    const state = await uiState(page);
    const block = await findBlock(page, 0, 'Ergänzt');
    const bytes = await savedBytes(page);
    return {
      state,
      block,
      toasts: await toasts(page),
      text: await extractText(bytes),
      bytes: sha(bytes),
      canvases: await canvasHashes(page),
    };
  });
  noErrors(r);
  expect(r.original.text[0]).toContain('Ergänzt');
  expect(r.original.state.undo).toEqual(['Text bearbeitet']);
  expect(r.neubau).toEqual(r.original);
});

test('Text in eingebetteter Schrift mit neuen Zeichen', async ({ browser }) => {
  const r = await runBoth(browser, async (page) => {
    await openPdf(page);
    await chooseTool(page, 'PDF bearbeiten');
    await appendToLine(page, 'Barlow eingebettet', 0, ' Quiz Ü');
    await appendToLine(page, 'Mono 0123456789', 0, ' QX');
    const bytes = await savedBytes(page);
    const fonts = await page.evaluate(() =>
      window.pdfEditor.session.fonts
        .list()
        .map((f) => ({ key: f.key, label: f.label, full: !!window.pdfEditor.session.fonts.fullFor(f) })),
    );
    return {
      state: await uiState(page),
      fonts,
      text: await extractText(bytes),
      bytes: sha(bytes),
      canvases: await canvasHashes(page),
    };
  });
  noErrors(r);
  expect(r.original.text[0]).toContain('Quiz Ü');
  expect(r.original.text[0]).toContain('QX');
  expect(r.neubau).toEqual(r.original);
});

test('Objekte verschieben (Maus, Pfeiltasten) und speichern', async ({ browser }) => {
  const r = await runBoth(browser, async (page) => {
    await openPdf(page);
    await chooseTool(page, 'PDF bearbeiten');
    const before = await objectsOf(page, 0);
    const img = before.find((o) => o.type === 'image');
    const center = await clientPoint(page, 0, (img.vis[0] + img.vis[2]) / 2, (img.vis[1] + img.vis[3]) / 2);
    const guidesFree = await dragBy(page, center, 60, 40);
    const afterImage = await objectsOf(page, 0);
    const selLabel = await page.locator('.sel .tag').textContent();

    // Einrasten: linke Bildkante knapp neben die linke Kante des orangefarbenen Rechtecks (x = 300 pt)
    const scale = await page.evaluate(() => window.pdfEditor.pvs[0].scale);
    const img2 = afterImage.find((o) => o.type === 'image');
    const c2 = await clientPoint(page, 0, (img2.vis[0] + img2.vis[2]) / 2, (img2.vis[1] + img2.vis[3]) / 2);
    const guidesSnap = await dragBy(page, c2, (300 - img2.vis[0]) * scale + 3, -30);
    const afterSnap = await objectsOf(page, 0);

    // Rechteck aus vier Linien: Klick auf die linke Linie wählt die Gruppe
    const [lx, ly] = await clientPoint(page, 0, 56, 440);
    await page.mouse.click(lx, ly);
    const groupLabel = await page.locator('.sel .tag').textContent();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Shift+ArrowUp');
    await page.waitForTimeout(500);
    await idle(page);
    const afterNudge = await objectsOf(page, 0);
    const bytes = await savedBytes(page);
    return {
      before,
      afterImage,
      guidesFree,
      guidesSnap,
      afterSnap,
      afterNudge,
      selLabel,
      groupLabel,
      state: await uiState(page),
      bytes: sha(bytes),
      text: await extractText(bytes),
      canvases: await canvasHashes(page),
    };
  });
  noErrors(r);
  const o = r.original;
  const imgBefore = o.before.find((x) => x.type === 'image');
  const imgAfter = o.afterImage.find((x) => x.type === 'image');
  const scale = 1.25 * (96 / 72);
  expect(imgAfter.vis[0] - imgBefore.vis[0]).toBeCloseTo(60 / scale, 0);
  expect(imgAfter.vis[1] - imgBefore.vis[1]).toBeCloseTo(-40 / scale, 0);
  expect(o.afterSnap.find((x) => x.type === 'image').vis[0]).toBeCloseTo(300, 1);
  expect(o.guidesSnap.length).toBeGreaterThan(0);
  expect(o.groupLabel).toContain('Grafik');
  expect(o.state.undo).toEqual(['Verschoben', 'Verschoben', 'Verschoben']);
  expect(r.neubau).toEqual(r.original);
});

test('Seiten löschen und einfügen (Seitenzahlen, Kopfzeile)', async ({ browser }) => {
  const r = await runBoth(browser, async (page) => {
    await openPdf(page);
    await chooseTool(page, 'Seiten organisieren');
    await expect(page.locator('#org .ocard')).toHaveCount(3);
    await page.waitForFunction(() => window.pdfEditor.org.detected);
    const panel = await page.locator('#lpBody').innerText();
    await page.locator('#org .ocard').nth(1).click();
    await page.locator('#oDel').click();
    await expect(page.locator('#org .ocard')).toHaveCount(2);
    await idle(page);
    const afterDelete = await extractText(await savedBytes(page));
    await page.locator('#org .ogap[data-at="1"] .ins').click();
    await page.locator('.menu .mi', { hasText: 'Leere Seite' }).click();
    const dialogText = await page.locator('.dlg').innerText();
    await page.locator('.dlg .btn.primary').click();
    await expect(page.locator('#org .ocard')).toHaveCount(3);
    await idle(page);
    const bytes = await savedBytes(page);
    return {
      panel,
      afterDelete,
      dialogText,
      state: await uiState(page),
      toasts: await toasts(page),
      text: await extractText(bytes),
      bytes: sha(bytes),
    };
  });
  noErrors(r);
  const o = r.original;
  expect(o.afterDelete).toHaveLength(2);
  expect(o.afterDelete[1]).toContain('2 / 2');
  expect(o.text).toHaveLength(3);
  expect(o.text[1]).toContain('Testdokument PDF-Editor');
  expect(o.text[1]).toContain('2 / 3');
  expect(o.text[2]).toContain('Seite drei');
  expect(o.text[2]).toContain('3 / 3');
  expect(r.neubau).toEqual(r.original);
});

test('Rückgängig und Wiederholen', async ({ browser }) => {
  const r = await runBoth(browser, async (page) => {
    await openPdf(page);
    const original = await extractText(await savedBytes(page));
    await chooseTool(page, 'PDF bearbeiten');
    await appendToLine(page, 'Regressionstest', 0, ' 2');
    const edited = await extractText(await savedBytes(page));
    const steps = [];
    for (const key of ['Control+z', 'Control+y', 'Control+z', 'Control+Shift+z']) {
      await page.keyboard.press(key);
      await idle(page);
      steps.push({
        key,
        state: await uiState(page),
        text: (await extractText(await savedBytes(page)))[0],
        toasts: await toasts(page),
      });
    }
    await page.locator('#bUndo').click();
    await idle(page);
    steps.push({ key: 'Schaltfläche', state: await uiState(page) });
    return { original, edited, steps };
  });
  noErrors(r);
  const o = r.original;
  expect(o.edited[0]).toContain('Regressionstest 2');
  expect(o.steps[0].text).not.toContain('Regressionstest 2');
  expect(o.steps[1].text).toContain('Regressionstest 2');
  expect(o.steps[0].state.redo).toEqual(['Text bearbeitet']);
  expect(r.neubau).toEqual(r.original);
});

test('Zoom (Tastatur, Mausrad, Menü)', async ({ browser }) => {
  const r = await runBoth(browser, async (page) => {
    await openPdf(page);
    const states = [await uiState(page)];
    const step = async (fn) => {
      await fn();
      await idle(page);
      states.push(await uiState(page));
    };
    await step(() => page.keyboard.press('Control+Equal'));
    await step(() => page.keyboard.press('Control+Equal'));
    await step(() => page.keyboard.press('Control+Minus'));
    await step(() => page.keyboard.press('Control+0'));
    const box = await page.locator('#scroller').boundingBox();
    const mouse = [box.x + box.width / 2, box.y + box.height / 2];
    await page.mouse.move(...mouse);
    // PDF-Punkt unter dem Mauszeiger (Seite 1) vor und nach Strg+Mausrad
    const underMouse = () => page.evaluate(([x, y]) => window.pdfEditor.pvs[0].clientToPdf(x, y), mouse);
    const before = await underMouse();
    await step(async () => {
      await page.keyboard.down('Control');
      await page.mouse.wheel(0, -100);
      await page.keyboard.up('Control');
    });
    const after = await underMouse();
    await step(async () => {
      await page.locator('#bZoom').click();
      await page.getByRole('menuitem', { name: '200 %', exact: true }).click();
    });
    await step(async () => {
      await page.locator('#bZoom').click();
      await page.locator('.menu .mi', { hasText: 'Ganze Seite' }).click();
    });
    return {
      states,
      canvases: await canvasHashes(page),
      shot: await screenshots(page, ['.page']),
      wheelAnchor: { before, after },
    };
  });
  noErrors(r);
  const labels = r.original.states.map((s) => s.zoomLabel);
  expect(labels[0]).toBe('125 %');
  expect(labels[1]).toBe('150 %');
  expect(labels[6]).toBe('200 %');
  // Absichtliche Abweichung: Strg+Mausrad zoomt im Neubau um die Mausposition (der Punkt unter
  // dem Zeiger bleibt stehen), das Original behält den Seitenanfang. Dadurch kommen andere Seiten
  // ins Bild und werden in anderer Größe gerendert – verglichen wird die Canvas-Größe daher nur
  // für Seite 1, die in beiden Fällen sichtbar ist.
  const { before, after } = r.neubau.wheelAnchor;
  expect(Math.abs(after[0] - before[0]) * (96 / 72) * 1.5).toBeLessThan(2);
  expect(Math.abs(after[1] - before[1]) * (96 / 72) * 1.5).toBeLessThan(2);
  const comparable = ({ wheelAnchor, ...rest }) => ({
    ...rest,
    states: rest.states.map((s) => ({
      ...s,
      pageSizes: s.pageSizes.map((size, i) => (i === 0 ? size : size.slice(0, 2))),
    })),
  });
  expect(comparable(r.neubau)).toEqual(comparable(r.original));
});

test('Speichern mit Strg+S (Download ohne Dateisystem-Zugriff)', async ({ browser }) => {
  const r = await runBoth(browser, async (page) => {
    await openPdf(page);
    await chooseTool(page, 'PDF bearbeiten');
    await appendToLine(page, 'verwendet wird', 2, ' Ende');
    await page.evaluate(() => {
      delete window.showSaveFilePicker;
      window.showSaveFilePicker = undefined;
    });
    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
    const file = await download.path();
    const { readFile } = await import('node:fs/promises');
    const bytes = await readFile(file);
    await idle(page);
    return {
      name: download.suggestedFilename(),
      bytes: sha(bytes),
      text: await extractText(bytes),
      state: await uiState(page),
      toasts: await toasts(page),
    };
  });
  noErrors(r);
  expect(r.original.name).toBe('dokument.pdf');
  expect(r.original.text[0]).toContain('verwendet wird. Ende');
  expect(r.original.state.dirty).toBe(false);
  expect(r.neubau).toEqual(r.original);
});

test('Textblöcke und Inline-Editor (Blocksatz, Spalten, Liste, Trennung)', async ({ browser }) => {
  const r = await runBoth(browser, async (page) => {
    await openPdf(page, LAYOUT, 'layout.pdf');
    const round = (v) => Math.round(v * 1000) / 1000;
    const model = await page.evaluate(() =>
      window.pdfEditor.session.model(0).blocks.map((b) => ({
        text: b.text,
        align: b.align,
        editable: b.editable,
        why: b.why,
        lines: b.lines.length,
        pitch: Math.round(b.pitch * 1000) / 1000,
        bbox: b.bbox.map((v) => Math.round(v * 1000) / 1000),
      })),
    );
    await chooseTool(page, 'PDF bearbeiten');
    const editors = [];
    for (let k = 0; k < model.length; k++) {
      const b = model[k];
      if (!b.editable) continue;
      const block = await findBlock(page, 0, b.text.split('\n')[0]);
      const line = block.lines[0];
      const [x, y] = await clientPoint(page, 0, (line.x0 + line.ex) / 2, line.y + 2);
      await page.mouse.click(x, y);
      await page.locator('.te').waitFor();
      const info = await page.evaluate(() => {
        const ed = window.pdfEditor.edit.editor;
        const segs = ed
          .collect()
          .map((l) => l.segs.map((sg) => ({ text: sg.text, x: sg.x, y: sg.y, size: sg.size, xs: sg.xs })));
        return {
          mode: ed.mode,
          html: ed.te.innerHTML,
          width: ed.te.style.width,
          frame: [ed.frame.style.left, ed.frame.style.top],
          segs,
        };
      });
      editors.push(info);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !window.pdfEditor.edit.editor && !window.pdfEditor.edit._finishing);
      await settled(page);
      await page.keyboard.press('Escape');
    }
    // Blocksatz-Absatz bearbeiten: Text in der Mitte einfügen
    await appendToLine(page, 'Dieser Absatz', 1, ' NEU');
    const bytes = await savedBytes(page);
    return {
      model,
      editors,
      round: round(1),
      state: await uiState(page),
      text: await extractText(bytes),
      bytes: sha(bytes),
    };
  });
  noErrors(r);
  const o = r.original;
  expect(o.model.map((b) => b.align)).toContain('justify');
  expect(o.editors.length).toBeGreaterThan(5);
  expect(o.text[0]).toContain('NEU');
  expect(o.state.undo).toEqual(['Text bearbeitet']);
  expect(r.neubau).toEqual(r.original);
});

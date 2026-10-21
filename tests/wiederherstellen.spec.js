import { test, expect } from '@playwright/test';
import { launch, openPdf, idle } from './helpers.js';

/**
 * Automatische Wiederherstellung: Kopie kurz nach jeder Änderung, nach einem unerwarteten Ende
 * beim nächsten Start anbieten; nach Speichern, Verwerfen und Schließen keine Kopie mehr.
 */

const copies = (page) =>
  page.evaluate(
    () =>
      new Promise(async (resolve, reject) => {
        // nur lesen, nie selbst anlegen (sonst fehlen der App die Stores)
        if (!(await indexedDB.databases()).some((d) => d.name === 'plantpdf-recovery')) return resolve([]);
        const r = indexedDB.open('plantpdf-recovery');
        r.onsuccess = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('meta')) return resolve([]);
          const all = db.transaction('meta').objectStore('meta').getAll();
          all.onsuccess = () => resolve(all.result.map((m) => m.name));
          all.onerror = () => reject(all.error);
        };
        r.onerror = () => reject(r.error);
      }),
  );

const rotate = (page) =>
  page.evaluate(async () => {
    const app = window.pdfEditor;
    app.session.rotatePages([0], 90);
    await app.sync();
  });

test('Absturz: Kopie wird beim nächsten Start angeboten und wiederhergestellt', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await openPdf(page);
    await rotate(page);
    await idle(page);
    // kurz nach der Änderung liegt eine Kopie vor (Original unverändert)
    await expect.poll(() => copies(page), { timeout: 10_000 }).toEqual(['dokument.pdf']);

    // zweites Fenster, während das erste läuft: nichts anbieten (gehört dem laufenden Fenster)
    const other = await context.newPage();
    await other.goto(page.url());
    await other.waitForTimeout(1500);
    await expect(other.locator('.dlg', { hasText: 'Dokument wiederherstellen' })).toHaveCount(0);
    await other.close();

    // „Absturz“: Fenster ohne Rückfrage weg, neues Fenster mit demselben Speicher
    const url = page.url();
    await page.close({ runBeforeUnload: false });
    const next = await context.newPage();
    const errors2 = [];
    next.on('pageerror', (e) => errors2.push(e.message));
    await next.goto(url);
    const dlg = next.locator('.dlg', { hasText: 'Dokument wiederherstellen' });
    await expect(dlg).toBeVisible({ timeout: 15_000 });
    await expect(dlg).toContainText('dokument.pdf');
    await dlg.locator('.btn', { hasText: 'Wiederherstellen' }).click();
    await expect.poll(() => next.evaluate(() => window.pdfEditor.session && window.pdfEditor.session.pageInfo(0).rotate)).toBe(90);
    // ungespeichert, Name wie vorher; die Kopie gehört jetzt zu diesem Fenster
    expect(await next.evaluate(() => [window.pdfEditor.session.dirty, window.pdfEditor.file.name])).toEqual([true, 'dokument.pdf']);
    await expect(next.locator('#dirtyDot')).toBeVisible();
    expect(await copies(next)).toEqual(['dokument.pdf']);

    // Schließen mit „Nicht speichern“: keine Kopie mehr
    await next.evaluate(() => {
      window.pdfEditor.closeDocument();
    });
    await next.locator('.dlg .btn', { hasText: 'Nicht speichern' }).click();
    await expect.poll(() => copies(next)).toEqual([]);
    expect(errors).toEqual([]);
    expect(errors2).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Speichern löscht die Kopie; Verwerfen beim Start ebenso', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await openPdf(page);
    // offene Textbearbeitung: keine Kopie (der Absatz fehlt solange im Dokument)
    await page.evaluate(() => window.pdfEditor.session.beginEdit(0, null));
    await page.waitForTimeout(4500);
    expect(await copies(page)).toEqual([]);
    await page.evaluate(() => window.pdfEditor.session.cancelEdit());
    await rotate(page);
    await expect.poll(() => copies(page), { timeout: 10_000 }).toEqual(['dokument.pdf']);
    // Speichern (ohne Datei: Download) → Kopie weg
    const download = page.waitForEvent('download');
    await page.evaluate(() => {
      window.showSaveFilePicker = undefined;
      window.pdfEditor.saveAs();
    });
    await download;
    await expect.poll(() => copies(page)).toEqual([]);

    // erneut ändern, „abstürzen“, beim Start verwerfen
    await rotate(page);
    await expect.poll(() => copies(page), { timeout: 10_000 }).toEqual(['dokument.pdf']);
    const url = page.url();
    await page.close({ runBeforeUnload: false });
    const next = await context.newPage();
    await next.goto(url);
    const dlg = next.locator('.dlg', { hasText: 'Dokument wiederherstellen' });
    await expect(dlg).toBeVisible({ timeout: 15_000 });
    await dlg.locator('.btn', { hasText: 'Verwerfen' }).click();
    await expect.poll(() => copies(next)).toEqual([]);
    expect(await next.evaluate(() => window.pdfEditor.session)).toBeNull();
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

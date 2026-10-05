/**
 * Startseite: Kacheln öffnen die Dateiauswahl und starten danach das passende Werkzeug.
 * Nur gegen den Neubau.
 */
import { test, expect } from '@playwright/test';
import { launch, idle, FIXTURE } from './helpers.js';

/** Ersetzt den Öffnen-Dialog durch eine feste Datei (wie nach „Datei auswählen“). */
async function stubOpenDialog(page) {
  await page.evaluate((b64) => {
    window.__dialogCalls = 0;
    window.showOpenFilePicker = async () => {
      window.__dialogCalls++;
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return [{ kind: 'file', name: 'dokument.pdf', getFile: async () => new File([bytes], 'dokument.pdf') }];
    };
  }, FIXTURE.toString('base64'));
}

for (const [id, label, tool] of [
  ['#hEdit', 'Text bearbeiten', 'edit'],
  ['#hImages', 'Bilder & Grafiken', 'edit'],
  ['#hPages', 'Seiten organisieren', 'organize'],
]) {
  test(`Kachel „${label}“ öffnet eine PDF und startet das Werkzeug`, async ({ browser }) => {
    const { page, context } = await launch(browser, 'neubau');
    await stubOpenDialog(page);
    const tile = page.locator(id);
    await expect(tile).toBeVisible();
    await expect(tile).toContainText(label);
    expect(await tile.evaluate((el) => el.tagName)).toBe('BUTTON'); // tastaturbedienbar
    await tile.click();
    await page.waitForFunction(() => window.pdfEditor.session);
    await idle(page);
    expect(await page.evaluate(() => window.__dialogCalls)).toBe(1);
    expect(await page.evaluate(() => window.pdfEditor.tool)).toBe(tool);
    await context.close();
  });
}

test('Abbrechen im Öffnen-Dialog: Startseite bleibt, kein Werkzeug', async ({ browser }) => {
  const { page, context } = await launch(browser, 'neubau');
  await page.evaluate(() => {
    window.showOpenFilePicker = async () => {
      throw new DOMException('abgebrochen', 'AbortError');
    };
  });
  await page.locator('#hPages').click();
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => !!window.pdfEditor.session)).toBe(false);
  await expect(page.locator('#home')).toBeVisible();
  await context.close();
});

test('Startseite: neuer Untertitel, kein „komplett offline“', async ({ browser }) => {
  const { page, context } = await launch(browser, 'neubau');
  const hero = page.locator('.hhero');
  await expect(hero).toContainText('PDFs bearbeiten, ordnen und unterschreiben.');
  await expect(page.locator('#home')).not.toContainText('offline');
  await context.close();
});

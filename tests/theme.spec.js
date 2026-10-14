/**
 * Darstellung: Hell, Dunkel, wie System – in den Einstellungen wählbar, gemerkt, sofort wirksam.
 * Dokumentseiten bleiben weiß. Nur gegen den Neubau.
 */
import { test, expect } from '@playwright/test';
import { launch, openPdf, settled } from './helpers.js';

const theme = (page) => page.evaluate(() => document.documentElement.dataset.theme);
const bg = (page, sel) => page.locator(sel).first().evaluate((el) => getComputedStyle(el).backgroundColor);

test('Einstellungen: Hell/Dunkel wählen, gemerkt nach Neustart, Seiten bleiben weiß', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    expect(await theme(page)).toBe('light');
    // über das Menü „Datei“
    await page.locator('#bFile').click();
    await page.locator('.menu .mi', { hasText: 'Einstellungen' }).click();
    const dlg = page.locator('.dlg');
    await expect(dlg).toContainText('Darstellung');
    await expect(dlg.locator('.theme[aria-checked="true"]')).toHaveAttribute('data-v', 'system');

    await dlg.locator('.theme[data-v="dark"]').click();
    expect(await theme(page)).toBe('dark');
    expect(await bg(page, 'body')).toBe('rgb(21, 24, 29)');
    // Pfeiltasten wechseln die Wahl
    await dlg.locator('.theme[data-v="dark"]').press('ArrowRight');
    await expect(dlg.locator('.theme[aria-checked="true"]')).toHaveAttribute('data-v', 'system');
    await page.keyboard.press('ArrowLeft');
    await expect(dlg.locator('.theme[aria-checked="true"]')).toHaveAttribute('data-v', 'dark');
    await dlg.locator('.btn.primary').click();
    await expect(dlg).toHaveCount(0);

    // Seite der PDF bleibt weiß, die Arbeitsfläche ist dunkel
    await openPdf(page);
    await settled(page);
    expect(await bg(page, '.page')).toBe('rgb(255, 255, 255)');
    expect(await bg(page, '#top')).not.toBe('rgb(255, 255, 255)');

    // nach Neuladen weiterhin dunkel; Strg+, öffnet die Einstellungen
    await page.reload();
    await page.waitForSelector('#home');
    expect(await theme(page)).toBe('dark');
    await page.keyboard.press('Control+,');
    await expect(page.locator('.dlg .theme[aria-checked="true"]')).toHaveAttribute('data-v', 'dark');
    await page.locator('.dlg .theme[data-v="light"]').click();
    expect(await theme(page)).toBe('light');
    expect(await page.evaluate(() => localStorage.getItem('pdfix.theme'))).toBe('light');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

test('Wie System: folgt der Systemeinstellung, auch beim Umschalten', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(() => theme(page)).toBe('dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(() => theme(page)).toBe('light');
    // feste Wahl hat Vorrang vor dem System
    await page.evaluate(() => localStorage.setItem('pdfix.theme', 'dark'));
    await page.reload();
    await page.waitForSelector('#home');
    expect(await theme(page)).toBe('dark');
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

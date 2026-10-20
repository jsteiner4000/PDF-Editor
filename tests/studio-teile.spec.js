import { test, expect } from '@playwright/test';
import { launch } from './helpers.js';

/** Anlagendokumentation: Teile beim Anlegen wählen, Auswahl wird gemerkt, „+“ ergänzt später. */

const types = (page) => page.evaluate(() => window.pdfEditor.studio.project.sections.map((s) => s.type));

test('Anlagendokumentation: nur Lageplan wählen, Auswahl gemerkt, Inhalt automatisch, später ergänzen', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await expect(page.locator('#hNavOwn')).toBeHidden();
    const dlg = page.locator('.dlg');
    await expect(dlg).toContainText('Neue Anlagendokumentation');
    // Vorauswahl beim ersten Mal: alles
    await expect(dlg.locator('input:checked')).toHaveCount(5);
    await expect(dlg).toContainText('Ein Inhaltsverzeichnis kommt automatisch dazu.');
    if (process.env.SHOT) await page.waitForTimeout(500), await page.screenshot({ path: '/tmp/claude-0/-home-user/912f95df-f550-5e83-ae1f-be694ee5b1c1/scratchpad/teile.png' });

    // Alles abwählen: Erstellen gesperrt
    for (const id of ['cover', 'site', 'wiring', 'access', 'photos']) await dlg.locator(`input[value="${id}"]`).uncheck();
    await expect(dlg.locator('.btn.primary')).toBeDisabled();
    await dlg.locator('input[value="site"]').check();
    await expect(dlg.locator('.btn.primary')).toBeEnabled();
    await dlg.locator('.btn.primary').click();
    await expect.poll(() => types(page)).toEqual(['site']);
    // Geräteliste gehört zum Lageplan
    expect(await page.evaluate(() => window.pdfEditor.studio.project.sections[0].showList)).toBe(true);

    // Später ergänzen über „+“: Deckblatt kommt nach oben
    await page.locator('#sdAdd').click();
    await page.locator('.menu .mi', { hasText: 'Deckblatt' }).click();
    await expect.poll(() => types(page)).toEqual(['cover', 'site']);

    // Nächstes Mal ist die letzte Auswahl vorausgewählt; zwei Teile → Inhaltsverzeichnis
    await page.locator('#tHome').click();
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await expect(dlg.locator('input:checked')).toHaveCount(1);
    await dlg.locator('input[value="cover"]').check();
    await dlg.locator('input[value="access"]').check();
    await dlg.locator('.btn.primary').click();
    await expect.poll(() => types(page)).toEqual(['cover', 'toc', 'site', 'access']);

    // Abbrechen legt nichts an
    const id = await page.evaluate(() => window.pdfEditor.studio.project.id);
    await page.locator('#tHome').click();
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await dlg.locator('.btn', { hasText: 'Abbrechen' }).click();
    expect(await page.evaluate(() => window.pdfEditor.studio.project.id)).toBe(id);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

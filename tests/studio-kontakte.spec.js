import { test, expect } from '@playwright/test';
import { launch } from './helpers.js';

/** Deckblatt: Ansprechpartner mit „+“ hinzufügen, Wachschutz; viele Kontakte → Folgeseite; Speichern/Laden. */

test('Ansprechpartner und Wachschutz auf dem Deckblatt', async ({ browser }) => {
  const { page, context, errors } = await launch(browser, 'neubau');
  try {
    await page.locator('#wsDocs').click();
    await page.locator('.tpl[data-tpl="documentation"]').click();
    await page.locator('.dlg .btn.primary', { hasText: 'Erstellen' }).click();
    await page.evaluate(() => window.pdfEditor.studio.select({ kind: 'project' }));
    const add = page.locator('#sdIBody .btn', { hasText: 'Ansprechpartner hinzufügen' });
    await add.click();
    // neues Namensfeld hat den Fokus
    await expect(page.locator('#sdIBody .sd-contact').first().locator('input').first()).toBeFocused();
    const card = page.locator('#sdIBody .sd-contact').first();
    await card.locator('.sd-f', { hasText: 'Name' }).locator('input').fill('Hr. Müller');
    await card.locator('.sd-f', { hasText: 'Funktion' }).locator('input').fill('Haustechnik');
    await card.locator('.sd-f', { hasText: 'Telefon' }).locator('input').fill('+49 171 1234567');
    const guard = page.locator('.sd-grp', { hasText: 'Wachschutz' });
    await guard.locator('.sd-f', { hasText: 'Firma' }).locator('input').fill('Muster Sicherheit');
    await guard.locator('.sd-f', { hasText: 'Notruf' }).locator('input').fill('+49 800 112');
    const cover = () =>
      page.evaluate(() => {
        const st = window.pdfEditor.studio;
        return st.doc.pages.filter((p) => p.kind === 'cover' || p.kind === 'coverinfo').map((p) => p.svg.replace(/<[^>]+>/g, ' '));
      });
    await expect.poll(async () => (await cover())[0]).toContain('+49 800 112');
    const c0 = (await cover())[0];
    expect(c0).toContain('Ansprechpartner');
    expect(c0).toContain('Hr. Müller');
    expect(c0).toContain('Tel. +49 171 1234567');
    expect(c0).toContain('Wachschutz');
    expect(c0).toContain('+49 800 112');
    expect((await cover()).length).toBe(1);

    // viele Ansprechpartner: Fortsetzung auf einer Folgeseite, nichts geht verloren
    await page.evaluate(() => {
      const st = window.pdfEditor.studio;
      st.change('viele', (p) => {
        for (let i = 2; i <= 16; i++) p.contacts.push({ id: 'cx' + i, name: 'Person ' + i, role: 'Rolle', phone: '+49 30 ' + i, email: 'p' + i + '@example.de' });
      });
    });
    await expect.poll(async () => (await cover()).length).toBeGreaterThan(1);
    const all = (await cover()).join(' ');
    for (const n of ['Person 2', 'Person 16', 'Muster Sicherheit']) expect(all).toContain(n);

    // Entfernen per Papierkorb
    await page.evaluate(() => window.pdfEditor.studio.select({ kind: 'project' }));
    const before = await page.locator('#sdIBody .sd-contact').count();
    await page.locator('#sdIBody .sd-contact').last().locator('.sd-user-del').click();
    await expect(page.locator('#sdIBody .sd-contact')).toHaveCount(before - 1);

    // Speichern und Laden behält alles
    const kept = await page.evaluate(() => {
      const p = JSON.parse(window.pdfEditor.studio.serialize());
      return [p.contacts.length, p.contacts[0].phone, p.guard.company];
    });
    expect(kept).toEqual([before - 1, '+49 171 1234567', 'Muster Sicherheit']);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});

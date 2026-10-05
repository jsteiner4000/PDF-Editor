// Vorübergehender Diagnose-Test (nur Zweig win-ci): Geometrie und Schrift der Kopfzeile in 1.0 und Neubau.
import { test, expect } from '@playwright/test';
import { launch, openPdf, idle } from './helpers.js';

async function dump(browser, build) {
  const { page, context } = await launch(browser, build);
  await openPdf(page);
  await page.mouse.move(1, 999);
  await page.waitForTimeout(400);
  await idle(page);
  await page.evaluate(() => {
    for (const m of document.querySelectorAll('.brand .mark, .hhero .mark'))
      m.innerHTML = '<i style="display:block;width:28px;height:28px"></i>';
  });
  const rows = await page.evaluate(() =>
    [...document.querySelectorAll('#top, #top *')].map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const cls = el.className && (el.className.baseVal ?? String(el.className));
      return [el.tagName, cls, r.x.toFixed(2), r.y.toFixed(2), r.width.toFixed(2), r.height.toFixed(2),
        cs.fontFamily.slice(0, 30), cs.fontSize, cs.fontWeight, cs.letterSpacing, cs.color, cs.backgroundColor,
        cs.boxShadow.slice(0, 30), cs.borderBottomColor].join(' | ');
    }),
  );
  await context.close();
  return rows;
}

test('Diagnose Kopfzeile', async ({ browser }) => {
  const a = await dump(browser, 'original');
  const b = await dump(browser, 'neubau');
  const diffs = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    if (a[i] !== b[i]) diffs.push(`#${i}\n  1.0: ${a[i]}\n  neu: ${b[i]}`);
  expect(diffs.join('\n'), `Zeilen 1.0=${a.length} neu=${b.length}`).toBe('');
});

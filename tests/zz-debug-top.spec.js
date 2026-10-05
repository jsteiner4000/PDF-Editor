// Vorübergehender Diagnose-Test (nur Zweig win-ci): Pixelunterschied der Kopfzeile zwischen 1.0 und Neubau.
import { test, expect } from '@playwright/test';
import { launch, openPdf, idle } from './helpers.js';

async function shot(browser, build) {
  const { page, context } = await launch(browser, build);
  await openPdf(page);
  await page.mouse.move(1, 999);
  await page.waitForTimeout(400);
  await idle(page);
  await page.evaluate(() => {
    document.getElementById('nav').style.setProperty('visibility', 'hidden');
    for (const m of document.querySelectorAll('.brand .mark, .hhero .mark'))
      m.innerHTML = '<i style="display:block;width:28px;height:28px"></i>';
  });
  const buf = await page.locator('#top').first().screenshot();
  await context.close();
  return buf.toString('base64');
}

test('Diagnose Kopfzeile', async ({ browser }) => {
  const a = await shot(browser, 'original');
  const b = await shot(browser, 'neubau');
  const { page, context } = await launch(browser, 'neubau');
  const res = await page.evaluate(async ([a, b]) => {
    const load = (s) =>
      new Promise((ok) => {
        const i = new Image();
        i.onload = () => ok(i);
        i.src = 'data:image/png;base64,' + s;
      });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    const px = (img) => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      return g.getImageData(0, 0, img.width, img.height);
    };
    if (ia.width !== ib.width || ia.height !== ib.height) return `Größe: 1.0 ${ia.width}x${ia.height}, neu ${ib.width}x${ib.height}`;
    const A = px(ia), B = px(ib);
    let n = 0, x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1, maxd = 0;
    const samples = [];
    for (let y = 0; y < A.height; y++)
      for (let x = 0; x < A.width; x++) {
        const o = (y * A.width + x) * 4;
        const d = Math.max(...[0, 1, 2, 3].map((k) => Math.abs(A.data[o + k] - B.data[o + k])));
        if (d) {
          n++;
          maxd = Math.max(maxd, d);
          x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
          if (samples.length < 6) samples.push(`(${x},${y}) 1.0=${[...A.data.slice(o, o + 4)]} neu=${[...B.data.slice(o, o + 4)]}`);
        }
      }
    return `Bild ${A.width}x${A.height}; abweichende Pixel: ${n}; Bereich x ${x0}-${x1}, y ${y0}-${y1}; größte Differenz ${maxd}\n${samples.join('\n')}`;
  }, [a, b]);
  await context.close();
  expect(res, 'Pixelvergleich').toBe('IDENTISCH');
});

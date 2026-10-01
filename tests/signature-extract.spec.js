/**
 * Tests der Freistell-Pipeline (src/signature/signature-extract.js) mit synthetischen Bildern:
 * ein Unterschrift-Pfad (Tinte mit weicher Kante) auf weißem Papier sowie auf leicht grauem,
 * verrauschtem Grund mit Helligkeitsverlauf und einer Formularlinie, die den Pfad kreuzt.
 * Läuft ohne Browser direkt in Node.
 */
import { test, expect } from '@playwright/test';
import { extractSignature, otsuThreshold } from '../src/signature/signature-extract.js';

const DPI = 600;
const PX_PER_MM = DPI / 25.4;

/** Deterministischer Zufall (LCG) für das Rauschen. */
function rng(seed = 7) {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0), s / 4294967296);
}

/** Polylinie einer „Unterschrift“: Schleifen + Unterstrich-Bogen, in Pixeln. */
function signaturePath(width, height) {
  const pts = [];
  for (let t = 0; t <= 1; t += 0.0005) {
    const x = width * (0.12 + 0.72 * t) + Math.sin(t * Math.PI * 9) * width * 0.03;
    const y =
      height * (0.45 + 0.22 * Math.sin(t * Math.PI * 7) - 0.12 * t) +
      Math.cos(t * Math.PI * 9) * height * 0.12;
    pts.push([x, y]);
  }
  return pts;
}

/** Abstand eines Punktes zu den Segmenten (über ein Raster beschleunigt). */
function distanceField(width, height, pts) {
  const dist = new Float32Array(width * height).fill(1e9);
  const r = 6;
  for (let k = 1; k < pts.length; k++) {
    const [ax, ay] = pts[k - 1];
    const [bx, by] = pts[k];
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - r));
    const maxX = Math.min(width - 1, Math.ceil(Math.max(ax, bx) + r));
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - r));
    const maxY = Math.min(height - 1, Math.ceil(Math.max(ay, by) + r));
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const t = Math.max(0, Math.min(1, ((x + 0.5 - ax) * dx + (y + 0.5 - ay) * dy) / len2));
        const ex = x + 0.5 - (ax + t * dx);
        const ey = y + 0.5 - (ay + t * dy);
        const d = Math.sqrt(ex * ex + ey * ey);
        const i = y * width + x;
        if (d < dist[i]) dist[i] = d;
      }
  }
  return dist;
}

/**
 * Erzeugt das Testbild. `paper` = Grundhelligkeit, `noise` = Rauschamplitude, `gradient` =
 * Helligkeitsabfall nach rechts, `lineY` = y-Position einer 3 px dicken grauen Formularlinie.
 */
function makeImage({ width = 900, height = 320, paper = 255, noise = 0, gradient = 0, lineY = null } = {}) {
  const pts = signaturePath(width, height);
  const dist = distanceField(width, height, pts);
  const halfWidth = 2.6; // Strichbreite ≈ 5 px ≈ 0,2 mm bei 600 dpi
  const ink = [28, 40, 112];
  const random = rng(11);
  const data = new Uint8ClampedArray(width * height * 4);
  const truth = new Uint8Array(width * height); // 2 = sicher Tinte, 1 = Kante, 0 = Papier
  const lineMask = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let p = paper - gradient * (x / width) + (random() - 0.5) * 2 * noise;
      let rgb = [p, p, p * 0.99];
      if (lineY != null && Math.abs(y + 0.5 - lineY) < 1.5) {
        rgb = [95, 95, 95];
        lineMask[i] = 1;
      }
      const cover = Math.max(0, Math.min(1, halfWidth + 0.5 - dist[i]));
      if (cover > 0) rgb = rgb.map((c, k) => c * (1 - cover) + ink[k] * cover);
      truth[i] = dist[i] < halfWidth - 0.8 ? 2 : dist[i] < halfWidth + 1.5 ? 1 : 0;
      data.set([...rgb.map((c) => Math.max(0, Math.min(255, Math.round(c)))), 255], i * 4);
    }
  return { img: { width, height, data }, truth, lineMask, dist, lineY };
}

/** Alpha des Ergebnisses an Quellkoordinate (x, y) – außerhalb des Zuschnitts 0. */
function alphaAt(result, width, i) {
  const x = i % width;
  const y = (i - x) / width;
  const [x0, y0, x1, y1] = result.bbox;
  if (x < x0 || y < y0 || x >= x1 || y >= y1) return 0;
  return result.image.data[((y - y0) * result.image.width + (x - x0)) * 4 + 3];
}

function score(result, scene) {
  const n = scene.truth.length;
  let inkTotal = 0;
  let inkKept = 0;
  let paperTotal = 0;
  let paperClear = 0;
  let lineTotal = 0;
  let lineClear = 0;
  let crossTotal = 0;
  let crossKept = 0;
  for (let i = 0; i < n; i++) {
    const a = alphaAt(result, scene.img.width, i);
    if (scene.truth[i] === 2) {
      inkTotal++;
      if (a >= 200) inkKept++;
      const y = Math.floor(i / scene.img.width);
      if (scene.lineY != null && Math.abs(y + 0.5 - scene.lineY) < 4) {
        crossTotal++;
        if (a >= 200) crossKept++;
      }
    } else if (scene.truth[i] === 0 && scene.dist[i] > 8) {
      if (scene.lineMask[i]) {
        lineTotal++;
        if (a === 0) lineClear++;
      } else {
        paperTotal++;
        if (a === 0) paperClear++;
      }
    }
  }
  return {
    ink: inkKept / inkTotal,
    paper: paperClear / paperTotal,
    line: lineTotal ? lineClear / lineTotal : 1,
    crossing: crossTotal ? crossKept / crossTotal : null,
  };
}

test('Otsu trennt zwei Helligkeitsgruppen', () => {
  const values = new Float32Array(1000);
  for (let i = 0; i < 1000; i++) values[i] = i < 900 ? 0.02 : 0.8;
  const t = otsuThreshold(values);
  expect(t).toBeGreaterThan(0.02);
  expect(t).toBeLessThan(0.8);
});

test('Unterschrift auf weißem Papier: Tinte deckend, Papier transparent, zugeschnitten', () => {
  const scene = makeImage();
  const result = extractSignature(scene.img, { dpi: DPI });
  expect(result).not.toBeNull();
  const s = score(result, scene);
  expect(s.ink).toBeGreaterThan(0.97);
  expect(s.paper).toBe(1);
  // Zuschnitt: Rand um die Tinte höchstens ca. 1 mm + Kante
  let minX = Infinity;
  let maxX = -1;
  let minY = Infinity;
  let maxY = -1;
  scene.truth.forEach((t, i) => {
    if (!t) return;
    const x = i % scene.img.width;
    const y = (i - x) / scene.img.width;
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  });
  const [x0, y0, x1, y1] = result.bbox;
  const slack = PX_PER_MM * 1.2;
  expect(x0).toBeLessThanOrEqual(minX);
  expect(y0).toBeLessThanOrEqual(minY);
  expect(x1).toBeGreaterThan(maxX);
  expect(y1).toBeGreaterThan(maxY);
  expect(minX - x0).toBeLessThan(slack);
  expect(x1 - maxX).toBeLessThan(slack);
  expect(minY - y0).toBeLessThan(slack);
  expect(y1 - maxY).toBeLessThan(slack);
  // Originalfarbe bleibt erhalten (blaue Tinte)
  const d = result.image.data;
  let r = 0;
  let b = 0;
  let c = 0;
  for (let p = 0; p < d.length; p += 4)
    if (d[p + 3] > 250) {
      r += d[p];
      b += d[p + 2];
      c++;
    }
  expect(b / c).toBeGreaterThan(r / c + 40);
});

test('Grauer, verrauschter Scan mit Verlauf und Formularlinie', () => {
  const scene = makeImage({ paper: 222, noise: 14, gradient: 30, lineY: 160 });
  const result = extractSignature(scene.img, { dpi: DPI });
  expect(result).not.toBeNull();
  const s = score(result, scene);
  expect(s.ink).toBeGreaterThan(0.95);
  expect(s.paper).toBeGreaterThan(0.999);
  expect(s.line).toBeGreaterThan(0.98);
  // wo der Strich die Linie kreuzt, bleibt er erhalten
  expect(s.crossing).toBeGreaterThan(0.95);
  // ohne Linienentfernung bleibt die Formularlinie stehen
  const withLine = extractSignature(scene.img, { dpi: DPI, removeLines: false });
  expect(score(withLine, scene).line).toBeLessThan(0.1);
});

test('Empfindlichkeit und Farboptionen', () => {
  const scene = makeImage({ paper: 230, noise: 10 });
  const low = extractSignature(scene.img, { dpi: DPI, sensitivity: 10 });
  const high = extractSignature(scene.img, { dpi: DPI, sensitivity: 90 });
  expect(high.threshold).toBeLessThan(low.threshold);
  expect(high.inkPixels).toBeGreaterThanOrEqual(low.inkPixels);
  expect(score(high, scene).paper).toBeGreaterThan(0.999);
  const black = extractSignature(scene.img, { dpi: DPI, color: 'black' });
  const blue = extractSignature(scene.img, { dpi: DPI, color: 'blue' });
  const firstInk = (r) => {
    const d = r.image.data;
    for (let p = 0; p < d.length; p += 4) if (d[p + 3] > 0) return [...d.subarray(p, p + 3)];
  };
  expect(firstInk(black)).toEqual([0, 0, 0]);
  expect(firstInk(blue)).toEqual([22, 42, 122]);
});

test('Leeres Papier ergibt keine Unterschrift', () => {
  const blank = makeImage({ width: 400, height: 200, paper: 235, noise: 12 });
  // Pfad wegnehmen: nur Papier
  const { width, height } = blank.img;
  const data = new Uint8ClampedArray(width * height * 4);
  const random = rng(3);
  for (let i = 0; i < width * height; i++) {
    const p = 235 + (random() - 0.5) * 24;
    data.set([p, p, p, 255], i * 4);
  }
  expect(extractSignature({ width, height, data }, { dpi: DPI })).toBeNull();
});

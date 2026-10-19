/**
 * Geometrie des Lageplans: Planfläche, Längen und Flächen in Metern (über den Maßstab), Abstand zu
 * Linien für die Auswahl, Glätten von Freihand-Linien.
 *
 * Punkte im Projekt sind Anteile der Planfläche (0–1); gemessen wird in pt auf der Seite und über
 * die Bezugsstrecke des Maßstabs in Meter umgerechnet.
 */
import { PAGE } from './svg.js';

export const SITE_TOP = 116;
export const SITE_BOTTOM = 770;
const LEGEND_ROW = 16;
/** Feste Legendenhöhe (4 Zeilen): die Planfläche bleibt immer gleich groß, Symbole behalten ihre Stelle. */
export const LEGEND_ROWS = 4;
export const LEGEND_H = 24 + LEGEND_ROWS * LEGEND_ROW;
export { LEGEND_ROW };

/** Planfläche in pt (für alle Lagepläne gleich). */
export const SITE_AREA = Object.freeze({
  x: PAGE.left,
  y: SITE_TOP,
  w: PAGE.right - PAGE.left,
  h: SITE_BOTTOM - SITE_TOP - LEGEND_H - 8,
});

/** Anteil der Planfläche → Seitenpunkt (pt). */
export const toPt = ([fx, fy], a = SITE_AREA) => [a.x + fx * a.w, a.y + fy * a.h];

/** Seitenpunkt (pt) → Anteil der Planfläche, auf die Fläche begrenzt. */
export const toFrac = ([x, y], a = SITE_AREA) => [
  Math.max(0, Math.min(1, (x - a.x) / a.w)),
  Math.max(0, Math.min(1, (y - a.y) / a.h)),
];

const dist = (p, q) => Math.hypot(q[0] - p[0], q[1] - p[1]);

/** Länge eines Linienzugs in pt (Punkte in pt). */
export function pathLength(pts, closed = false) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  if (closed && pts.length > 2) len += dist(pts[pts.length - 1], pts[0]);
  return len;
}

/** Fläche eines Vielecks in pt² (Gaußsche Trapezformel). */
export function polygonArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    s += x0 * y1 - x1 * y0;
  }
  return Math.abs(s) / 2;
}

/** Schwerpunkt eines Vielecks (für den Namen einer Zone); bei entarteten Flächen der Mittelwert. */
export function centroid(pts) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[(i + 1) % pts.length];
    const f = x0 * y1 - x1 * y0;
    a += f;
    cx += (x0 + x1) * f;
    cy += (y0 + y1) * f;
  }
  if (Math.abs(a) < 1e-6) return [pts.reduce((s, p) => s + p[0], 0) / pts.length, pts.reduce((s, p) => s + p[1], 0) / pts.length];
  return [cx / (3 * a), cy / (3 * a)];
}

/** Punkt auf halber Länge eines Linienzugs und Richtung dort (Grad) – für Längenangaben. */
export function midpoint(pts) {
  const half = pathLength(pts) / 2;
  let run = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(pts[i - 1], pts[i]);
    if (run + d >= half && d > 0) {
      const t = (half - run) / d;
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      return { x: x0 + (x1 - x0) * t, y: y0 + (y1 - y0) * t, angle: (Math.atan2(y1 - y0, x1 - x0) * 180) / Math.PI };
    }
    run += d;
  }
  return { x: pts[0][0], y: pts[0][1], angle: 0 };
}

/** Abstand eines Punkts zu einer Strecke (pt). */
export function segDist(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

/** Abstand eines Punkts zu einem Linienzug (pt). */
export function pathDist(p, pts, closed = false) {
  let best = Infinity;
  for (let i = 1; i < pts.length; i++) best = Math.min(best, segDist(p, pts[i - 1], pts[i]));
  if (closed && pts.length > 2) best = Math.min(best, segDist(p, pts[pts.length - 1], pts[0]));
  return best;
}

/** Liegt der Punkt im Vieleck? */
export function inPolygon([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Freihand-Linie vereinfachen (Douglas-Peucker, Toleranz in pt). */
export function simplify(pts, tol = 0.8) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [i, j] = stack.pop();
    let best = 0;
    let at = -1;
    for (let k = i + 1; k < j; k++) {
      const d = segDist(pts[k], pts[i], pts[j]);
      if (d > best) {
        best = d;
        at = k;
      }
    }
    if (best > tol) {
      keep[at] = 1;
      stack.push([i, at], [at, j]);
    }
  }
  return pts.filter((_, k) => keep[k]);
}

/** Meter je pt aus dem Maßstab des Lageplans (oder null ohne Maßstab). */
export function metersPerPt(site) {
  const sc = site && site.scale;
  if (!sc) return null;
  const d = dist(toPt(sc.a), toPt(sc.b));
  return d > 0 ? sc.m / d : null;
}

const fmt = (v, digits, lang) =>
  v.toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE', { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** Länge in Metern lesbar: „8,5 m“, „42 m“, „1,25 km“. */
export function formatLength(m, lang = 'de') {
  if (m >= 1000) return `${fmt(m / 1000, 2, lang)} km`;
  return `${fmt(m, m < 10 ? 1 : 0, lang)} m`;
}

/** Fläche lesbar: „85 m²“, „1.250 m²“, „2,4 ha“. */
export function formatArea(m2, lang = 'de') {
  if (m2 >= 10000) return `${fmt(m2 / 10000, 1, lang)} ha`;
  return `${fmt(m2, m2 < 10 ? 1 : 0, lang)} m²`;
}

/** Maßstabsleiste: runde Länge (1, 2, 5 · 10ⁿ m) mit höchstens `maxPt` pt. */
export function scaleBar(mpp, maxPt = 90) {
  const raw = mpp * maxPt;
  const p = 10 ** Math.floor(Math.log10(raw));
  const m = [5, 2, 1].map((k) => k * p).find((v) => v <= raw) || p;
  return { m, pt: m / mpp };
}

/** Maßstabszahl für den Druck (1 pt = 0,3528 mm): 1 : n, auf zwei gültige Stellen gerundet. */
export function ratio(mpp) {
  const n = (mpp * 1000) / (25.4 / 72);
  const p = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
  return Math.round(n / p) * p;
}

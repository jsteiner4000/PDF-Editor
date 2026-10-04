/**
 * Treffertests für den Bearbeitungsmodus: Geometrie statt Begrenzungsrechteck.
 */
import { boxContains } from './geometry.js';
import { insideFill, nearestNode, nearestSegment, toPage } from '../pdf/path-geometry.js';

/** Toleranz für Linien in Bildschirmpixeln (zusätzlich zur halben Linienbreite). */
export const STROKE_TOLERANCE_PX = 5;

/** Toleranz für Textblöcke in Bildschirmpixeln. */
export const TEXT_TOLERANCE_PX = 2;

/**
 * Bildschirmpixel je PDF-Punkt – über die tatsächliche Darstellungsgröße der Seite, damit es
 * auch bei CSS-skalierter Ansicht (z. B. während einer Zoom-Geste) stimmt.
 */
export function pxPerPt(pv) {
  let k = 1;
  try {
    const width = pv.el.getBoundingClientRect().width;
    if (pv.dw && width) k = width / pv.dw;
  } catch {}
  return pv.scale * (k || 1);
}

/** Teilpfade eines Pfadobjekts in Seitenkoordinaten (zwischengespeichert am Objekt). */
export function pagePaths(obj) {
  if (!obj.geom) return [];
  if (!obj._pagePaths) obj._pagePaths = toPage(obj.geom, obj.ctm);
  return obj._pagePaths;
}

/**
 * Trifft der Punkt (PDF-Koordinaten) das Objekt? Ergebnis:
 *   null – kein Treffer
 *   { ink, px, … } – `px` = Abstand zur sichtbaren Tinte in Bildschirmpixeln (0 in einer gefüllten
 *     Fläche, im Bild und auf dem Strich; sonst Abstand zur Strichkante); `ink` = höchstens 1 px
 * Ungefüllte Pfade sind nur auf ihren Strichen treffbar, nicht im leeren Inneren.
 */
export function objectHit(obj, x, y, ppt) {
  const tol = STROKE_TOLERANCE_PX / ppt;
  const half = (obj.lw || 0) / 2;
  if (!boxContains(obj.vis, x, y, tol + half)) return null;
  if (obj.clipRect && !boxContains(obj.clipRect, x, y, 1 / ppt)) return null;
  if (obj.type !== 'path' || !obj.geom || !obj.geom.subpaths.length)
    return boxContains(obj.vis, x, y, 1 / ppt) ? { ink: true, d: 0, px: 0 } : null;
  const paths = pagePaths(obj);
  if (obj.fill && insideFill(paths, x, y, obj.evenOdd)) return { ink: true, d: 0, px: 0, fill: true };
  const near = nearestSegment(paths, x, y);
  if (!near) return null;
  const px = Math.max(0, near.d - half) * ppt;
  if (px > STROKE_TOLERANCE_PX) return null;
  return { ink: px <= 1, d: near.d, px, sp: near.sp, seg: near.seg, stroke: obj.stroke && px <= 1 };
}

/**
 * Alle getroffenen auswählbaren Objekte, oberstes zuerst (Malreihenfolge rückwärts).
 */
export function objectHits(model, x, y, ppt, filter = null) {
  const out = [];
  const objects = model.objects;
  for (let k = objects.length - 1; k >= 0; k--) {
    const obj = objects[k];
    if (!obj.selectable || (filter && !filter(obj))) continue;
    const h = objectHit(obj, x, y, ppt);
    if (h) out.push({ obj, ...h });
  }
  return out;
}

/** Zwei Abstände gelten als gleich, wenn sie weniger als 0,75 Bildschirmpixel trennt. */
const TIE_PX = 0.75;

/**
 * Bestes Objekt unter dem Zeiger: Es gewinnt das Objekt mit dem kleinsten Abstand zur sichtbaren
 * Tinte (in einer Fläche oder auf dem Strich 0, sonst der Abstand zur Strichkante); bei Gleichstand
 * (Abstände innerhalb von 0,75 px, auch mehrere Treffer mit 0) das oberste. So wählt ein Klick genau
 * auf eine Tabellenlinie diese und nicht die 2 pt entfernte Nachbarlinie, und eine dünne Linie auf
 * einer Fläche bleibt treffbar. `hits` ist nach Malreihenfolge sortiert, oberstes zuerst.
 */
export function pickObject(hits) {
  if (!hits.length) return null;
  const min = Math.min(...hits.map((h) => h.px));
  return hits.find((h) => h.px <= min + TIE_PX) || null;
}

/** Textblock unter dem Zeiger (kleinster zuerst). */
export function blockAt(model, x, y, ppt, tolPx = TEXT_TOLERANCE_PX) {
  const tol = tolPx / ppt;
  const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
  return (
    model.blocks
      .filter((b) => boxContains(b.bbox, x, y, tol))
      .sort((a, b) => area(a.bbox) - area(b.bbox))[0] || null
  );
}

/**
 * Nächster Knoten eines Pfadobjekts: { sp, node, d } oder null. Der Fangradius beträgt höchstens
 * `radiusPx`, aber nie mehr als der halbe Abstand dieses Knotens zu seinem nächsten Nachbarn –
 * in dichten Zeichnungen gewinnt so immer der Knoten, auf den man zielt.
 */
export function nodeAt(obj, x, y, ppt, radiusPx) {
  const paths = pagePaths(obj);
  const n = nearestNode(paths, x, y);
  if (!n) return null;
  const c = paths[n.sp].nodes[n.node];
  let neighbor = Infinity;
  paths.forEach((sp, i) =>
    sp.nodes.forEach((p, k) => {
      if (i === n.sp && k === n.node) return;
      const d = Math.hypot(p[0] - c[0], p[1] - c[1]);
      if (d > 1e-9 && d < neighbor) neighbor = d;
    }),
  );
  const radius = Math.min(radiusPx, (neighbor * ppt) / 2);
  return n.d * ppt <= radius ? n : null;
}

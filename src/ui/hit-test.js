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
 *   { ink: true, d }  – direkt auf dem Strich, in der gefüllten Fläche oder im Bild
 *   { ink: false, d } – innerhalb der Toleranz neben einem Strich/einer Kante
 * Ungefüllte Pfade sind nur auf ihren Strichen treffbar, nicht im leeren Inneren.
 */
export function objectHit(obj, x, y, ppt) {
  const tol = STROKE_TOLERANCE_PX / ppt;
  const half = (obj.lw || 0) / 2;
  if (!boxContains(obj.vis, x, y, tol + half)) return null;
  if (obj.clipRect && !boxContains(obj.clipRect, x, y, 1 / ppt)) return null;
  if (obj.type !== 'path' || !obj.geom || !obj.geom.subpaths.length)
    return boxContains(obj.vis, x, y, 1 / ppt) ? { ink: true, d: 0 } : null;
  const paths = pagePaths(obj);
  if (obj.fill && insideFill(paths, x, y, obj.evenOdd)) return { ink: true, d: 0, fill: true };
  const near = nearestSegment(paths, x, y);
  if (!near) return null;
  if (obj.stroke && near.d <= half + 1 / ppt)
    return { ink: true, d: near.d, sp: near.sp, seg: near.seg, stroke: true };
  if (near.d <= half + tol) return { ink: false, d: near.d, sp: near.sp, seg: near.seg };
  return null;
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

/**
 * Bestes Objekt unter dem Zeiger: Das oberste Objekt, das direkt getroffen ist, gewinnt – außer
 * darüber liegt ein Strich knapp neben dem Zeiger (innerhalb der Toleranz); unter mehreren
 * knappen Treffern gewinnt der nächstgelegene. So ist eine dünne Linie auf einer Fläche
 * treffbar, ohne genau zielen zu müssen.
 */
export function pickObject(hits) {
  let near = null;
  for (const h of hits) {
    if (h.ink) return near || h;
    if (!near || h.d < near.d) near = h;
  }
  return near;
}

/** Textblock unter dem Zeiger (kleinster zuerst). */
export function blockAt(model, x, y, ppt) {
  const tol = TEXT_TOLERANCE_PX / ppt;
  const area = (b) => (b[2] - b[0]) * (b[3] - b[1]);
  return (
    model.blocks
      .filter((b) => boxContains(b.bbox, x, y, tol))
      .sort((a, b) => area(a.bbox) - area(b.bbox))[0] || null
  );
}

/** Nächster Knoten eines Pfadobjekts innerhalb von `radiusPx`: { sp, node, d } oder null. */
export function nodeAt(obj, x, y, ppt, radiusPx) {
  const n = nearestNode(pagePaths(obj), x, y);
  return n && n.d * ppt <= radiusPx ? n : null;
}

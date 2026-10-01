/**
 * Geometrie von Pfadobjekten: Erfassung beim Interpretieren, Abstands- und Flächentests,
 * Transformation und Rückschreiben als Content-Stream-Operatoren.
 *
 * Ein Pfadobjekt (`obj.geom`) besteht aus Teilpfaden im Benutzerraum (vor der CTM):
 *   { nodes: [[x, y], …], segs: [null | { c1: [x, y], c2: [x, y] }, …], closed, re, ops, implicit }
 *   - `segs[i]` verbindet `nodes[i]` mit `nodes[i + 1]` (bzw. bei geschlossenen Teilpfaden das
 *     letzte Segment zurück zu `nodes[0]`); `null` = Gerade, sonst kubische Bézierkurve.
 *   - `re`: Teilpfad stammt aus dem Operator `re` (vier Ecken, gegen den Uhrzeigersinn ab x, y).
 *   - `ops`: Operator-Indizes, aus denen der Teilpfad gebaut wurde (für unveränderte Teilpfade).
 *   - `implicit`: Teilpfad beginnt ohne eigenes `m` (z. B. `l` direkt nach `h`).
 */
import { newOp } from './content-stream.js';
import { invertMatrix, multiplyMatrix, transformPoint } from './matrix.js';

/** Sammelt die Geometrie eines Pfads, während interpretContent() die Operatoren durchläuft. */
export class PathRecorder {
  constructor() {
    this.reset();
  }
  reset() {
    this.subpaths = [];
    this.cur = null;
    this.lastClosedStart = null;
  }
  get empty() {
    return !this.subpaths.length;
  }
  ensureCurrent(opIndex) {
    if (this.cur) return this.cur;
    const start = this.lastClosedStart || [0, 0];
    this.cur = { nodes: [start.slice()], segs: [], closed: false, re: false, ops: [], implicit: true };
    this.subpaths.push(this.cur);
    return this.cur;
  }
  currentPoint() {
    const cur = this.cur;
    return cur ? cur.nodes[cur.nodes.length - 1] : this.lastClosedStart || [0, 0];
  }
  moveTo(opIndex, x, y) {
    this.cur = { nodes: [[x, y]], segs: [], closed: false, re: false, ops: [opIndex], implicit: false };
    this.subpaths.push(this.cur);
  }
  lineTo(opIndex, x, y) {
    const cur = this.ensureCurrent(opIndex);
    cur.nodes.push([x, y]);
    cur.segs.push(null);
    cur.ops.push(opIndex);
  }
  curveTo(opIndex, c1, c2, end) {
    const cur = this.ensureCurrent(opIndex);
    cur.nodes.push(end);
    cur.segs.push({ c1, c2 });
    cur.ops.push(opIndex);
  }
  close(opIndex) {
    const cur = this.cur;
    if (!cur) return;
    cur.closed = true;
    cur.segs.push(null);
    cur.ops.push(opIndex);
    this.lastClosedStart = cur.nodes[0].slice();
    this.cur = null;
  }
  rect(opIndex, x, y, w, h) {
    this.subpaths.push({
      nodes: [
        [x, y],
        [x + w, y],
        [x + w, y + h],
        [x, y + h],
      ],
      segs: [null, null, null, null],
      closed: true,
      re: true,
      ops: [opIndex],
      implicit: false,
    });
    this.cur = null;
    this.lastClosedStart = [x, y];
  }
  take() {
    const subpaths = this.subpaths;
    this.reset();
    return { subpaths };
  }
}

const CURVE_STEPS = 16;

const bezier = (p0, c1, c2, p1, t) => {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * p0[0] + b * c1[0] + c * c2[0] + d * p1[0], a * p0[1] + b * c1[1] + c * c2[1] + d * p1[1]];
};

/** Anzahl der Segmente eines Teilpfads. */
export const segCount = (sp) => sp.segs.length;

/** Endpunkte (Knotenindizes) von Segment `k`. */
export const segEnds = (sp, k) => [k, (k + 1) % sp.nodes.length];

/**
 * Teilpfade in Seitenkoordinaten (PDF-Punkte nach CTM); Kurvenkontrollpunkte ebenfalls.
 */
export function toPage(geom, ctm) {
  const tp = (p) => transformPoint(ctm, p[0], p[1]);
  return geom.subpaths.map((sp) => ({
    ...sp,
    nodes: sp.nodes.map(tp),
    segs: sp.segs.map((s) => (s ? { c1: tp(s.c1), c2: tp(s.c2) } : null)),
  }));
}

/** Teilpfade aus Seitenkoordinaten zurück in den Benutzerraum (inverse CTM). */
export function fromPage(subpaths, ctm) {
  const inv = invertMatrix(ctm);
  const tp = (p) => transformPoint(inv, p[0], p[1]);
  return subpaths.map((sp) => ({
    ...sp,
    nodes: sp.nodes.map(tp),
    segs: sp.segs.map((s) => (s ? { c1: tp(s.c1), c2: tp(s.c2) } : null)),
  }));
}

/** Polylinie eines Segments (Kurven werden in kurze Geraden zerlegt). */
export function flattenSeg(sp, k) {
  const [a, b] = segEnds(sp, k);
  const p0 = sp.nodes[a];
  const p1 = sp.nodes[b];
  const seg = sp.segs[k];
  if (!seg) return [p0, p1];
  const pts = [p0];
  for (let i = 1; i <= CURVE_STEPS; i++) pts.push(bezier(p0, seg.c1, seg.c2, p1, i / CURVE_STEPS));
  return pts;
}

/** Abstand eines Punkts zu einer Strecke und der nächstgelegene Punkt darauf. */
export function pointSegment(px, py, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - a[0]) * dx + (py - a[1]) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx;
  const y = a[1] + t * dy;
  return { d: Math.hypot(px - x, py - y), x, y, t };
}

/**
 * Nächstes Segment zum Punkt (alle Koordinaten in derselben Einheit, z. B. Ebenen-Pixel):
 * { d, sp, seg, x, y } oder null bei leerem Pfad.
 */
export function nearestSegment(subpaths, px, py) {
  let best = null;
  subpaths.forEach((sp, spIndex) => {
    for (let k = 0; k < sp.segs.length; k++) {
      const pts = flattenSeg(sp, k);
      for (let i = 0; i + 1 < pts.length; i++) {
        const r = pointSegment(px, py, pts[i], pts[i + 1]);
        if (!best || r.d < best.d) best = { d: r.d, sp: spIndex, seg: k, x: r.x, y: r.y };
      }
    }
  });
  return best;
}

/** Nächster Knoten zum Punkt: { d, sp, node } oder null. */
export function nearestNode(subpaths, px, py) {
  let best = null;
  subpaths.forEach((sp, spIndex) =>
    sp.nodes.forEach((n, k) => {
      const d = Math.hypot(px - n[0], py - n[1]);
      if (!best || d < best.d) best = { d, sp: spIndex, node: k };
    }),
  );
  return best;
}

/**
 * Liegt der Punkt in der gefüllten Fläche? Teilpfade werden für die Füllung implizit
 * geschlossen; `evenOdd` = Regel f* / B* / b*, sonst Nonzero-Winding.
 */
export function insideFill(subpaths, px, py, evenOdd) {
  let winding = 0;
  let crossings = 0;
  for (const sp of subpaths) {
    if (sp.nodes.length < 2) continue;
    const poly = [];
    for (let k = 0; k < sp.segs.length; k++) poly.push(...flattenSeg(sp, k).slice(0, -1));
    if (!sp.closed) poly.push(sp.nodes[sp.nodes.length - 1]);
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (a[1] <= py) {
        if (b[1] > py && (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]) > 0) {
          winding++;
          crossings++;
        }
      } else if (b[1] <= py && (b[0] - a[0]) * (py - a[1]) - (px - a[0]) * (b[1] - a[1]) < 0) {
        winding--;
        crossings++;
      }
    }
  }
  return evenOdd ? crossings % 2 === 1 : winding !== 0;
}

/** Linienartig: genau ein offener Teilpfad aus einer Geraden (zwei Endpunkte). */
export function isLineLike(obj) {
  const g = obj && obj.type === 'path' && obj.geom;
  if (!g || g.subpaths.length !== 1 || obj.fill) return false;
  const sp = g.subpaths[0];
  return !sp.closed && sp.nodes.length === 2 && sp.segs.length === 1 && !sp.segs[0];
}

/** Kopie der Teilpfade (für Bearbeitungen). */
export function cloneSubpaths(subpaths) {
  return subpaths.map((sp) => ({
    ...sp,
    nodes: sp.nodes.map((n) => n.slice()),
    segs: sp.segs.map((s) => (s ? { c1: s.c1.slice(), c2: s.c2.slice() } : null)),
    ops: sp.ops.slice(),
    changed: false,
  }));
}

/** Wendet die Matrix `m` (Seitenkoordinaten) auf alle Punkte von Teilpfaden in Seitenkoordinaten an. */
export function transformSubpaths(subpaths, m) {
  const tp = (p) => transformPoint(m, p[0], p[1]);
  return subpaths.map((sp) => ({
    ...sp,
    nodes: sp.nodes.map(tp),
    segs: sp.segs.map((s) => (s ? { c1: tp(s.c1), c2: tp(s.c2) } : null)),
    changed: true,
  }));
}

/** Matrix, die Punkte im Benutzerraum wie `m` im Seitenraum bewegt: ctm · m · ctm⁻¹. */
export const userMatrix = (ctm, m) => multiplyMatrix(multiplyMatrix(ctm, m), invertMatrix(ctm));

const EPS = 1e-6;

/** Ist der Teilpfad (Benutzerraum) noch ein achsenparalleles Rechteck in re-Reihenfolge? */
function stillRect(sp) {
  if (!sp.re || sp.nodes.length !== 4 || sp.segs.some(Boolean)) return false;
  const [a, b, c, d] = sp.nodes;
  const near = (u, v) => Math.abs(u - v) < 1e-4;
  return near(a[1], b[1]) && near(b[0], c[0]) && near(c[1], d[1]) && near(d[0], a[0]);
}

/**
 * Operatoren für einen Teilpfad (Benutzerraum). Ein unverändertes `re` bleibt `re`; ein
 * Rechteck, das nach der Änderung kein achsenparalleles Rechteck mehr ist, wird zu m/l/l/l/h.
 */
export function subpathOps(sp) {
  const r = (v) => (Math.abs(v) < EPS ? 0 : Math.round(v * 1e5) / 1e5);
  if (stillRect(sp)) {
    const [a, , c] = sp.nodes;
    return [newOp('re', r(a[0]), r(a[1]), r(c[0] - a[0]), r(c[1] - a[1]))];
  }
  const out = [];
  if (!sp.nodes.length) return out;
  out.push(newOp('m', r(sp.nodes[0][0]), r(sp.nodes[0][1])));
  const n = sp.nodes.length;
  sp.segs.forEach((seg, k) => {
    const isClosing = sp.closed && k === sp.segs.length - 1;
    if (isClosing && !seg) return;
    const end = sp.nodes[(k + 1) % n];
    if (seg)
      out.push(newOp('c', r(seg.c1[0]), r(seg.c1[1]), r(seg.c2[0]), r(seg.c2[1]), r(end[0]), r(end[1])));
    else out.push(newOp('l', r(end[0]), r(end[1])));
  });
  if (sp.closed) out.push(newOp('h'));
  return out;
}

/** Begrenzungsrechteck von Teilpfaden (Kontrollpunkte eingeschlossen). */
export function subpathsBox(subpaths) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  const add = (p) => {
    box[0] = Math.min(box[0], p[0]);
    box[1] = Math.min(box[1], p[1]);
    box[2] = Math.max(box[2], p[0]);
    box[3] = Math.max(box[3], p[1]);
  };
  for (const sp of subpaths) {
    sp.nodes.forEach(add);
    sp.segs.forEach((s) => s && (add(s.c1), add(s.c2)));
  }
  return box;
}

/** SVG-Pfaddaten für Teilpfade, `map` rechnet einen Punkt in Ebenen-Pixel um. */
export function svgPath(subpaths, map) {
  const f = (p) => {
    const q = map(p);
    return q[0].toFixed(2) + ' ' + q[1].toFixed(2);
  };
  let d = '';
  for (const sp of subpaths) {
    if (!sp.nodes.length) continue;
    d += 'M' + f(sp.nodes[0]);
    sp.segs.forEach((seg, k) => {
      const end = sp.nodes[(k + 1) % sp.nodes.length];
      if (sp.closed && k === sp.segs.length - 1 && !seg) return;
      d += seg ? 'C' + f(seg.c1) + ' ' + f(seg.c2) + ' ' + f(end) : 'L' + f(end);
    });
    if (sp.closed) d += 'Z';
  }
  return d;
}

/** SVG-Pfaddaten für ein einzelnes Segment. */
export function svgSegment(sp, k, map) {
  const [a, b] = segEnds(sp, k);
  const f = (p) => {
    const q = map(p);
    return q[0].toFixed(2) + ' ' + q[1].toFixed(2);
  };
  const seg = sp.segs[k];
  return (
    'M' +
    f(sp.nodes[a]) +
    (seg ? 'C' + f(seg.c1) + ' ' + f(seg.c2) + ' ' + f(sp.nodes[b]) : 'L' + f(sp.nodes[b]))
  );
}

/**
 * Hilfslinien und Einrasten beim Verschieben/Skalieren.
 */
import { flattenSeg, pointSegment } from '../pdf/path-geometry.js';
import { pagePaths } from './hit-test.js';

/**
 * Hilfslinien beim Ziehen: Seitenmitte, Seitenränder, häufige linke/rechte Kanten (Satzspiegel)
 * und Kanten/Mitten der übrigen Elemente. `snap()` rastet innerhalb von 6 Bildschirmpixeln ein
 * und liefert die anzuzeigenden Linien; `show()`/`clear()` zeichnen sie als `.guide` in die Ebene.
 *
 * Für Endpunkte und Ankerpunkte rastet `snapPoint()` an Punkten (Endpunkte, Ecken) und Segmenten
 * anderer Objekte ein; `showPoint()` markiert den Fangpunkt.
 */
export class SnapGuides {
  constructor(pv, model, isMoving) {
    this.pv = pv;
    this.model = model;
    this.isMoving = isMoving;
    const width = pv.W;
    const height = pv.H;
    const xs = [];
    const ys = [];
    const addX = (v, kind, a, b) => xs.push({ v, kind, a, b });
    const addY = (v, kind, a, b) => ys.push({ v, kind, a, b });
    addX(width / 2, 'page', 0, height);
    addY(height / 2, 'page', 0, width);
    addX(0, 'edge', 0, height);
    addX(width, 'edge', 0, height);
    addY(0, 'edge', 0, width);
    addY(height, 'edge', 0, width);
    const boxes = [];
    for (const block of model.blocks) if (!isMoving(block)) boxes.push(pv.boxOf(block.bbox));
    for (const obj of model.objects) {
      if (!obj.selectable || obj.background || isMoving(obj)) continue;
      const box = pv.boxOf(obj.vis);
      if (!(box.width < 3 && box.height < 3)) boxes.push(box);
    }
    for (const box of boxes.slice(0, 1500)) {
      const left = box.left;
      const right = box.left + box.width;
      const top = box.top;
      const bottom = box.top + box.height;
      addX(left, 'el', top, bottom);
      addX(right, 'el', top, bottom);
      addX(left + box.width / 2, 'elc', top, bottom);
      addY(top, 'el', left, right);
      addY(bottom, 'el', left, right);
      addY(top + box.height / 2, 'elc', left, right);
    }
    const mostCommon = (values) => {
      const counts = new Map();
      for (const v of values) {
        const key = Math.round(v);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      let best = null;
      let bestCount = 2;
      for (const [key, count] of counts)
        if (count > bestCount) {
          bestCount = count;
          best = key;
        }
      return best;
    };
    const leftMargin = mostCommon(boxes.filter((d) => d.left < width * 0.3).map((d) => d.left));
    const rightMargin = mostCommon(
      boxes.filter((d) => d.left + d.width > width * 0.7).map((d) => d.left + d.width),
    );
    if (leftMargin != null) addX(leftMargin, 'margin', 0, height);
    if (rightMargin != null) addX(rightMargin, 'margin', 0, height);
    this.xs = xs;
    this.ys = ys;
    this.els = [];
    this.k =
      pv.dw && pv.el.getBoundingClientRect().width
        ? (pv.rot % 180 ? pv.H : pv.W) / pv.el.getBoundingClientRect().width
        : 1;
  }
  snap(box, edges = { x: ['l', 'c', 'r'], y: ['t', 'c', 'b'] }) {
    const threshold = 6 * this.k;
    const xEdges = { l: box.left, c: box.left + box.width / 2, r: box.left + box.width };
    const yEdges = { t: box.top, c: box.top + box.height / 2, b: box.top + box.height };
    const findBest = (edgeValues, guides, keys) => {
      let best = null;
      for (const key of keys)
        for (const guide of guides) {
          const delta = guide.v - edgeValues[key];
          if (Math.abs(delta) > threshold) continue;
          const score =
            Math.abs(delta) -
            (guide.kind === 'page' ? 0.6 * this.k : guide.kind === 'margin' ? 0.3 * this.k : 0);
          if (!best || score < best.score) best = { d: delta, g: guide, key, score };
        }
      return best;
    };
    const bestX = findBest(xEdges, this.xs, edges.x || []);
    const bestY = findBest(yEdges, this.ys, edges.y || []);
    const dx = bestX ? bestX.d : 0;
    const dy = bestY ? bestY.d : 0;
    const snapped = { left: box.left + dx, top: box.top + dy, width: box.width, height: box.height };
    const lines = [];
    const lineTolerance = 0.5 * this.k;
    if (bestX) {
      const xs = { l: snapped.left, c: snapped.left + snapped.width / 2, r: snapped.left + snapped.width };
      const seenX = new Set();
      for (const edge of edges.x)
        for (const guide of this.xs)
          if (Math.abs(guide.v - xs[edge]) < lineTolerance && !seenX.has(Math.round(guide.v * 4))) {
            seenX.add(Math.round(guide.v * 4));
            lines.push({
              dir: 'v',
              v: guide.v,
              kind: guide.kind,
              a: Math.min(guide.a, snapped.top),
              b: Math.max(guide.b, snapped.top + snapped.height),
            });
          }
    }
    if (bestY) {
      const ys = { t: snapped.top, c: snapped.top + snapped.height / 2, b: snapped.top + snapped.height };
      const seenY = new Set();
      for (const edge of edges.y)
        for (const guide of this.ys)
          if (Math.abs(guide.v - ys[edge]) < lineTolerance && !seenY.has(Math.round(guide.v * 4))) {
            seenY.add(Math.round(guide.v * 4));
            lines.push({
              dir: 'h',
              v: guide.v,
              kind: guide.kind,
              a: Math.min(guide.a, snapped.left),
              b: Math.max(guide.b, snapped.left + snapped.width),
            });
          }
    }
    return { dx, dy, lines };
  }
  /** Fangziele in Ebenen-Pixeln: Punkte und Strecken (Kurven zerlegt) der übrigen Objekte. */
  pointTargets() {
    if (this._targets) return this._targets;
    const pv = this.pv;
    const map = (p) => pv.pdfToLayer(p[0], p[1]);
    const points = [];
    const segments = [];
    for (const obj of this.model.objects) {
      if (!obj.selectable || obj.background || this.isMoving(obj)) continue;
      if (obj.type === 'path' && obj.geom) {
        for (const sp of pagePaths(obj)) {
          sp.nodes.forEach((n) => points.push(map(n)));
          for (let k = 0; k < sp.segs.length; k++) {
            const pts = flattenSeg(sp, k).map(map);
            for (let i = 0; i + 1 < pts.length; i++) segments.push([pts[i], pts[i + 1]]);
          }
        }
      } else {
        const [x0, y0, x1, y1] = obj.vis;
        const corners = [
          [x0, y0],
          [x1, y0],
          [x1, y1],
          [x0, y1],
        ].map(map);
        points.push(...corners);
        corners.forEach((c, i) => segments.push([c, corners[(i + 1) % 4]]));
      }
      if (points.length > 20000) break;
    }
    this._targets = { points, segments };
    return this._targets;
  }
  /**
   * Fangpunkt für einen Punkt (Ebenen-Pixel): Punkte innerhalb von 8, Segmente innerhalb von
   * 6 Bildschirmpixeln; `extra` = zusätzliche feste Punkte (z. B. andere Knoten desselben Pfads).
   * Ergebnis `{ x, y, kind: 'point' | 'segment' }` oder null.
   */
  snapPoint(x, y, extra = []) {
    const { points, segments } = this.pointTargets();
    let best = null;
    const pointRadius = 8 * this.k;
    for (const p of [...points, ...extra]) {
      const d = Math.hypot(p[0] - x, p[1] - y);
      if (d <= pointRadius && (!best || d < best.d)) best = { x: p[0], y: p[1], d, kind: 'point' };
    }
    if (best) return best;
    const segRadius = 6 * this.k;
    for (const [a, b] of segments) {
      const r = pointSegment(x, y, a, b);
      if (r.d <= segRadius && (!best || r.d < best.d)) best = { x: r.x, y: r.y, d: r.d, kind: 'segment' };
    }
    return best;
  }
  /** Markiert einen Fangpunkt (Kreis für Punkte, Raute für Segmente). */
  showPoint(snap) {
    this.clear();
    if (!snap) return;
    const el = document.createElement('div');
    el.className = 'guide pt ' + snap.kind;
    el.style.left = snap.x + 'px';
    el.style.top = snap.y + 'px';
    this.pv.layer.appendChild(el);
    this.els.push(el);
  }
  show(lines) {
    this.clear();
    for (const line of lines) {
      const el = document.createElement('div');
      const isPageGuide = line.kind === 'page' || line.kind === 'edge' || line.kind === 'margin';
      el.className = 'guide ' + line.dir + (line.kind === 'page' ? ' mid' : isPageGuide ? ' mar' : '');
      if (line.dir === 'v')
        Object.assign(el.style, {
          left: line.v + 'px',
          top: (isPageGuide ? 0 : line.a - 8) + 'px',
          height: (isPageGuide ? this.pv.H : line.b - line.a + 16) + 'px',
        });
      else
        Object.assign(el.style, {
          top: line.v + 'px',
          left: (isPageGuide ? 0 : line.a - 8) + 'px',
          width: (isPageGuide ? this.pv.W : line.b - line.a + 16) + 'px',
        });
      if (line.kind === 'page') {
        const label = document.createElement('span');
        label.textContent = 'Mitte';
        el.appendChild(label);
      }
      this.pv.layer.appendChild(el);
      this.els.push(el);
    }
  }
  clear() {
    for (const el of this.els) el.remove();
    this.els = [];
  }
}

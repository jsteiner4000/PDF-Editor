/**
 * Modus „Pfad bearbeiten“: einzelne Segmente und Ankerpunkte eines Pfadobjekts wählen und verschieben.
 */
import {
  cloneSubpaths,
  deleteNodes,
  deleteSegment,
  detachSegment,
  moveNodes,
  segEnds,
  svgPath,
  svgSegment,
} from '../pdf/path-geometry.js';
import { nodeAt, objectHit, pagePaths, pxPerPt } from './hit-test.js';
import { SnapGuides } from './snap-guides.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Punkte, die näher als dieser Abstand (pt) beieinander liegen, gelten als verbunden. */
const JOIN_TOLERANCE = 0.25;

/** Richtung auf 0°/45°/90° einrasten (Umschalttaste). */
export function constrainAngle(dx, dy) {
  const len = Math.hypot(dx, dy);
  if (!len) return [0, 0];
  const step = Math.PI / 4;
  const angle = Math.round(Math.atan2(dy, dx) / step) * step;
  const proj = dx * Math.cos(angle) + dy * Math.sin(angle);
  const x = proj * Math.cos(angle);
  const y = proj * Math.sin(angle);
  return [Math.abs(x) < 1e-9 ? 0 : x, Math.abs(y) < 1e-9 ? 0 : y];
}

/**
 * Bearbeitung eines Pfadobjekts (über seine `uid`, also auch nach Änderungen am Modell).
 * Auswahl: `nodes` (Menge 'teilpfad:knoten') und optional ein Segment `seg` = { sp, k }.
 * Darstellung (`draw()`): Umriss, ausgewähltes Segment hervorgehoben, Ankerpunkte als
 * Quadrate – hohl = nicht ausgewählt, gefüllt = ausgewählt. Ziehen verschiebt die ausgewählten
 * Ankerpunkte; damit verbundene Punkte (gemeinsame Ecke, zusammenfallende Endpunkte von Pfaden
 * derselben Gruppe) wandern mit, Alt löst die Verbindung (beim Segment: Kante herauslösen).
 */
export class PathEditor {
  constructor(mode, pv, uid) {
    this.mode = mode;
    this.pv = pv;
    this.uid = uid;
    this.nodes = new Set();
    this.seg = null;
    this.hoverSeg = null;
    this.el = null;
    this.nudgeDelta = null;
  }
  get model() {
    return this.mode.session.model(this.pv.index);
  }
  get obj() {
    return this.model.objects.find((o) => o.uid === this.uid) || null;
  }
  /** Pfadobjekte, deren Punkte mit diesem verbunden sein können (eigene Gruppe). */
  members() {
    const obj = this.obj;
    if (!obj) return [];
    const group = obj.cluster ? obj.cluster.members : [obj];
    return [obj, ...group.filter((o) => o !== obj && o.type === 'path' && o.geom)];
  }
  selectSegment(sp, k, add = false) {
    const obj = this.obj;
    if (!obj) return;
    const s = pagePaths(obj)[sp];
    if (!s || k >= s.segs.length) return;
    if (!add) this.nodes.clear();
    for (const n of segEnds(s, k)) this.nodes.add(sp + ':' + n);
    this.seg = add ? null : { sp, k };
  }
  selectNode(sp, k, toggle = false) {
    const key = sp + ':' + k;
    if (toggle) {
      if (this.nodes.has(key)) this.nodes.delete(key);
      else this.nodes.add(key);
    } else if (!this.nodes.has(key)) {
      this.nodes.clear();
      this.nodes.add(key);
    }
    this.seg = null;
  }
  /** Prüft die Auswahl nach Modelländerungen (z. B. Rückgängig); false = Objekt existiert nicht mehr. */
  validate() {
    const obj = this.obj;
    if (!obj || obj.type !== 'path' || !obj.geom) return false;
    const paths = pagePaths(obj);
    for (const key of [...this.nodes]) {
      const [sp, k] = key.split(':').map(Number);
      if (!paths[sp] || k >= paths[sp].nodes.length) this.nodes.delete(key);
    }
    if (this.seg && (!paths[this.seg.sp] || this.seg.k >= paths[this.seg.sp].segs.length)) this.seg = null;
    return true;
  }
  destroy() {
    if (this.el) this.el.remove();
    this.el = null;
    if (this.guides) this.guides.clear();
  }
  layerMap() {
    const pv = this.pv;
    return (p) => pv.pdfToLayer(p[0], p[1]);
  }
  /** Zeichnet Umriss, Segmente und Ankerpunkte; `preview` = [{ obj, paths }] während des Ziehens. */
  draw(preview = null) {
    const obj = this.obj;
    if (!obj) return;
    const pv = this.pv;
    const map = this.layerMap();
    if (!this.el || !this.el.isConnected) {
      this.el = document.createElement('div');
      this.el.className = 'pe';
      pv.layer.appendChild(this.el);
    }
    const paths = (preview && preview.find((p) => p.obj === obj)?.paths) || pagePaths(obj);
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'pe-svg');
    const add = (d, cls) => {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d);
      path.setAttribute('class', cls);
      svg.appendChild(path);
    };
    if (preview) for (const p of preview) if (p.obj !== obj) add(svgPath(p.paths, map), 'outline other');
    add(svgPath(paths, map), 'outline');
    if (this.hoverSeg && paths[this.hoverSeg.sp] && !preview)
      add(svgSegment(paths[this.hoverSeg.sp], this.hoverSeg.k, map), 'seg hov');
    if (this.seg && paths[this.seg.sp]) add(svgSegment(paths[this.seg.sp], this.seg.k, map), 'seg on');
    const frag = document.createDocumentFragment();
    frag.appendChild(svg);
    let anchors = 0;
    paths.forEach((sp, spIndex) =>
      sp.nodes.forEach((n, k) => {
        // sehr große Pfade: höchstens 4000 Ankerpunkte darstellen
        if (++anchors > 4000) return;
        const [x, y] = map(n);
        const a = document.createElement('div');
        a.className = 'pa' + (this.nodes.has(spIndex + ':' + k) ? ' on' : '');
        a.dataset.sp = spIndex;
        a.dataset.k = k;
        a.style.left = x + 'px';
        a.style.top = y + 'px';
        frag.appendChild(a);
      }),
    );
    const box = pv.boxOf(obj.vis);
    const tag = document.createElement('div');
    tag.className = 'pe-tag';
    tag.textContent = 'Pfad bearbeiten';
    tag.style.left = box.left + 'px';
    tag.style.top = box.top + 'px';
    frag.appendChild(tag);
    this.el.replaceChildren(frag);
  }
  setHover(seg) {
    const same = (a, b) => (!a && !b) || (a && b && a.sp === b.sp && a.k === b.k);
    if (same(seg, this.hoverSeg)) return;
    this.hoverSeg = seg;
    this.draw();
  }
  /**
   * Was liegt unter dem Punkt (PDF)? { node } | { seg } | null – immer über die Geometrie: der
   * nächste Knoten (Radius höchstens 14 px und höchstens der halbe Abstand zum Nachbarknoten),
   * es sei denn, ein nicht angrenzendes Segment liegt dem Zeiger näher als dieser Knoten.
   */
  pick(x, y) {
    const obj = this.obj;
    if (!obj) return null;
    const ppt = pxPerPt(this.pv);
    const n = nodeAt(obj, x, y, ppt, 14);
    const h = objectHit(obj, x, y, ppt);
    const seg = h && h.sp != null ? { sp: h.sp, k: h.seg } : null;
    if (n) {
      const s = pagePaths(obj)[seg ? seg.sp : 0];
      const adjacent = !!seg && seg.sp === n.sp && s && segEnds(s, seg.k).includes(n.node);
      if (!seg || adjacent || h.d * ppt >= n.d * ppt) return { node: { sp: n.sp, k: n.node } };
    }
    return seg ? { seg } : null;
  }
  /**
   * Zeiger gedrückt (bereits aufgelöst): wählt Ankerpunkt/Segment und beginnt das Ziehen.
   * Liefert false, wenn der Klick nicht diesen Pfad betrifft.
   */
  onDown(down, gesture) {
    const [x, y] = down.pt;
    const target = this.pick(x, y);
    if (!target) return false;
    let primary;
    let detach = null;
    let wasSelected = false;
    if (target.node) {
      wasSelected = this.nodes.has(target.node.sp + ':' + target.node.k);
      this.selectNode(target.node.sp, target.node.k, down.shift);
      primary = target.node;
    } else {
      const { sp, k } = target.seg;
      if (down.shift) this.selectSegment(sp, k, true);
      else this.selectSegment(sp, k);
      const s = pagePaths(this.obj)[sp];
      const [a, b] = segEnds(s, k);
      const da = Math.hypot(s.nodes[a][0] - x, s.nodes[a][1] - y);
      const db = Math.hypot(s.nodes[b][0] - x, s.nodes[b][1] - y);
      primary = { sp, k: da <= db ? a : b };
      if (down.alt && !down.shift && s.segs.length > 1) detach = { sp, k };
    }
    this.draw();
    if (gesture && this.nodes.size) this.startDrag(gesture, primary, detach, wasSelected);
    return true;
  }
  /** Ausgewählte (und verbundene) Knoten aller betroffenen Objekte, in Seitenkoordinaten. */
  movingSet(base, own, free) {
    const obj = this.obj;
    const moving = new Map(); // obj -> Set(keys)
    const ownKeys = new Set(this.nodes);
    moving.set(obj, ownKeys);
    if (free) return moving;
    const anchors = [...this.nodes].map((key) => {
      const [sp, k] = key.split(':').map(Number);
      return own[sp] && own[sp].nodes[k];
    });
    for (const [member, paths] of base) {
      paths.forEach((sp, spIndex) =>
        sp.nodes.forEach((n, k) => {
          if (anchors.some((p) => p && Math.hypot(p[0] - n[0], p[1] - n[1]) <= JOIN_TOLERANCE)) {
            if (!moving.has(member)) moving.set(member, new Set());
            moving.get(member).add(spIndex + ':' + k);
          }
        }),
      );
    }
    return moving;
  }
  /** Geänderte Pfade (Seitenkoordinaten) für Vorschau und Übernahme. */
  apply(state, dx, dy) {
    const out = [];
    for (const [member, paths] of state.base) {
      const keys = state.moving.get(member);
      out.push({ obj: member, paths: keys && keys.size ? moveNodes(paths, keys, dx, dy) : paths });
    }
    return out;
  }
  startDrag(gesture, primary, detach, primaryWasSelected = false) {
    const primaryKey = primary.sp + ':' + primary.k;
    const pv = this.pv;
    const obj = this.obj;
    const members = this.members();
    const base = new Map(members.map((m) => [m, cloneSubpaths(pagePaths(m))]));
    if (detach) {
      const r = detachSegment(base.get(obj), detach.sp, detach.k);
      base.set(obj, r.subpaths);
      this.nodes = new Set([r.index + ':0', r.index + ':1']);
      this.seg = { sp: r.index, k: 0 };
      const s = r.subpaths[r.index];
      const p0 = pagePaths(obj)[primary.sp].nodes[primary.k];
      primary = { sp: r.index, k: Math.hypot(s.nodes[0][0] - p0[0], s.nodes[0][1] - p0[1]) < 1e-6 ? 0 : 1 };
    }
    const own = base.get(obj);
    // verbundene Punkte wandern mit; mit Alt (jederzeit während des Ziehens umschaltbar) nicht
    const joined = this.movingSet(base, own, !!detach);
    const single = this.movingSet(base, own, true);
    const state = { base, moving: gesture.last && gesture.last.altKey ? single : joined };
    const affected = new Set(joined.keys());
    const start = own[primary.sp].nodes[primary.k];
    const [sx, sy] = pv.clientToPdf(gesture.x0, gesture.y0);
    let guides = null;
    try {
      guides = new SnapGuides(pv, this.model, (o) => affected.has(o));
    } catch {
      guides = null;
    }
    this.guides = guides;
    const map = this.layerMap();
    const fixedPoints = () => {
      const pts = [];
      for (const [member, paths] of base) {
        const keys = joined.get(member) || new Set();
        paths.forEach((sp, i) => sp.nodes.forEach((n, k) => keys.has(i + ':' + k) || pts.push(map(n))));
      }
      return pts;
    };
    let fixed = null;
    let delta = [0, 0];
    let moved = false;
    this.mode.drag = true;
    gesture.attach({
      move: (e) => {
        if (!gesture.moved) return;
        moved = true;
        const [px, py] = pv.clientToPdf(e.clientX, e.clientY);
        let dx = px - sx;
        let dy = py - sy;
        if (e.shiftKey) [dx, dy] = constrainAngle(dx, dy);
        else if (guides && !e.altKey) {
          fixed = fixed || fixedPoints();
          const [lx, ly] = map([start[0] + dx, start[1] + dy]);
          const snap = guides.snapPoint(lx, ly, fixed);
          if (snap) {
            const [tx, ty] = pv.layerToPdf(snap.x, snap.y);
            dx = tx - start[0];
            dy = ty - start[1];
          }
          guides.showPoint(snap);
        }
        if (e.shiftKey || e.altKey) guides && guides.clear();
        state.moving = e.altKey ? single : joined;
        delta = [dx, dy];
        this.draw(this.apply(state, dx, dy));
      },
      end: (reason) => {
        this.mode.drag = false;
        if (guides) guides.clear();
        if (
          reason === 'up' &&
          !moved &&
          primaryWasSelected &&
          this.nodes.size > 1 &&
          !gesture.last.shiftKey
        ) {
          // Klick (ohne Ziehen) auf einen von mehreren gewählten Punkten: nur diesen wählen
          this.nodes = new Set([primaryKey]);
          this.seg = null;
        }
        if (reason !== 'up' || !moved || (!delta[0] && !delta[1] && !detach)) {
          this.draw();
          return;
        }
        const result = this.apply(state, delta[0], delta[1]);
        this.draw(result);
        this.mode.commitPaths(
          pv,
          result
            .filter((r) => state.moving.has(r.obj))
            .map((r) => ({ uid: r.obj.uid, ctm: r.obj.ctm, paths: r.paths })),
          detach ? 'Kante gelöst' : this.nodes.size === 1 ? 'Punkt verschoben' : 'Kante verschoben',
        );
      },
    });
  }
  /**
   * Entf: gewählte Kante bzw. gewählte Ankerpunkte löschen (nicht das ganze Objekt). Eine Kante
   * eines Rechtecks macht daraus einen offenen Linienzug; beim Löschen eines Ankerpunkts werden
   * die Nachbarn verbunden. Bleibt nichts übrig, verschwindet das Objekt. Liefert false, wenn
   * nichts gewählt ist.
   */
  deleteSelected() {
    const obj = this.obj;
    if (!obj || (!this.seg && !this.nodes.size)) return false;
    const paths = cloneSubpaths(pagePaths(obj));
    const label = this.seg ? 'Kante gelöscht' : 'Punkt gelöscht';
    const result = this.seg ? deleteSegment(paths, this.seg.sp, this.seg.k) : deleteNodes(paths, this.nodes);
    this.nodes = new Set();
    this.seg = null;
    this.mode.commitPaths(this.pv, [{ uid: obj.uid, ctm: obj.ctm, paths: result }], label);
    return true;
  }
  /** Pfeiltasten: ausgewählte Ankerpunkte (mit verbundenen) um (dx, dy) pt verschieben. */
  nudge(dx, dy) {
    if (!this.nodes.size) return false;
    this.nudgeDelta = this.nudgeDelta || [0, 0];
    this.nudgeDelta[0] += dx;
    this.nudgeDelta[1] += dy;
    const obj = this.obj;
    const base = new Map(this.members().map((m) => [m, cloneSubpaths(pagePaths(m))]));
    const state = { base, moving: this.movingSet(base, base.get(obj), false) };
    this.draw(this.apply(state, ...this.nudgeDelta));
    clearTimeout(this.nudgeT);
    this.nudgeT = setTimeout(() => this.flushNudge(), 400);
    return true;
  }
  flushNudge() {
    clearTimeout(this.nudgeT);
    const delta = this.nudgeDelta;
    this.nudgeDelta = null;
    if (!delta || (!delta[0] && !delta[1])) return;
    const obj = this.obj;
    if (!obj) return;
    const base = new Map(this.members().map((m) => [m, cloneSubpaths(pagePaths(m))]));
    const state = { base, moving: this.movingSet(base, base.get(obj), false) };
    const result = this.apply(state, delta[0], delta[1]).filter((r) => state.moving.has(r.obj));
    this.mode.commitPaths(
      this.pv,
      result.map((r) => ({ uid: r.obj.uid, ctm: r.obj.ctm, paths: r.paths })),
      this.nodes.size === 1 ? 'Punkt verschoben' : 'Kante verschoben',
    );
  }
}

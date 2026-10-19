/**
 * Lageplan: Werkzeuge zum Zeichnen (Linie, Freihand, Zaun/Zone), Richtfunkstrecken (Punkt-zu-Punkt,
 * Punkt-zu-Mehrpunkt) und Maßstab. Ergänzt die Klasse Studio (Object.assign).
 *
 * Ablauf wie beim Setzen von Symbolen: Werkzeug wählen → im Plan zeichnen bzw. klicken → das Neue
 * ist ausgewählt und lässt sich sofort anpassen; das Werkzeug endet. „Erneut“ (Strg+D) wählt es
 * wieder. Ein Vorgang ist ein Schritt für Rückgängig.
 */
import { $, htmlToElement } from '../ui/dom.js';
import { showDialog, toast } from '../ui/dialogs.js';
import { PAGE } from './svg.js';
import { SHAPE_TYPES, newLink, newShape, newSymbol, symbolInfo, tx } from './model.js';
import { formatLength, inPolygon, metersPerPt, pathDist, segDist, simplify, toFrac, toPt } from './geo.js';

/** Werkzeuge: Kennung → Name (für Hinweis, Wiederholen). */
export const TOOLS = {
  line: 'Linie',
  free: 'Freihand',
  fence: 'Zaun / Zone',
  scale: 'Maßstab',
  ptp: 'Richtfunk Punkt-zu-Punkt',
  ptmp: 'Richtfunk Punkt-zu-Mehrpunkt',
  add: 'Gegenstelle',
};

/** Werkzeug-Kennung aus `armed` ('tool:fence' → 'fence', 'tool:add:<link>' → 'add'), sonst null. */
export const toolOf = (armed) => (typeof armed === 'string' && armed.startsWith('tool:') ? armed.split(':')[1] : null);

const RADIO = '#0891b2';
const CLOSE_PT = 8;
const PICK_PT = 4;

/** Treffer auf einer Zeichnung oder Funkstrecke genau prüfen (sonst nur Rechteck). */
export function hitsShape(h, p) {
  if (h.pts) return (h.closed && inPolygon(p, h.pts)) || pathDist(p, h.pts, h.closed) <= PICK_PT;
  if (h.segs) return h.segs.some(([a, b]) => segDist(p, a, b) <= PICK_PT);
  return true;
}

export const siteTools = {
  /** Text des Hinweises beim Setzen und Zeichnen. */
  armHintText() {
    const tool = toolOf(this.armed);
    const d = this.draft;
    if (!tool) {
      const info = this.armedInfo();
      return `Klicke in den Plan, um „${info ? tx(info.name) : 'Symbol'}“ zu setzen`;
    }
    const n = d ? d.pts.length : 0;
    if (tool === 'line') return 'Ziehe im Plan eine gerade Linie – mit Umschalt in 45°-Schritten';
    if (tool === 'free') return 'Zeichne mit gedrückter Maustaste im Plan';
    if (tool === 'scale') return 'Ziehe eine Strecke, deren Länge du kennst – z. B. von Haus A zu Haus B';
    if (tool === 'fence')
      return n < 2
        ? 'Klicke die Eckpunkte des Zauns nacheinander in den Plan'
        : 'Weiter klicken · Enter oder Doppelklick beendet · Klick auf den ersten Punkt schließt die Zone';
    if (tool === 'ptp') return n ? 'Klicke die Gegenstelle' : 'Klicke die erste Station – oder eine vorhandene Antenne';
    if (tool === 'ptmp')
      return n < 2 ? (n ? 'Klicke die erste Gegenstelle' : 'Klicke die Basisstation – oder eine vorhandene Antenne') : 'Weitere Gegenstellen klicken · Enter oder Doppelklick beendet';
    return 'Klicke die neue Gegenstelle – oder eine vorhandene Antenne';
  },

  /** Werkzeug, Symbol oder nichts wählen; ein angefangener Entwurf wird verworfen. */
  resetDraft() {
    this.draft = null;
    this.renderDraft();
  },

  /** Zuletzt Gewähltes erneut wählen (Strg+D, Knopf „Erneut“). */
  armAgain() {
    if (!this.lastArmed || this.armed) return;
    if (!toolOf(this.lastArmed) && !this.armedInfo(this.lastArmed)) return;
    this.arm(this.lastArmed);
  },

  /** Name des zuletzt Gewählten für den Knopf „Erneut“ (oder null). */
  againLabel(site) {
    const k = this.lastArmed;
    if (!k || !site) return null;
    const tool = toolOf(k);
    if (tool) return tool === 'add' || tool === 'scale' ? null : TOOLS[tool];
    const info = symbolInfo(site, k);
    return info ? tx(info.name) : null;
  },

  /** Werkzeug fertig: Hinweis weg, merken für „Erneut“, Werkzeugband aktualisieren. */
  disarm() {
    const tool = toolOf(this.armed);
    if (this.armed && tool !== 'add' && tool !== 'scale') this.lastArmed = this.armed;
    this.armed = null;
    this.draft = null;
    this.updateArmHint();
    this.renderDraft();
    this.app.renderRibbon();
  },

  /* ---------- Zeiger ---------- */

  /** Punkt (pt) auf die Planfläche begrenzt. */
  clampPt(hit) {
    const a = hit.page.site.area;
    return [Math.max(a.x, Math.min(a.x + a.w, hit.x)), Math.max(a.y, Math.min(a.y + a.h, hit.y))];
  },

  toolDown(ev, hit) {
    const tool = toolOf(this.armed);
    const s = this.section(hit.page.section);
    if (!s || s.type !== 'site') return;
    if (this.draft && this.draft.section !== s.id) this.draft = null;
    const p = this.clampPt(hit);
    ev.preventDefault();
    if (tool === 'line' || tool === 'free' || tool === 'scale') {
      hit.el.setPointerCapture(ev.pointerId);
      this.draft = { section: s.id, page: hit.page, el: hit.el, pts: [p, p], stroke: true };
      if (tool === 'free') this.draft.pts = [p];
      this.drag = { tool: true, el: hit.el, moved: false, startX: ev.clientX, startY: ev.clientY };
      $('#sdScroll').classList.add('dragging');
      return this.renderDraft();
    }
    this.draft ||= { section: s.id, page: hit.page, el: hit.el, pts: [], ids: [] };
    const d = this.draft;
    d.page = hit.page;
    d.el = hit.el;
    if (tool === 'fence') {
      const first = d.pts[0];
      if (d.pts.length >= 3 && Math.hypot(p[0] - first[0], p[1] - first[1]) <= CLOSE_PT) return this.finishFence(true);
      const last = d.pts[d.pts.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) > 1) d.pts.push(p);
    } else {
      // Station: vorhandene Antenne übernehmen, sonst an der Stelle eine neue setzen
      const item = hit.item && hit.item.kind === 'sym' ? s.symbols.find((y) => y.id === hit.item.id) : null;
      const id = item && item.kind === 'radio' ? item.id : null;
      if (id && d.ids.includes(id)) return;
      if (tool === 'add') {
        const link = s.links.find((l) => l.id === this.armed.split(':')[2]);
        if (!link) return this.disarm();
        if (id && (link.from === id || link.to.includes(id))) return toast('Diese Antenne gehört schon zur Strecke.', 'warn', 3000);
      }
      d.pts.push(id ? toPt([item.x, item.y], hit.page.site.area) : p);
      d.ids.push(id);
      if (tool === 'ptp' && d.pts.length === 2) return this.finishLink();
      if (tool === 'add') return this.finishLink();
    }
    this.updateArmHint();
    this.renderDraft();
  },

  /** Zeiger bewegt: Gummiband zur nächsten Ecke bzw. Strich weiterführen. */
  toolMove(ev, hit) {
    const d = this.draft;
    if (!d) return;
    const r = d.el.getBoundingClientRect();
    const a = d.page.site.area;
    let p = [((ev.clientX - r.left) / r.width) * PAGE.w, ((ev.clientY - r.top) / r.height) * PAGE.h];
    p = [Math.max(a.x, Math.min(a.x + a.w, p[0])), Math.max(a.y, Math.min(a.y + a.h, p[1]))];
    const tool = toolOf(this.armed);
    if (d.stroke) {
      if (this.drag) this.drag.moved ||= Math.hypot(ev.clientX - this.drag.startX, ev.clientY - this.drag.startY) > 2;
      if (tool === 'free') {
        const last = d.pts[d.pts.length - 1];
        if (Math.hypot(p[0] - last[0], p[1] - last[1]) >= 1.2) d.pts.push(p);
      } else {
        const p0 = d.pts[0];
        if (ev.shiftKey && tool === 'line') {
          const len = Math.hypot(p[0] - p0[0], p[1] - p0[1]);
          const ang = Math.round(Math.atan2(p[1] - p0[1], p[0] - p0[0]) / (Math.PI / 4)) * (Math.PI / 4);
          p = [p0[0] + len * Math.cos(ang), p0[1] + len * Math.sin(ang)];
        }
        d.pts[1] = p;
      }
    } else if (hit === undefined || d.pts.length) d.hover = p;
    this.renderDraft();
  },

  /** Maustaste los: Linie, Freihand oder Maßstab abschließen. */
  toolUp(ev, cancel) {
    const d = this.draft;
    const drag = this.drag;
    this.drag = null;
    $('#sdScroll').classList.remove('dragging');
    if (drag.el.hasPointerCapture(ev.pointerId)) drag.el.releasePointerCapture(ev.pointerId);
    if (!d || cancel) return this.resetDraft();
    const tool = toolOf(this.armed);
    const len = d.pts.length > 1 ? Math.hypot(d.pts[d.pts.length - 1][0] - d.pts[0][0], d.pts[d.pts.length - 1][1] - d.pts[0][1]) : 0;
    if (!drag.moved || (tool !== 'free' && len < 4) || (tool === 'free' && d.pts.length < 3)) return this.resetDraft();
    if (tool === 'scale') return this.finishScale();
    const s = this.section(d.section);
    const pts = (tool === 'free' ? simplify(d.pts, 0.7) : d.pts).map((q) => toFrac(q, d.page.site.area));
    const z = newShape(tool, pts, this.shapeColor || undefined);
    this.change(tool === 'free' ? 'Freihand gezeichnet' : 'Linie gezeichnet', () => s.shapes.push(z));
    this.disarm();
    this.select({ kind: 'shape', id: z.id, section: s.id });
  },

  /** Zaun abschließen: offen (Enter, Doppelklick) oder als Zone (Klick auf den ersten Punkt). */
  finishFence(closed = false) {
    const d = this.draft;
    if (!d || d.pts.length < 2) return;
    if (closed && d.pts.length < 3) closed = false;
    const s = this.section(d.section);
    const z = newShape('fence', d.pts.map((q) => toFrac(q, d.page.site.area)), this.fenceColor || undefined);
    z.closed = closed;
    this.change(closed ? 'Zone gezeichnet' : 'Zaun gezeichnet', () => s.shapes.push(z));
    this.disarm();
    this.select({ kind: 'shape', id: z.id, section: s.id });
    if (closed) setTimeout(() => this.inspector.focusFirst(), 0);
  },

  /** Richtfunkstrecke anlegen bzw. Gegenstelle ergänzen – neue Antennen in einem Schritt mit. */
  finishLink() {
    const d = this.draft;
    const tool = toolOf(this.armed);
    if (!d) return;
    const s = this.section(d.section);
    const area = d.page.site.area;
    const need = tool === 'add' ? 1 : 2;
    if (d.pts.length < need) return;
    const fresh = [];
    const ids = d.pts.map((p, i) => {
      if (d.ids[i]) return d.ids[i];
      const [fx, fy] = toFrac(p, area);
      const y = newSymbol('radio', fx, fy);
      fresh.push(y);
      return y.id;
    });
    let link;
    if (tool === 'add') {
      link = s.links.find((l) => l.id === this.armed.split(':')[2]);
      if (!link) return this.disarm();
      this.change('Gegenstelle hinzugefügt', () => {
        s.symbols.push(...fresh);
        link.to.push(ids[0]);
      });
    } else {
      link = newLink(tool, ids[0], ids.slice(1));
      this.change(tool === 'ptp' ? 'Richtfunkstrecke angelegt' : 'Richtfunk Punkt-zu-Mehrpunkt angelegt', () => {
        s.symbols.push(...fresh);
        s.links.push(link);
      });
    }
    this.disarm();
    this.select({ kind: 'link', id: link.id, section: s.id });
  },

  /** Bezugsstrecke gezogen: Länge erfragen und als Maßstab übernehmen. */
  async finishScale() {
    const d = this.draft;
    const s = this.section(d.section);
    const [a, b] = d.pts.map((q) => toFrac(q, d.page.site.area));
    this.disarm();
    const m = await this.askLength(s.scale ? s.scale.m : null);
    if (!m) return;
    this.change('Maßstab festgelegt', () => (s.scale = { a, b, m }), { inspector: true });
    this.select({ kind: 'section', id: s.id });
  },

  /** Dialog: Länge der Bezugsstrecke in Metern. */
  async askLength(value) {
    const body = htmlToElement(
      `<div><p class="dlg-text">Wie lang ist die gezogene Strecke in Wirklichkeit? Daraus ergibt sich der Maßstab – alle Längen und Flächen im Plan werden in Metern angegeben.</p><label class="dlg-row">Länge <input class="fld" type="number" min="0.01" step="0.01" inputmode="decimal" style="width:110px" value="${value || ''}" aria-label="Länge in Metern"> m</label></div>`,
    );
    const read = (el) => {
      const v = Number(String(el.querySelector('input').value).replace(',', '.'));
      return v > 0 && v < 1e6 ? v : null;
    };
    setTimeout(() => body.querySelector('input').focus(), 0);
    const m = await showDialog({
      title: 'Maßstab festlegen',
      icon: 'ruler',
      body,
      buttons: [
        { label: 'Abbrechen', value: null },
        { label: 'Übernehmen', primary: true, value: read },
      ],
    });
    if (m === undefined || m === null) return null;
    if (!m) toast('Bitte eine Länge größer als 0 eingeben.', 'warn', 4000);
    return m || null;
  },

  /** Enter: Zaun offen beenden bzw. Punkt-zu-Mehrpunkt abschließen. */
  finishDraft() {
    const tool = toolOf(this.armed);
    if (!this.draft) return false;
    if (tool === 'fence' && this.draft.pts.length >= 2) return this.finishFence(false), true;
    if (tool === 'ptmp' && this.draft.pts.length >= 2) return this.finishLink(), true;
    return false;
  },

  /** Rückschritt beim Zaun bzw. bei den Stationen: letzten Punkt entfernen. */
  undoPoint() {
    const d = this.draft;
    if (!d || !d.pts.length || d.stroke) return false;
    d.pts.pop();
    if (d.ids) d.ids.pop();
    this.updateArmHint();
    this.renderDraft();
    return true;
  },

  /* ---------- Darstellung im Editor (nicht in der PDF) ---------- */

  /** Überlagerung für eine Seite: SVG in Seitenkoordinaten (pt). */
  overlay(el, cls) {
    const marks = el.querySelector('.sd-marks');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', cls);
    svg.setAttribute('viewBox', `0 0 ${PAGE.w} ${PAGE.h}`);
    svg.setAttribute('preserveAspectRatio', 'none');
    marks.appendChild(svg);
    return svg;
  },

  /** Entwurf (angefangene Linie, Zaun, Funkstrecke) zeichnen. */
  renderDraft() {
    for (const old of document.querySelectorAll('#sdPages .sd-draft')) old.remove();
    const d = this.draft;
    if (!d || !this.doc) return;
    // Seiten werden beim Neusatz ersetzt: Plan des Abschnitts neu suchen
    const index = this.doc.pages.findIndex((p) => p.section === d.section && p.site);
    const el = document.querySelectorAll('#sdPages .sd-page')[index];
    if (index < 0 || !el) return;
    d.page = this.doc.pages[index];
    d.el = el;
    const tool = toolOf(this.armed);
    const svg = this.overlay(d.el, 'sd-ovl sd-draft');
    const pts = d.hover && !d.stroke ? [...d.pts, d.hover] : d.pts;
    const pl = (list) => list.map((p) => p.join(',')).join(' ');
    let html = '';
    if (tool === 'ptp' || tool === 'ptmp' || tool === 'add') {
      let base = d.pts[0];
      if (tool === 'add') {
        const s = this.section(d.section);
        const link = s && s.links.find((l) => l.id === this.armed.split(':')[2]);
        const from = link && s.symbols.find((y) => y.id === link.from);
        base = from ? toPt([from.x, from.y], d.page.site.area) : null;
      }
      const targets = tool === 'add' ? pts : pts.slice(1);
      if (base) for (const q of targets) html += `<line x1="${base[0]}" y1="${base[1]}" x2="${q[0]}" y2="${q[1]}" stroke="${RADIO}" stroke-width="1.5" stroke-dasharray="5 3"/>`;
      for (const q of d.pts) html += `<circle cx="${q[0]}" cy="${q[1]}" r="6" fill="${RADIO}" fill-opacity="0.85" stroke="#fff" stroke-width="1.2"/>`;
    } else if (pts.length) {
      const col = tool === 'scale' ? 'var(--acc)' : '#1f66e5';
      html += `<polyline points="${pl(pts)}" fill="none" stroke="${col}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"${tool === 'scale' ? ' stroke-dasharray="4 3"' : ''}/>`;
      if (tool === 'fence' || tool === 'scale' || tool === 'line')
        for (const [i, q] of d.pts.entries())
          html += `<circle cx="${q[0]}" cy="${q[1]}" r="${tool === 'fence' && i === 0 && d.pts.length >= 3 ? 4.2 : 2.6}" fill="#fff" stroke="${col}" stroke-width="1.2"/>`;
      // Länge schon beim Zeichnen zeigen (mit Maßstab)
      const s = this.section(d.section);
      const mpp = metersPerPt(s);
      if (mpp && pts.length > 1 && tool !== 'scale') {
        let len = 0;
        for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
        const q = pts[pts.length - 1];
        html += `<text x="${q[0] + 6}" y="${q[1] - 6}" class="sd-ovl-len">${formatLength(len * mpp)}</text>`;
      }
    }
    svg.innerHTML = html;
  },

  /** Auswahl einer Zeichnung, Funkstrecke oder der Bezugsstrecke im Editor hervorheben. */
  renderSiteSelection(el, page) {
    const { kind, id } = this.sel;
    const site = page.site;
    if (!site) return;
    const s = this.section(page.section);
    if (kind === 'shape') {
      const z = site.shapes.find((x) => x.id === id);
      if (!z) return;
      const svg = this.overlay(el, 'sd-ovl');
      const tag = z.closed ? 'polygon' : 'polyline';
      svg.innerHTML = `<${tag} points="${z.pts.map((p) => p.join(',')).join(' ')}" class="sd-ovl-sel"/>`;
      if (z.type !== 'free')
        z.pts.forEach((p, i) => {
          const h = htmlToElement(`<span class="sd-handle sd-vertex" data-i="${i}" title="Punkt ziehen"></span>`);
          h.style.left = p[0] * this.scale + 'px';
          h.style.top = p[1] * this.scale + 'px';
          el.querySelector('.sd-marks').appendChild(h);
        });
    } else if (kind === 'link') {
      const l = site.links.find((x) => x.id === id);
      if (!l) return;
      const svg = this.overlay(el, 'sd-ovl');
      svg.innerHTML = l.segs.map(([a, b]) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" class="sd-ovl-sel"/>`).join('');
    } else if (kind === 'section' && s && s.scale) {
      // Bezugsstrecke des Maßstabs (nur im Editor)
      const [a, b] = [toPt(s.scale.a, site.area), toPt(s.scale.b, site.area)];
      const svg = this.overlay(el, 'sd-ovl');
      svg.innerHTML =
        `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" class="sd-ovl-ref"/>` +
        `<circle cx="${a[0]}" cy="${a[1]}" r="2.4" class="sd-ovl-end"/><circle cx="${b[0]}" cy="${b[1]}" r="2.4" class="sd-ovl-end"/>` +
        `<text x="${(a[0] + b[0]) / 2}" y="${(a[1] + b[1]) / 2 - 5}" class="sd-ovl-len" text-anchor="middle">Bezug ${formatLength(s.scale.m)}</text>`;
    }
  },

  /** Hervorhebung beim Überfahren einer Zeichnung oder Funkstrecke. */
  hoverShape(hit) {
    const svg = this.overlay(hit.el, 'sd-ovl sd-hov-ovl');
    const h = hit.item;
    svg.innerHTML = h.pts
      ? `<${h.closed ? 'polygon' : 'polyline'} points="${h.pts.map((p) => p.join(',')).join(' ')}" class="sd-ovl-hov"/>`
      : h.segs.map(([a, b]) => `<line x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}" class="sd-ovl-hov"/>`).join('');
  },

  /* ---------- Zeichnungen verschieben ---------- */

  startShapeDrag(ev, hit, mode, index = -1) {
    const s = this.section(hit.page.section);
    const z = s && s.shapes.find((x) => x.id === this.sel.id);
    if (!z) return;
    ev.preventDefault();
    hit.el.setPointerCapture(ev.pointerId);
    this.drag = {
      site: true,
      mode,
      shape: z,
      index,
      start: [hit.x, hit.y],
      orig: z.pts.map((p) => p.slice()),
      area: hit.page.site.area,
      el: hit.el,
      startX: ev.clientX,
      startY: ev.clientY,
      before: this.snap,
      moved: false,
    };
    $('#sdScroll').classList.add('dragging');
  },

  shapeDragMove(d, px, py, shift) {
    const z = d.shape;
    const a = d.area;
    if (d.mode === 'shape') {
      let dx = (px - d.start[0]) / a.w;
      let dy = (py - d.start[1]) / a.h;
      // ganze Zeichnung bleibt in der Planfläche
      for (const [x, y] of d.orig) {
        dx = Math.max(-x, Math.min(1 - x, dx));
        dy = Math.max(-y, Math.min(1 - y, dy));
      }
      z.pts = d.orig.map(([x, y]) => [x + dx, y + dy]);
      return;
    }
    let p = [px, py];
    if (shift && z.type === 'line') {
      const other = toPt(d.orig[1 - d.index], a);
      const len = Math.hypot(p[0] - other[0], p[1] - other[1]);
      const ang = Math.round(Math.atan2(p[1] - other[1], p[0] - other[0]) / (Math.PI / 4)) * (Math.PI / 4);
      p = [other[0] + len * Math.cos(ang), other[1] + len * Math.sin(ang)];
    }
    z.pts[d.index] = toFrac(p, a);
  },

  /** Hintergrund geändert: ein vorhandener Maßstab passt womöglich nicht mehr. */
  checkScale(site) {
    if (site.scale) toast('Hintergrund geändert – bitte den Maßstab prüfen (Lageplan › Maßstab › Neu ziehen).', 'warn', 6000);
  },

  /* ---------- Löschen, Antennen ---------- */

  /** Antennen entfernt: Strecken ohne Basis oder ohne Gegenstelle fallen weg. */
  dropStations(s, ids) {
    for (const l of s.links) l.to = l.to.filter((t) => !ids.has(t));
    s.links = s.links.filter((l) => !ids.has(l.from) && l.to.length);
  },

  /** Name einer Zeichnung („Zaun“, „Zone“, „Linie“, „Freihand“). */
  shapeName(z) {
    return tx(SHAPE_TYPES[z.closed ? 'zone' : z.type]);
  },
};

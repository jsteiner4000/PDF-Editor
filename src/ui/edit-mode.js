/**
 * Modus "PDF bearbeiten": Auswahl, Verschieben, Größe ändern, Text bearbeiten, Bilder.
 */
import { fontKey, parseFontName } from '../fonts/font-manager.js';
import { icon } from './icons.js';
import { $, $$, escapeHtml, htmlToElement } from './dom.js';
import { showMenu } from './menu.js';
import { pickFiles, showDialog, toast, withBusy } from './dialogs.js';
import { idbPut } from '../storage/idb.js';
import { SnapGuides } from './snap-guides.js';
import { TextEditor } from './text-editor.js';
import { SignatureTool } from './signature-panel.js';
import { boxContains, boxInside, hexToRgb, mmToPt, ptToMm, rgbToHex, unionBoxes } from './geometry.js';
import { Gesture } from './gesture.js';
import { blockAt, objectHit, objectHits, pagePaths, pickObject, pxPerPt } from './hit-test.js';
import { PathEditor, constrainAngle } from './path-edit.js';
import {
  cloneSubpaths,
  fromPage,
  isLineLike,
  moveNodes,
  subpathsBox,
  svgPath,
} from '../pdf/path-geometry.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Griffe ab dieser Rahmengröße (Bildschirmpixel) anzeigen, damit sie nie übereinanderliegen. */
const HANDLE_MIN_SIDE = 24;
const HANDLE_MID_SIDE = 56;

/** Mindestabstand (px) der Mittelpunkte der beiden Endpunkt-Griffe einer Linie. */
const HANDLE_SPACING = 30;

/** Versatz (px) der Mittelgriffe nach außen bei Pfadauswahl (28-px-Trefferfläche berührt die Kante). */
const HANDLE_OUTSET = 15;

const isTranslationMatrix = (m) => m[0] === 1 && m[3] === 1 && m[1] === 0 && m[2] === 0;

/**
 * Modus „PDF bearbeiten“: Auswahl, Verschieben, Größe ändern, Drehen, Ebenen, Text und Bilder.
 *
 * Zeigerereignisse (registriert in `wire()` auf #pages):
 *   pointerdown → `onDown()`, pointermove → `onHover()`, contextmenu → `onContext()`,
 *   dblclick → Text bzw. Pfad bearbeiten.
 *
 * Gesten: `onDown()` legt synchron eine `Gesture` an (Pointer-Capture, pointerup/-cancel,
 * lostpointercapture, Esc). Ist noch eine Textbearbeitung oder eine Änderung in Arbeit, wird der
 * Klick erst danach ausgewertet (`resolveDown()`); wurde die Taste bis dahin schon losgelassen,
 * wird nur ausgewählt, nie gezogen. Ein Zug unter 3 px gilt als Klick.
 *
 * Änderungen laufen nacheinander über `enqueue()` (exklusiv zur Speicherung, siehe
 * PdfSession.exclusive) und beziehen sich auf feste Ziele: die `uid` der Objekte zum Zeitpunkt des
 * Ziehbeginns. Danach wird die Auswahl über die uid aktualisiert; ein Generationszähler
 * (`selGen`) verhindert, dass eine spät fertige Änderung eine neuere Auswahl überschreibt.
 *
 * Auswahl: `this.sel = { pv, objs, blocks, el }`; `drawSelection()` zeichnet den Rahmen `.sel`
 * mit Griffen `.h` (data-h = nw|n|ne|e|se|s|sw|w, bei Linien p0|p1 für die Endpunkte).
 * Treffer: `hit()` über die Geometrie (hit-test.js): Strichabstand statt Rechteck, leeres Inneres
 * ungefüllter Pfade ist nicht treffbar, Toleranzen in Bildschirmpixeln.
 * Doppelklick oder Klick auf ein ausgewähltes Pfadobjekt öffnet „Pfad bearbeiten“ (`this.pe`).
 * Pfeiltasten sammeln Verschiebungen in `this.nudge` und übernehmen sie nach 400 ms (`flushNudge`).
 */
export class EditMode {
  constructor(app) {
    this.app = app;
    this.editor = null;
    this.sel = null;
    this.selGen = 0;
    this.pe = null;
    this.gesture = null;
    this.downSeq = 0;
    this.armed = null;
    this.lastStyle = null;
    this._finishing = null;
    this._committing = null;
    this._queue = Promise.resolve();
    this.pendingOps = 0;
  }
  get session() {
    return this.app.session;
  }
  /**
   * Läuft noch etwas (Änderung, gesammelte Pfeiltasten, Textübernahme)? Wird von den Tests
   * (tests/helpers.js: `settled()`/`idle()`) abgefragt, um auf das Ende von Änderungen zu warten.
   */
  get busy() {
    return !!(this.pendingOps || this.nudge || (this.pe && this.pe.nudgeDelta) || this._finishing);
  }
  reset() {
    document.body.classList.remove('editing');
    if (this.gesture) this.gesture.cancel();
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
    if (this.pe) this.pe.destroy();
    this.pe = null;
    clearTimeout(this.nudgeT);
    this.nudge = null;
    this.lastDown = null; // hält sonst die Seitenansicht des letzten Klicks fest
    this.pendingReselect = null;
    this.sel = null;
    this.armed = null;
    this.active = false;
  }
  enter() {
    this.active = true;
    $('#pages').classList.add('mode-edit');
    const ctx = $('#ctx');
    ctx.classList.remove('hidden');
    ctx.innerHTML = `<span class="title">PDF bearbeiten</span>
      <button class="btn" id="cAddText">${icon('textbox', 's')}Text hinzufügen</button>
      <button class="btn" id="cAddImg">${icon('image', 's')}Bild hinzufügen</button>
      <span class="chip" id="cHint">Klick in Text: bearbeiten · Pfeiltasten: verschieben · Alt+Klick: Element dahinter</span>
      <div class="grow"></div>
      <button class="btn outline" id="cDone">${icon('check', 's')}Fertig</button>`;
    $('#cAddText').addEventListener('click', () => this.arm(this.armed === 'text' ? null : 'text'));
    $('#cAddImg').addEventListener('click', () => this.pickImage());
    (this.signature ||= new SignatureTool(this)).mountToolbar($('#cAddImg'));
    $('#cDone').addEventListener('click', () => this.app.setTool(null));
    if (!this.wired) this.wire();
    this.updatePanel();
    for (const pv of this.app.pvs) if (pv.visible) this.drawBoxes(pv);
  }
  leave() {
    if (this.gesture) this.gesture.cancel();
    this.flushNudge();
    this.exitPathEdit();
    this.active = false;
    if (this.signature) this.signature.cancel();
    this.arm(null);
    this.clearSelection();
    $('#pages').classList.remove('mode-edit');
    $$('.ov').forEach((e) => e.remove());
  }
  layoutChanged() {
    if (this.active) {
      for (const pv of this.app.pvs) {
        pv.ovScale = null;
        if (pv.visible) this.drawBoxes(pv);
      }
      this.drawSelection();
      if (this.pe) this.pe.draw();
    }
  }
  afterSync() {
    if (this.active) {
      for (const pv of this.app.pvs) if (pv.visible || pv.ov) this.drawBoxes(pv);
      if (this.pendingReselect) {
        const pendingReselect = this.pendingReselect;
        this.pendingReselect = null;
        this.reselect(pendingReselect);
      } else this.refreshSelection();
      if (this.pe && !this.pe.validate()) this.exitPathEdit();
      else if (this.pe) this.pe.draw();
      this.updatePanel();
    }
  }
  drawBoxes(pv) {
    if (!this.active || !this.session) return;
    const sig = pv.sig + '@' + pv.scale;
    if (pv.ov && pv.ovSig === sig && pv.ov.isConnected) return;
    const model = this.session.model(pv.index);
    if (!pv.ov || !pv.ov.isConnected) {
      pv.ov = document.createElement('div');
      pv.ov.className = 'ov';
      pv.layer.insertBefore(pv.ov, pv.layer.firstChild);
    }
    pv.ovSig = sig;
    const frag = document.createDocumentFragment();
    for (const block of model.blocks) {
      if (this.editor && this.editor.pv === pv && this.editor.block && this.editor.block.id === block.id)
        continue;
      const box = document.createElement('div');
      box.className = 'bx t' + (block.editable ? '' : ' ne');
      const rect = pv.boxOf(block.bbox);
      Object.assign(box.style, {
        left: rect.left + 'px',
        top: rect.top + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
      });
      frag.appendChild(box);
    }
    for (const obj of model.objects) {
      if (!obj.selectable || (obj.type !== 'image' && obj.type !== 'form') || obj.area < 150) continue;
      const box = document.createElement('div');
      box.className = 'bx o';
      const rect = pv.boxOf(obj.vis);
      Object.assign(box.style, {
        left: rect.left + 'px',
        top: rect.top + 'px',
        width: rect.width + 'px',
        height: rect.height + 'px',
      });
      frag.appendChild(box);
    }
    pv.ov.replaceChildren(frag);
    pv.hov = document.createElement('div');
    pv.hov.className = 'bx hidden';
    pv.ov.appendChild(pv.hov);
    pv.hl = document.createElementNS(SVG_NS, 'svg');
    pv.hl.setAttribute('class', 'hl');
    pv.ov.appendChild(pv.hl);
  }
  wire() {
    this.wired = true;
    window.addEventListener(
      'keydown',
      (ev) => {
        if (ev.key === 'Escape' && this.gesture) {
          // laufendes Ziehen abbrechen: alles bleibt, wie es war
          ev.preventDefault();
          ev.stopPropagation();
          this.gesture.cancel();
          return;
        }
        if (ev.key === 'Escape') this.escGen = (this.escGen || 0) + 1;
        const curReq = this.curReq;
        if (!(!curReq || curReq.done || ev.ctrlKey || ev.metaKey || ev.altKey)) {
          if (ev.key === 'Escape') {
            ev.preventDefault();
            ev.stopPropagation();
            return;
          }
          if (ev.key.length === 1 || ev.key === 'Enter') {
            curReq.keys.push(ev.key === 'Enter' ? '\n' : ev.key);
            ev.preventDefault();
            ev.stopPropagation();
          }
        }
      },
      true,
    );
    const pages = $('#pages');
    pages.addEventListener('pointerdown', (ev) => {
      if (this.active) this.onDown(ev);
    });
    pages.addEventListener('pointermove', (ev) => {
      // Stift schwebt vor dem Aufsetzen: dann gilt touch-action: none (kein Scrollen statt Rahmen)
      pages.classList.toggle('pen-input', ev.pointerType === 'pen');
      if (this.active && !this.drag && !this.gesture) this.onHover(ev);
    });
    pages.addEventListener('pointerleave', () => {
      for (const pv of this.app.pvs) this.hideHover(pv);
      if (this.pe) this.pe.setHover(null);
    });
    pages.addEventListener('contextmenu', (ev) => {
      if (this.active) this.onContext(ev);
    });
    pages.addEventListener('dblclick', (ev) => {
      if (!this.active || this.armed) return;
      const pv = this.pvAt(ev);
      if (!pv) return;
      // Pfade: Doppelklick wird in resolveDown() erkannt (das native dblclick fehlt, wenn
      // der erste Klick die Auswahl und damit das Element unter dem Zeiger ersetzt)
      const hit = this.hit(pv, ev.clientX, ev.clientY);
      if (hit && hit.block && hit.block.editable) this.startEdit(pv, hit.block, [ev.clientX, ev.clientY]);
    });
  }
  /** Seitenansicht unter dem Zeiger (auch wenn das Ereignis wegen Pointer-Capture auf #pages zielt). */
  pvAt(ev) {
    const pageEl = ev.target && ev.target.closest && ev.target.closest('.page');
    if (pageEl) return this.app.pvByKey.get(pageEl.dataset.key) || null;
    return this.pvAtPoint(ev.clientX, ev.clientY);
  }
  pvAtPoint(clientX, clientY) {
    for (const pv of this.app.pvs) {
      if (!pv.visible) continue;
      const r = pv.el.getBoundingClientRect();
      if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) return pv;
    }
    return null;
  }
  /**
   * Element unter dem Zeiger: Objekte über ihre Geometrie (siehe hit-test.js); ein Textblock hat
   * Vorrang, außer der Zeiger liegt direkt auf einem Strich. Rückgabe `{ block }` oder
   * `{ obj, group, info }` (Gruppe = Cluster des Objekts).
   */
  hit(pv, clientX, clientY) {
    const model = this.session.model(pv.index);
    const [x, y] = pv.clientToPdf(clientX, clientY);
    const ppt = pxPerPt(pv);
    const best = pickObject(objectHits(model, x, y, ppt));
    // Text hat Vorrang, wenn der Zeiger im Textblock selbst liegt (auch auf Tabellenlinien durch den
    // Text); in der schmalen Toleranz um den Block gewinnt dagegen ein Strich (z. B. eine
    // Unterstreichung).
    const inside = blockAt(model, x, y, ppt, 0);
    if (inside && !(best && best.px <= 2 && this.isUnderline(best.obj, inside))) return { block: inside };
    const block = blockAt(model, x, y, ppt);
    if (block && !(best && best.ink && best.stroke)) return { block };
    if (!best) return null;
    const obj = best.obj;
    return { obj, group: obj.cluster ? obj.cluster.members : [obj], info: best };
  }
  /**
   * Ist `obj` eine Unter- oder Überstreichung von `block`: eine waagerechte Linie im oberen oder
   * unteren Randbereich des Blocks (30 % der Höhe, mindestens 2 pt)? Tabellenlinien, die quer
   * durch den Text laufen, gehören nicht dazu und nehmen dem Text nichts weg.
   */
  isUnderline(obj, block) {
    if (obj.type !== 'path' || !obj.geom) return false;
    const height = obj.vis[3] - obj.vis[1];
    if (height > Math.max(obj.lw || 0, 0) + 1.5) return false; // nicht waagerecht
    const band = Math.max(2, 0.3 * (block.bbox[3] - block.bbox[1]));
    const mid = (obj.vis[1] + obj.vis[3]) / 2;
    return mid <= block.bbox[1] + band || mid >= block.bbox[3] - band;
  }
  /** Alle Elemente unter dem Zeiger (für Alt+Klick und Kontextmenü), oberstes Objekt zuerst. */
  stackAt(pv, clientX, clientY) {
    const model = this.session.model(pv.index);
    const [x, y] = pv.clientToPdf(clientX, clientY);
    const ppt = pxPerPt(pv);
    const area = (box) => (box[2] - box[0]) * (box[3] - box[1]);
    const blocks = model.blocks
      .filter((block) => boxContains(block.bbox, x, y, 2 / ppt))
      .sort((h, u) => area(h.bbox) - area(u.bbox));
    const objects = objectHits(model, x, y, ppt).map((h) => h.obj);
    return [...blocks.map((h) => ({ block: h })), ...objects.map((h) => ({ obj: h }))];
  }
  itemLabel(item) {
    if (item.block) {
      const text = item.block.text.replace(/\s+/g, ' ').trim();
      return 'Text „' + (text.length > 28 ? text.slice(0, 27) + '…' : text) + '“';
    }
    const obj = item.obj;
    const widthMm = Math.round(ptToMm(obj.vis[2] - obj.vis[0]));
    const heightMm = Math.round(ptToMm(obj.vis[3] - obj.vis[1]));
    return (
      (obj.type === 'image'
        ? 'Bild'
        : obj.type === 'form'
          ? 'Grafik'
          : obj.type === 'shading'
            ? 'Verlauf'
            : 'Grafikelement') +
      ' (' +
      Math.max(1, widthMm) +
      ' × ' +
      Math.max(1, heightMm) +
      ' mm)'
    );
  }
  isSelected(item) {
    const sel = this.sel;
    if (!sel) return false;
    if (item.obj) return sel.objs.some((o) => o === item.obj || o.uid === item.obj.uid);
    return sel.blocks.some((b) => b === item.block || (b.id === item.block.id && b.text === item.block.text));
  }
  selectBehind(pv, clientX, clientY) {
    const stack = this.stackAt(pv, clientX, clientY);
    if (!stack.length) return false;
    const sel = this.sel;
    let current = -1;
    if (sel && sel.pv === pv && sel.objs.length + sel.blocks.length === 1)
      current = stack.findIndex((o) => this.isSelected(o));
    const next = stack[(current + 1) % stack.length];
    this.select(pv, next.obj ? [next.obj] : [], next.block ? [next.block] : []);
    this.hintOnce(
      'behind',
      stack.length > 1
        ? 'Alt+Klick erneut wählt das nächste Element dahinter.'
        : 'An dieser Stelle liegt nur dieses eine Element.',
    );
    return true;
  }
  /**
   * Klick auf etwas bereits Ausgewähltes (ohne Ziehen): in einer Gruppe nur dieses Element
   * wählen; ein einzelner Textblock wird bearbeitet; ein einzelnes Pfadobjekt öffnet „Pfad
   * bearbeiten“ mit dem angeklickten Segment.
   */
  clickSelected(pv, down, hit) {
    const sel = this.sel;
    if (!sel || sel.pv !== pv) return;
    if (sel.objs.length + sel.blocks.length > 1) {
      if (!hit) return;
      this.select(pv, hit.obj ? [hit.obj] : [], hit.block ? [hit.block] : []);
      this.hintOnce(
        'drill',
        'Nur dieses Element ausgewählt. Alt+Klick wählt das Element dahinter, Rechtsklick zeigt alle Elemente an dieser Stelle.',
      );
    } else if (sel.blocks.length === 1 && sel.blocks[0].editable)
      this.startEdit(pv, sel.blocks[0], [down.x, down.y]);
    else if (
      sel.objs.length === 1 &&
      hit &&
      hit.obj &&
      hit.obj.uid === sel.objs[0].uid &&
      hit.obj.type === 'path' &&
      hit.obj.geom
    )
      this.enterPathEdit(pv, hit.obj, down.pt);
  }
  hintOnce(id, message) {
    this._hints = this._hints || new Set();
    if (!this._hints.has(id)) {
      this._hints.add(id);
      toast(message, '', 4200);
    }
  }
  hideHover(pv) {
    if (pv.hov) pv.hov.classList.add('hidden');
    if (pv.hl) pv.hl.replaceChildren();
  }
  /** Hervorhebung: Umriss der Objekte, die ein Klick an dieser Stelle auswählen würde. */
  showObjectHover(pv, objs) {
    if (!pv.hl) return;
    const map = (p) => pv.pdfToLayer(p[0], p[1]);
    const frag = document.createDocumentFragment();
    for (const obj of objs.slice(0, 200)) {
      const path = document.createElementNS(SVG_NS, 'path');
      if (obj.type === 'path' && obj.geom && obj.geom.subpaths.length) {
        path.setAttribute('d', svgPath(pagePaths(obj), map));
        if (obj.fill && !obj.stroke) path.setAttribute('class', 'area');
      } else {
        const b = pv.boxOf(obj.vis);
        path.setAttribute('d', `M${b.left} ${b.top}h${b.width}v${b.height}h${-b.width}Z`);
      }
      frag.appendChild(path);
    }
    pv.hl.replaceChildren(frag);
  }
  /** Liegt der Punkt (Client) in der aktuellen Auswahl? Linien: nur auf dem Strich. */
  inSelection(pv, clientX, clientY) {
    const sel = this.sel;
    if (!sel || sel.pv !== pv) return false;
    const [x, y] = pv.clientToPdf(clientX, clientY);
    const ppt = pxPerPt(pv);
    if (sel.objs.length === 1 && !sel.blocks.length && isLineLike(sel.objs[0]))
      return !!objectHit(sel.objs[0], x, y, ppt);
    return boxContains(this.selBox(), x, y, 4 / ppt);
  }
  onHover(ev) {
    const pv = this.pvAt(ev);
    for (const other of this.app.pvs) if (other !== pv) this.hideHover(other);
    if (!pv || !pv.hov || this.armed) return;
    const target = ev.target;
    if (target.closest('.te-frame,.te-warn') || target.closest('.sel .h')) {
      this.hideHover(pv);
      pv.layer.style.cursor = '';
      return;
    }
    if (this.pe && this.pe.pv === pv) {
      const [x, y] = pv.clientToPdf(ev.clientX, ev.clientY);
      const pick = this.pe.pick(x, y);
      this.pe.setHover(pick && pick.seg ? pick.seg : null, pick && pick.node ? pick.node : null);
      if (pick) {
        this.hideHover(pv);
        pv.layer.style.cursor = pick.node ? 'crosshair' : 'move';
        return;
      }
    }
    const hit = this.hit(pv, ev.clientX, ev.clientY);
    if (!hit || (this.editor && hit.block && this.editor.block && hit.block.id === this.editor.block.id)) {
      this.hideHover(pv);
      pv.layer.style.cursor = !hit && this.inSelection(pv, ev.clientX, ev.clientY) ? 'move' : '';
      return;
    }
    if (hit.block) {
      if (pv.hl) pv.hl.replaceChildren();
      const box = pv.boxOf(hit.block.bbox);
      Object.assign(pv.hov.style, {
        left: box.left + 'px',
        top: box.top + 'px',
        width: box.width + 'px',
        height: box.height + 'px',
      });
      pv.hov.className = 'bx hov';
      pv.layer.style.cursor = hit.block.editable ? 'text' : 'not-allowed';
      return;
    }
    pv.hov.classList.add('hidden');
    const selected = this.isSelected({ obj: hit.obj });
    const multi = this.sel && this.sel.objs.length + this.sel.blocks.length > 1;
    this.showObjectHover(pv, selected ? (multi ? [hit.obj] : []) : hit.group);
    pv.layer.style.cursor = 'move';
  }
  /** Ist alles abgeschlossen, was das Modell ändert (Textübernahme, Änderungswarteschlange)? */
  isReady() {
    return !this.editor && !this._committing && this.pendingOps === 0;
  }
  /** Wartet, bis `isReady()` gilt. */
  async whenReady() {
    for (let round = 0; round < 100 && !this.isReady(); round++) {
      try {
        await Promise.all([this._committing, this.pendingOps ? this._queue : null]);
      } catch {}
      if (!this.isReady()) await new Promise((r) => setTimeout(r, 10));
    }
  }
  /** Wartet auf alle ausstehenden Änderungen (für Rückgängig, Speichern). */
  async idle() {
    this.flushNudge();
    if (this.pe) this.pe.flushNudge();
    for (let round = 0; round < 100 && (this.pendingOps || this._committing); round++) {
      try {
        await Promise.all([this._committing, this._queue]);
      } catch {}
    }
  }
  /**
   * Linke Maustaste auf einer Seite – synchron: Geste sofort registrieren (kein `await` davor),
   * dann auswerten (`resolveDown`), sobald Textbearbeitung und laufende Änderungen fertig sind.
   */
  onDown(ev) {
    if (ev.button !== 0) return;
    const pv = this.pvAt(ev);
    if (!pv || ev.target.closest('.te-frame') || ev.target.closest('.te-warn')) return;
    if (this.nudge) this.flushNudge();
    if (this.pe && this.pe.nudgeDelta) this.pe.flushNudge();
    const handleEl = ev.target.closest('.sel .h');
    const down = {
      seq: ++this.downSeq,
      pv,
      time: ev.timeStamp,
      x: ev.clientX,
      y: ev.clientY,
      shift: ev.shiftKey,
      alt: ev.altKey,
      handle: handleEl ? handleEl.dataset.h : null,
      pointerType: ev.pointerType,
    };
    down.pickBehind = (ev.altKey || ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !this.armed && !down.handle;
    if (this.armed === 'text') {
      ev.preventDefault();
      const pdfPoint = pv.clientToPdf(down.x, down.y);
      this.arm(null);
      return this.startEdit(pv, null, null, { point: pdfPoint, ...this.defaultStyle() });
    }
    if (this.armed === 'image') {
      ev.preventDefault();
      return this.placeImage(pv, pv.clientToPdf(down.x, down.y));
    }
    // wie bisher: Klick auf freie Fläche ohne preventDefault (Eingabefelder verlieren den Fokus)
    const blank =
      this.isReady() &&
      !this.pe &&
      !down.handle &&
      !down.pickBehind &&
      !this.hit(pv, down.x, down.y) &&
      !this.inSelection(pv, down.x, down.y);
    if (!blank) ev.preventDefault();
    if (this.gesture) this.gesture.cancel();
    const gesture = new Gesture(ev, $('#pages'));
    this.gesture = gesture;
    gesture.onDone = () => {
      if (this.gesture === gesture) this.gesture = null;
    };
    if (this.editor) {
      this.curReq = { keys: [], done: false, gen: this.escGen || 0 };
      this.finishEdit();
    }
    if (this.isReady()) return this.resolveDown(down, gesture);
    this.whenReady().then(() => {
      if (gesture.ended && gesture.reason === 'cancel') return;
      this.resolveDown(down, gesture.ended ? null : gesture);
    });
  }
  /**
   * Klick auswerten. `gesture` = null: Die Taste ist schon losgelassen – dann nur auswählen
   * (bzw. Text bearbeiten), niemals ziehen.
   */
  resolveDown(down, gesture) {
    const pv = down.pv;
    if (down.seq !== this.downSeq || !this.active || !this.session || !pv.el.isConnected) {
      if (gesture) gesture.cancel();
      return;
    }
    down.pt = pv.clientToPdf(down.x, down.y);
    const last = this.lastDown;
    if (!down.repeat) this.lastDown = down;
    const isDouble =
      !down.repeat &&
      !!last &&
      last.pv === pv &&
      down.time - last.time < 500 &&
      Math.hypot(down.x - last.x, down.y - last.y) <= 6 &&
      !down.shift &&
      !down.pickBehind;
    if (isDouble && !this.pe) {
      // Doppelklick auf einen Pfad: „Pfad bearbeiten“ öffnet erst beim Loslassen ohne Bewegung.
      // Wird das zweite Drücken zum Ziehen, ist es ein normales Verschieben der Auswahl.
      this.lastDown = null;
      const hit = this.hit(pv, down.x, down.y);
      if (hit && hit.obj && hit.obj.type === 'path' && hit.obj.geom && hit.obj.geom.subpaths.length) {
        if (!this.isSelected({ obj: hit.obj })) this.select(pv, hit.group, []);
        return this.dragSelection(down, gesture, null, () => this.enterPathEdit(pv, hit.obj, down.pt));
      }
    }
    if (this.pe) {
      if (this.pe.pv === pv && this.pe.onDown(down, gesture)) return;
      this.exitPathEdit();
    }
    if (down.pickBehind) {
      if (this.selectBehind(pv, down.x, down.y)) return this.dragSelection(down, gesture, null, null);
      this.clearSelection();
      if (gesture) gesture.cancel();
      return;
    }
    if (down.handle && this.sel && this.sel.el && this.sel.pv === pv) {
      // Griffe haben Vorrang – ein Klick ohne Ziehen wirkt aber wie ein Klick an dieser Stelle
      const clickThrough = () => this.resolveDown({ ...down, handle: null, repeat: true }, null);
      if (!gesture) return clickThrough();
      if (down.handle === 'p0' || down.handle === 'p1') return this.endpointDrag(down, gesture, clickThrough);
      return this.dragSelection(down, gesture, down.handle, clickThrough);
    }
    const hit = this.hit(pv, down.x, down.y);
    if (hit && hit.block) {
      if (this.isSelected({ block: hit.block }))
        return this.dragSelection(down, gesture, null, () => this.clickSelected(pv, down, hit));
      if (gesture) gesture.cancel();
      if (down.shift || !hit.block.editable) {
        this.select(pv, [], [hit.block], down.shift);
        if (!hit.block.editable && !down.shift)
          toast('Gedrehter Text kann nicht bearbeitet, aber gelöscht werden.', 'warn');
        return;
      }
      this.clearSelection();
      return this.startEdit(pv, hit.block, [down.x, down.y]);
    }
    if (hit && hit.obj) {
      if (this.isSelected({ obj: hit.obj }))
        return this.dragSelection(down, gesture, null, () => this.clickSelected(pv, down, hit));
      const extend = down.shift && this.sel && this.sel.pv === pv;
      this.select(pv, hit.group, [], extend);
      return this.dragSelection(down, gesture, null, null);
    }
    if (this.inSelection(pv, down.x, down.y)) return this.dragSelection(down, gesture, null, null);
    this.clearSelection();
    if (!gesture) return;
    // Touch auf freier Fläche scrollt (der Browser sendet pointercancel); Auswahlrahmen nur mit Maus/Stift
    if (down.pointerType === 'touch') gesture.cancel();
    else this.startMarquee(down, gesture);
  }
  onContext(ev) {
    const pv = this.pvAt(ev);
    if (!pv) return;
    ev.preventDefault();
    const at = { x: ev.clientX, y: ev.clientY };
    const hit = this.hit(pv, ev.clientX, ev.clientY);
    const pdfPoint = pv.clientToPdf(ev.clientX, ev.clientY);
    const stack = this.stackAt(pv, ev.clientX, ev.clientY);
    const pickItems =
      stack.length > 1
        ? [
            '-',
            ...stack.slice(0, 8).map((o) => ({
              label: 'Auswählen: ' + this.itemLabel(o),
              icon:
                this.isSelected(o) && this.sel.objs.length + this.sel.blocks.length === 1
                  ? 'check'
                  : o.block
                    ? 'text'
                    : o.obj.type === 'image'
                      ? 'image'
                      : 'layers',
              run: () => this.select(pv, o.obj ? [o.obj] : [], o.block ? [o.block] : []),
            })),
          ]
        : [];
    if (
      this.sel &&
      this.sel.pv === pv &&
      stack.some((o) => this.isSelected(o)) &&
      (!hit || !hit.block || this.sel.blocks.includes(hit.block))
    )
      this.selMenu(
        at,
        pickItems,
        stack.find((o) => this.isSelected(o)),
      );
    else if (hit && hit.block)
      showMenu(
        [
          {
            label: 'Text bearbeiten',
            icon: 'edit',
            disabled: !hit.block.editable,
            run: () => this.startEdit(pv, hit.block, [at.x, at.y]),
          },
          {
            label: 'Textblock auswählen (zum Verschieben)',
            icon: 'cursor',
            run: () => this.select(pv, [], [hit.block]),
          },
          '-',
          {
            label: 'Textblock löschen',
            icon: 'trash',
            run: () => {
              this.select(pv, [], [hit.block]);
              this.deleteSelection();
            },
          },
          ...pickItems,
        ],
        at,
      );
    else if (hit && hit.obj) {
      this.select(pv, hit.group, []);
      this.selMenu(at, pickItems, { obj: hit.obj });
    } else
      showMenu(
        [
          {
            label: 'Text hier hinzufügen',
            icon: 'textbox',
            run: () => this.startEdit(pv, null, null, { point: pdfPoint, ...this.defaultStyle() }),
          },
          { label: 'Bild hier einfügen …', icon: 'image', run: () => this.pickImage(pv, pdfPoint) },
        ],
        at,
      );
  }
  selMenu(at, extraItems = [], clicked = null) {
    const sel = this.sel;
    if (!sel) return;
    const isSingleImage =
      sel.objs.length === 1 && sel.objs[0].type === 'image' && !sel.objs[0].inline && !sel.blocks.length;
    const isMulti = sel.objs.length + sel.blocks.length > 1;
    showMenu(
      [
        ...(isMulti && clicked
          ? [
              {
                label: 'Nur dieses Element auswählen',
                icon: 'cursor',
                run: () =>
                  this.select(sel.pv, clicked.obj ? [clicked.obj] : [], clicked.block ? [clicked.block] : []),
              },
              '-',
            ]
          : []),
        {
          label: 'In den Vordergrund',
          icon: 'tofront',
          disabled: !sel.objs.length || sel.blocks.length > 0,
          run: () => this.restack('front'),
        },
        {
          label: 'In den Hintergrund',
          icon: 'toback',
          disabled: !sel.objs.length || sel.blocks.length > 0,
          run: () => this.restack('back'),
        },
        '-',
        {
          label: 'Bild ersetzen …',
          icon: 'replace',
          disabled: !isSingleImage,
          run: () => this.replaceImage(),
        },
        {
          label: 'Um 90° nach rechts drehen',
          icon: 'rotr',
          disabled: !sel.objs.length || sel.blocks.length > 0,
          run: () => this.rotateSelection(90),
        },
        {
          label: 'Um 90° nach links drehen',
          icon: 'rotl',
          disabled: !sel.objs.length || sel.blocks.length > 0,
          run: () => this.rotateSelection(-90),
        },
        '-',
        { label: 'Löschen', icon: 'trash', key: 'Entf', run: () => this.deleteSelection() },
        ...extraItems,
      ],
      at,
    );
  }
  /**
   * Änderung in die Warteschlange stellen: läuft nach allen vorherigen und exklusiv zur
   * Speicherung. `fn` ändert nur das Modell; die Darstellung folgt über `afterChange()`.
   */
  enqueue(fn) {
    const session = this.session;
    if (!session) return Promise.resolve();
    this.pendingOps++;
    const run = () => session.exclusive(fn);
    const p = this._queue
      .then(run)
      .catch((err) => {
        console.error(err);
        toast('Die Änderung konnte nicht übernommen werden.', 'err');
      })
      .finally(() => {
        this.pendingOps--;
      });
    this._queue = p;
    return p;
  }
  /**
   * Nach einer Änderung: Auswahl über die uid aktualisieren (oder `after` wählen, wenn sich die
   * Auswahl seitdem nicht geändert hat), dann neu darstellen.
   */
  afterChange(after = null, ghost = null) {
    if (after && after.gen === this.selGen) this.reselect(after, true);
    else this.refreshSelection();
    if (this.pe) {
      if (!this.pe.validate()) this.exitPathEdit();
      else this.pe.draw();
    }
    const synced = this.app.sync();
    if (ghost) Promise.resolve(synced).finally(() => ghost.remove());
  }
  /** Aktuelle Modellobjekte zu uids (fehlende werden übersprungen). */
  resolveUids(index, uids) {
    const byUid = new Map(this.session.model(index).objects.map((o) => [o.uid, o]));
    return uids.map((uid) => byUid.get(uid)).filter(Boolean);
  }
  async restack(direction) {
    const sel = this.sel;
    if (!sel || !sel.objs.length || sel.blocks.length) return;
    const targets = this.captureTargets();
    let ok = false;
    await this.enqueue(async () => {
      const index = this.app.pvByKey.get(targets.key).index;
      ok = this.session.restackObjects(index, this.resolveUids(index, targets.uids), direction);
      if (ok) this.afterChange(this.targetsAfter([1, 0, 0, 1, 0, 0], targets));
    });
    if (ok) toast(direction === 'back' ? 'In den Hintergrund gelegt' : 'In den Vordergrund geholt');
    else toast('Die Reihenfolge lässt sich auf dieser Seite nicht ändern.', 'warn');
  }
  /** Auswahl setzen; `keepGen` = dieselbe Auswahl in neuem Modell (Zähler bleibt). */
  setSel(pv, objs, blocks, keepGen = false) {
    if (this.sel && this.sel.el) this.sel.el.remove();
    this.sel = { pv, objs, blocks };
    if (!keepGen) this.selGen++;
    this.drawSelection();
    this.updatePanel();
  }
  select(pv, objs, blocks, extend = false) {
    if (this.editor) this.finishEdit();
    this.exitPathEdit();
    if (extend && this.sel && this.sel.pv === pv) {
      const uids = new Set(this.sel.objs.map((o) => o.uid));
      objs = [...this.sel.objs, ...objs.filter((o) => !uids.has(o.uid))];
      blocks = [...new Set([...this.sel.blocks, ...blocks])];
    }
    this.setSel(pv, objs, blocks);
  }
  clearSelection() {
    this.exitPathEdit();
    if (this.sel && this.sel.el) this.sel.el.remove();
    if (this.sel) this.selGen++;
    this.sel = null;
    this.updatePanel();
  }
  hasSelection() {
    return !!(this.pe || (this.sel && (this.sel.objs.length || this.sel.blocks.length)));
  }
  /**
   * Rahmen für die Maßfelder links: Pfade ohne Strichstärke (nur die Geometrie, wie sie ein
   * Entwurfsprogramm anzeigt), alles andere wie `selBox()`. Eine 20 pt dicke, 200 pt lange Linie
   * ist also 200 pt breit und 0 pt hoch; Skalieren ändert die Strichstärke nicht.
   */
  fieldBox(sel = this.sel) {
    const boxes = [
      ...sel.objs.map((o) =>
        o.type === 'path' && o.geom && o.geom.subpaths.length && !o.clipRect && !o.clip
          ? subpathsBox(pagePaths(o))
          : o.vis,
      ),
      ...sel.blocks.map((b) => b.bbox),
    ];
    return unionBoxes(boxes);
  }
  /** Seitenansicht der Auswahl (auch bei „Pfad bearbeiten“). */
  selectionView() {
    return this.sel ? this.sel.pv : this.pe ? this.pe.pv : null;
  }
  selBox(sel = this.sel) {
    if (!sel && this.pe) {
      const obj = this.pe.obj;
      return obj ? obj.vis.slice() : [0, 0, 0, 0];
    }
    return unionBoxes([...sel.objs.map((obj) => obj.vis), ...sel.blocks.map((block) => block.bbox)]);
  }
  /** Welche Rahmengriffe passen? Bei schmalen Rahmen nie übereinanderliegende Griffe. */
  boxHandles(width, height) {
    const all = [
      ['nw', 0, 0],
      ['n', 50, 0],
      ['ne', 100, 0],
      ['e', 100, 50],
      ['se', 100, 100],
      ['s', 50, 100],
      ['sw', 0, 100],
      ['w', 0, 50],
    ];
    const thinW = width < HANDLE_MIN_SIDE;
    const thinH = height < HANDLE_MIN_SIDE;
    let keep;
    if (thinW && thinH) keep = ['se'];
    else if (thinH) keep = ['w', 'e'];
    else if (thinW) keep = ['n', 's'];
    else
      keep = all
        .map((h) => h[0])
        .filter(
          (d) =>
            !((d === 'n' || d === 's') && width < HANDLE_MID_SIDE) &&
            !((d === 'e' || d === 'w') && height < HANDLE_MID_SIDE),
        );
    return all.filter((h) => keep.includes(h[0]));
  }
  drawSelection() {
    const sel = this.sel;
    if (!sel) return;
    if (sel.el) sel.el.remove();
    if (!sel.objs.length && !sel.blocks.length) {
      this.sel = null;
      return;
    }
    const pv = sel.pv;
    const box = pv.boxOf(this.selBox());
    const offset = this.nudge ? [this.nudge[0] * pv.scale, -this.nudge[1] * pv.scale] : [0, 0];
    box.left += offset[0];
    box.top += offset[1];
    const line = sel.objs.length === 1 && !sel.blocks.length && isLineLike(sel.objs[0]) ? sel.objs[0] : null;
    const el = (sel.el = document.createElement('div'));
    el.className = 'sel' + (line ? ' line' : '');
    Object.assign(el.style, {
      left: box.left + 'px',
      top: box.top + 'px',
      width: Math.max(2, box.width) + 'px',
      height: Math.max(2, box.height) + 'px',
    });
    const local = (p) => {
      const q = pv.pdfToLayer(p[0], p[1]);
      return [q[0] - box.left + offset[0], q[1] - box.top + offset[1]];
    };
    const paths = sel.objs.filter((o) => o.type === 'path' && o.geom && o.geom.subpaths.length);
    if (paths.length && paths.length <= 60) {
      const svg = document.createElementNS(SVG_NS, 'svg');
      svg.setAttribute('class', 'sel-geom');
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', paths.map((o) => svgPath(pagePaths(o), local)).join(''));
      svg.appendChild(path);
      el.appendChild(svg);
      sel.geomPath = path;
    }
    if (line) {
      // Sehr kurze Linien: Die beiden Griffe (28 px Trefferfläche) werden entlang der Linie nach
      // außen versetzt, damit sie sich nie überlappen und beide Enden immer greifbar bleiben.
      const ends = pagePaths(line)[0].nodes.map(local);
      const vx = ends[1][0] - ends[0][0];
      const vy = ends[1][1] - ends[0][1];
      const len = Math.hypot(vx, vy);
      const dir = len > 1e-6 ? [vx / len, vy / len] : [1, 0];
      const shift = Math.max(0, (HANDLE_SPACING - len) / 2);
      ends.forEach(([x, y], k) => {
        const sign = k === 0 ? -1 : 1;
        const [ox, oy] = [dir[0] * shift * sign, dir[1] * shift * sign];
        const handle = document.createElement('div');
        handle.className = 'h ep' + (shift ? ' off' : '');
        handle.dataset.h = 'p' + k;
        handle.dataset.ox = ox;
        handle.dataset.oy = oy;
        handle.style.left = x + ox + 'px';
        handle.style.top = y + oy + 'px';
        el.appendChild(handle);
      });
    } else if (sel.objs.length && !sel.blocks.length)
      for (const [dir, x, y] of this.boxHandles(box.width, box.height)) {
        const handle = document.createElement('div');
        handle.className = 'h';
        handle.dataset.h = dir;
        handle.style.left = x + '%';
        handle.style.top = y + '%';
        // Mittelgriffe liegen bei Pfaden außerhalb der Kante, damit sie den Strich nicht verdecken
        // (Ziehen am Strich verschiebt, Ziehen am Griff ändert die Größe); Eckgriffe bleiben.
        if (dir.length === 1 && sel.objs.some((o) => o.type === 'path')) {
          handle.classList.add('out');
          const out = HANDLE_OUTSET;
          if (dir === 'n') handle.style.marginTop = -14 - out + 'px';
          if (dir === 's') handle.style.marginTop = -14 + out + 'px';
          if (dir === 'w') handle.style.marginLeft = -14 - out + 'px';
          if (dir === 'e') handle.style.marginLeft = -14 + out + 'px';
        }
        el.appendChild(handle);
      }
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = this.selLabel();
    el.appendChild(tag);
    // Fläche zum Verschieben per Touch (touch-action: none nur über der Auswahl, nicht auf der ganzen Seite)
    const pad = document.createElement('div');
    pad.className = 'pad';
    el.insertBefore(pad, el.firstChild);
    pv.layer.appendChild(el);
  }
  selLabel() {
    const sel = this.sel;
    const parts = [];
    const images = sel.objs.filter((obj) => obj.type === 'image').length;
    const others = sel.objs.length - images;
    if (images) parts.push(images === 1 ? 'Bild' : images + ' Bilder');
    if (others)
      parts.push(
        others === 1
          ? isLineLike(sel.objs.find((o) => o.type !== 'image'))
            ? 'Linie'
            : 'Grafikelement'
          : 'Grafik (' + others + ' Teile)',
      );
    if (sel.blocks.length)
      parts.push(sel.blocks.length === 1 ? 'Textblock' : sel.blocks.length + ' Textblöcke');
    return parts.join(' · ');
  }
  findBlock(model, block, tolerance = 1) {
    return (
      model.blocks.find(
        (block2) =>
          block2.text === block.text &&
          Math.abs(block2.bbox[0] - block.bbox[0]) < tolerance &&
          Math.abs(block2.bbox[3] - block.bbox[3]) < tolerance,
      ) || null
    );
  }
  /**
   * Auswahl nach einer Änderung wiederherstellen: Objekte über ihre uid (`uids`), ältere Ziele
   * ohne uid über Typ und Rechteck, Textblöcke über Text und Lage.
   */
  reselect(target, keepGen = false) {
    const pv = this.app.pvByKey.get(target.key);
    if (!pv) return;
    const model = this.session.model(pv.index);
    const objs = target.uids ? this.resolveUids(pv.index, target.uids) : [];
    for (const obj of target.objs || []) {
      const match = model.objects.find(
        (obj2) =>
          obj2.selectable &&
          !objs.includes(obj2) &&
          obj2.type === obj.type &&
          obj.vis.every((l, c) => Math.abs(l - obj2.vis[c]) < 1.5),
      );
      if (match) objs.push(match);
    }
    const blocks = (target.blocks || []).map((block) => this.findBlock(model, block)).filter(Boolean);
    if (objs.length || blocks.length) this.setSel(pv, objs, blocks, keepGen);
    else if (keepGen) {
      if (this.sel && this.sel.el) this.sel.el.remove();
      this.sel = null;
      this.updatePanel();
    } else this.clearSelection();
  }
  /** Auswahl auf das aktuelle Modell umstellen (gleiche uids, gleiche Textblöcke). */
  refreshSelection() {
    const sel = this.sel;
    if (!sel) return;
    if (!this.app.pvByKey.has(sel.pv.key)) {
      if (sel.el) sel.el.remove();
      this.sel = null;
      return;
    }
    const model = this.session.model(sel.pv.index);
    const fresh = (block) => (model.blocks.includes(block) ? block : this.findBlock(model, block));
    this.reselect(
      { key: sel.pv.key, uids: sel.objs.map((o) => o.uid), blocks: sel.blocks.map(fresh).filter(Boolean) },
      true,
    );
  }
  /** Feste Ziele einer Änderung: uids und Textblöcke der Auswahl zum jetzigen Zeitpunkt. */
  captureTargets(sel = this.sel) {
    if (!sel) return null;
    return {
      key: sel.pv.key,
      uids: sel.objs.map((o) => o.uid),
      blocks: sel.blocks.slice(),
      selBox: this.selBox(sel),
      gen: this.selGen,
    };
  }
  targetsAfter(matrix, targets) {
    const apply = (x, y) => [
      matrix[0] * x + matrix[2] * y + matrix[4],
      matrix[1] * x + matrix[3] * y + matrix[5],
    ];
    const transformBox = (box) => {
      const corners = [
        apply(box[0], box[1]),
        apply(box[2], box[1]),
        apply(box[0], box[3]),
        apply(box[2], box[3]),
      ];
      return [
        Math.min(...corners.map((s) => s[0])),
        Math.min(...corners.map((s) => s[1])),
        Math.max(...corners.map((s) => s[0])),
        Math.max(...corners.map((s) => s[1])),
      ];
    };
    return {
      key: targets.key,
      uids: targets.uids.slice(),
      blocks: targets.blocks.map((block) => ({ text: block.text, bbox: transformBox(block.bbox) })),
      gen: targets.gen,
    };
  }
  /** Ziehen der Auswahl; ohne Geste (Taste schon losgelassen) nur die Klick-Aktion. */
  dragSelection(down, gesture, handle, onClick) {
    if (!gesture) {
      if (onClick) onClick();
      return;
    }
    if (!this.sel || !this.sel.el) {
      gesture.cancel();
      return;
    }
    this.moveDrag(down, gesture, handle, onClick);
  }
  /**
   * Verschieben (handle = null) oder Skalieren über einen Rahmengriff. Während des Ziehens wird
   * nur der Auswahlrahmen (und eine Bildkopie „ghost“) bewegt; beim Loslassen wird die Matrix in
   * PDF-Koordinaten berechnet und für die beim Ziehbeginn festgehaltenen Ziele übernommen.
   * Umschalt = Achse sperren bzw. Seitenverhältnis frei, Alt = ohne Einrasten (SnapGuides),
   * Esc = abbrechen.
   */
  moveDrag(down, gesture, handle, onClick) {
    const sel = this.sel;
    const pv = sel.pv;
    const selEl = sel.el;
    const clientX = gesture.x0;
    const clientY = gesture.y0;
    const targets = this.captureTargets();
    const start = {
      left: parseFloat(selEl.style.left),
      top: parseFloat(selEl.style.top),
      width: parseFloat(selEl.style.width),
      height: parseFloat(selEl.style.height),
    };
    let ghost = null;
    if (pv.rot === 0 && pv.canvas.width) {
      // Bildkopie aus Vorschau und (bei hohem Zoom) scharfem Detail-Canvas
      ghost = pv.snapshot(start.left, start.top, start.width, start.height);
      ghost.className = 'ghost';
      Object.assign(ghost.style, {
        left: start.left + 'px',
        top: start.top + 'px',
        width: start.width + 'px',
        height: start.height + 'px',
        display: 'none',
      });
      pv.layer.appendChild(ghost);
    }
    const isCorner = handle && handle.length === 2;
    let current = { ...start };
    let moved = false;
    this.drag = true;
    const movingUids = new Set(sel.objs.map((o) => o.uid));
    const movingBlocks = new Set(sel.blocks);
    let guides = null;
    try {
      guides = new SnapGuides(pv, this.session.model(pv.index), (B) =>
        B.uid != null ? movingUids.has(B.uid) : movingBlocks.has(B),
      );
    } catch {
      guides = null;
    }
    const onMove = (moveEv) => {
      let [dx, dy] = pv.clientDeltaToLayer(moveEv.clientX - clientX, moveEv.clientY - clientY);
      if (!(!moved && Math.hypot(dx, dy) < 3)) {
        moved = true;
        if (handle) {
          let { left, top, width, height } = start;
          if (handle.includes('e')) width = Math.max(4, start.width + dx);
          if (handle.includes('s')) height = Math.max(4, start.height + dy);
          if (handle.includes('w')) {
            width = Math.max(4, start.width - dx);
            left = start.left + start.width - width;
          }
          if (handle.includes('n')) {
            height = Math.max(4, start.height - dy);
            top = start.top + start.height - height;
          }
          if (isCorner !== moveEv.shiftKey) {
            const factor = Math.max(width / start.width, height / start.height);
            width = start.width * factor;
            height = start.height * factor;
            if (handle.includes('w')) left = start.left + start.width - width;
            if (handle.includes('n')) top = start.top + start.height - height;
          }
          current = { left, top, width, height };
          if (guides && !moveEv.altKey && isCorner === moveEv.shiftKey) {
            const xEdges = handle.includes('e') ? ['r'] : handle.includes('w') ? ['l'] : [];
            const yEdges = handle.includes('s') ? ['b'] : handle.includes('n') ? ['t'] : [];
            const snap = guides.snap(current, { x: xEdges, y: yEdges });
            if (xEdges[0] === 'r') current.width += snap.dx;
            else if (xEdges[0] === 'l') {
              current.left += snap.dx;
              current.width -= snap.dx;
            }
            if (yEdges[0] === 'b') current.height += snap.dy;
            else if (yEdges[0] === 't') {
              current.top += snap.dy;
              current.height -= snap.dy;
            }
            guides.show(snap.lines);
          } else if (guides) guides.clear();
        } else {
          if (moveEv.shiftKey) {
            if (Math.abs(dx) > Math.abs(dy)) dy = 0;
            else dx = 0;
          }
          current = { ...start, left: start.left + dx, top: start.top + dy };
          if (guides)
            if (moveEv.altKey) guides.clear();
            else {
              const snap = guides.snap(
                current,
                moveEv.shiftKey
                  ? dy === 0
                    ? { x: ['l', 'c', 'r'], y: [] }
                    : { x: [], y: ['t', 'c', 'b'] }
                  : undefined,
              );
              current.left += snap.dx;
              current.top += snap.dy;
              guides.show(snap.lines);
            }
        }
        Object.assign(selEl.style, {
          left: current.left + 'px',
          top: current.top + 'px',
          width: current.width + 'px',
          height: current.height + 'px',
        });
        if (ghost) {
          ghost.style.display = '';
          Object.assign(ghost.style, {
            left: current.left + 'px',
            top: current.top + 'px',
            width: current.width + 'px',
            height: current.height + 'px',
          });
        }
      }
    };
    const onEnd = (reason) => {
      this.drag = false;
      if (guides) guides.clear();
      if (reason !== 'up') {
        if (ghost) ghost.remove();
        if (this.sel === sel) this.drawSelection();
        return;
      }
      if (!moved) {
        if (ghost) ghost.remove();
        if (onClick) onClick();
        return;
      }
      const scale = pv.scale;
      let matrix;
      if (!handle)
        matrix = [1, 0, 0, 1, (current.left - start.left) / scale, -(current.top - start.top) / scale];
      else {
        const scaleX = current.width / start.width;
        const scaleY = current.height / start.height;
        const selBox = targets.selBox;
        const [x0, y0] = pv.layerToPdf(current.left, current.top + current.height);
        matrix = [scaleX, 0, 0, scaleY, x0 - scaleX * selBox[0], y0 - scaleY * selBox[1]];
      }
      this.applyTransform(matrix, handle ? 'Größe geändert' : 'Verschoben', targets, ghost);
    };
    gesture.attach({ move: onMove, end: onEnd });
  }
  /**
   * Endpunkt einer Linie ziehen: Umschalt = 0°/45°/90° zum anderen Endpunkt, sonst Einrasten an
   * Punkten und Segmenten anderer Objekte (Alt = frei). Die Linie wird über ihre Geometrie
   * geändert – Strichstärke und Farbe bleiben.
   */
  endpointDrag(down, gesture, onClick = null) {
    const sel = this.sel;
    const pv = sel.pv;
    const obj = sel.objs[0];
    const k = down.handle === 'p0' ? 0 : 1;
    const base = cloneSubpaths(pagePaths(obj));
    const startPt = base[0].nodes[k];
    const other = base[0].nodes[1 - k];
    const [sx, sy] = pv.clientToPdf(gesture.x0, gesture.y0);
    const handleEl = sel.el.querySelector(`.h[data-h="${down.handle}"]`);
    const box = { left: parseFloat(sel.el.style.left), top: parseFloat(sel.el.style.top) };
    const local = (p) => {
      const q = pv.pdfToLayer(p[0], p[1]);
      return [q[0] - box.left, q[1] - box.top];
    };
    let guides = null;
    try {
      guides = new SnapGuides(pv, this.session.model(pv.index), (o) => o.uid === obj.uid);
    } catch {
      guides = null;
    }
    let target = startPt.slice();
    let moved = false;
    this.drag = true;
    if (handleEl) handleEl.classList.add('active');
    gesture.attach({
      move: (e) => {
        if (!gesture.moved) return;
        moved = true;
        const [px, py] = pv.clientToPdf(e.clientX, e.clientY);
        target = [startPt[0] + px - sx, startPt[1] + py - sy];
        let snap = null;
        if (e.shiftKey) {
          const [vx, vy] = constrainAngle(target[0] - other[0], target[1] - other[1]);
          target = [other[0] + vx, other[1] + vy];
        } else if (guides && !e.altKey) {
          const [lx, ly] = pv.pdfToLayer(target[0], target[1]);
          snap = guides.snapPoint(lx, ly);
          if (snap) target = pv.layerToPdf(snap.x, snap.y);
        }
        if (guides) guides.showPoint(snap);
        const [hx, hy] = local(target);
        if (handleEl) {
          handleEl.style.left = hx + +handleEl.dataset.ox + 'px';
          handleEl.style.top = hy + +handleEl.dataset.oy + 'px';
        }
        if (sel.geomPath) {
          const [ox, oy] = local(other);
          sel.geomPath.setAttribute('d', `M${ox} ${oy}L${hx} ${hy}`);
        }
      },
      end: (reason) => {
        this.drag = false;
        if (guides) guides.clear();
        const dx = target[0] - startPt[0];
        const dy = target[1] - startPt[1];
        if (reason === 'up' && !moved && onClick) {
          if (this.sel === sel) this.drawSelection();
          onClick();
          return;
        }
        if (reason !== 'up' || !moved || (Math.abs(dx) < 1e-9 && Math.abs(dy) < 1e-9)) {
          if (this.sel === sel) this.drawSelection();
          return;
        }
        const paths = moveNodes(base, new Set(['0:' + k]), dx, dy);
        this.commitPaths(pv, [{ uid: obj.uid, paths }], 'Linie geändert');
      },
    });
  }
  /** Pfadgeometrie übernehmen: `edits` = [{ uid, paths }] mit Teilpfaden in Seitenkoordinaten. */
  commitPaths(pv, edits, label) {
    const key = pv.key;
    return this.enqueue(async () => {
      const p = this.app.pvByKey.get(key);
      if (!p) return;
      const byUid = new Map(this.session.model(p.index).objects.map((o) => [o.uid, o]));
      const items = edits
        .map((e) => {
          const obj = byUid.get(e.uid);
          return obj && { obj, subpaths: fromPage(e.paths, obj.ctm) };
        })
        .filter(Boolean);
      // Bleibt von einem Pfad nichts übrig, wird das Objekt gelöscht
      const empty = items.filter((i) => !i.subpaths.length).map((i) => i.obj);
      const rest = items.filter((i) => i.subpaths.length);
      await this.session.batch(label, async () => {
        if (rest.length) this.session.editPaths(p.index, rest, label);
        if (empty.length)
          this.session.deleteObjects(
            p.index,
            this.resolveUids(
              p.index,
              empty.map((o) => o.uid),
            ),
            label,
          );
      });
      this.afterChange();
    });
  }
  /**
   * Matrix (PDF-Koordinaten) auf feste Ziele anwenden (Standard: aktuelle Auswahl). Verschieben
   * und Bilder über `cm`; Skalieren/Drehen von Pfaden über ihre Geometrie, damit die
   * Strichstärke erhalten bleibt (außer der Pfad würde aus seinem Beschneidungspfad wandern).
   */
  applyTransform(matrix, label, targets = this.captureTargets(), ghost = null) {
    if (!targets) {
      if (ghost) ghost.remove();
      return Promise.resolve();
    }
    const isTranslation = isTranslationMatrix(matrix);
    if (targets.blocks.length && !isTranslation) {
      if (ghost) ghost.remove();
      return Promise.resolve();
    }
    if (targets.blocks.filter((block) => !block.editable).length && isTranslation) {
      if (ghost) ghost.remove();
      toast('Gedrehter Text kann nicht verschoben werden.', 'warn');
      this.drawSelection();
      return Promise.resolve();
    }
    const after = this.targetsAfter(matrix, targets);
    return this.enqueue(async () => {
      const pv = this.app.pvByKey.get(targets.key);
      if (!pv) return;
      const index = pv.index;
      await this.session.batch(label, async () => {
        if (targets.uids.length) this.transformByUid(index, targets.uids, matrix, label, isTranslation);
        if (targets.blocks.length) await this.session.moveBlocks(index, targets.blocks, matrix[4], matrix[5]);
      });
      this.afterChange(after, ghost);
    });
  }
  transformByUid(index, uids, matrix, label, isTranslation) {
    const objs = this.resolveUids(index, uids);
    if (!objs.length) return;
    if (isTranslation) {
      this.session.transformObjects(index, objs, matrix, label);
      return;
    }
    const byGeometry = objs.filter(
      (o) =>
        o.type === 'path' &&
        o.geom &&
        o.geom.subpaths.length &&
        !o.clip &&
        (!o.clipRect || this.session.insideAfter(o, matrix)),
    );
    const rest = objs.filter((o) => !byGeometry.includes(o));
    if (rest.length) this.session.transformObjects(index, rest, matrix, label);
    if (byGeometry.length)
      this.session.transformPaths(
        index,
        this.resolveUids(
          index,
          byGeometry.map((o) => o.uid),
        ),
        matrix,
        label,
      );
  }
  rotateSelection(degrees) {
    const sel = this.sel;
    if (!sel || !sel.objs.length) return;
    const selBox = this.selBox();
    const cx = (selBox[0] + selBox[2]) / 2;
    const cy = (selBox[1] + selBox[3]) / 2;
    const matrix = degrees > 0 ? [0, -1, 1, 0, cx - cy, cx + cy] : [0, 1, -1, 0, cx + cy, cy - cx];
    return this.applyTransform(matrix, 'Gedreht');
  }
  deleteSelection() {
    // „Pfad bearbeiten“ mit gewählter Kante/gewählten Punkten: nur diese löschen, nicht das Objekt
    if (this.pe && this.pe.deleteSelected()) return Promise.resolve();
    if (this.pe) {
      const obj = this.pe.obj;
      const pv = this.pe.pv;
      this.exitPathEdit();
      if (obj) this.select(pv, [obj], []);
    }
    const targets = this.captureTargets();
    if (!targets) return Promise.resolve();
    this.clearSelection();
    return this.enqueue(async () => {
      const pv = this.app.pvByKey.get(targets.key);
      if (!pv) return;
      const index = pv.index;
      await this.session.batch(
        targets.uids.length && targets.blocks.length
          ? 'Auswahl gelöscht'
          : targets.blocks.length
            ? 'Text gelöscht'
            : 'Objekt gelöscht',
        async () => {
          if (targets.uids.length) this.session.deleteObjects(index, this.resolveUids(index, targets.uids));
          if (targets.blocks.length) {
            const model = this.session.model(index);
            const blocks = targets.blocks
              .map((block) =>
                model.blocks.find(
                  (block2) =>
                    block2.text === block.text &&
                    Math.abs(block2.bbox[0] - block.bbox[0]) < 0.5 &&
                    Math.abs(block2.bbox[1] - block.bbox[1]) < 0.5,
                ),
              )
              .filter(Boolean);
            if (blocks.length) this.session.deleteBlocks(index, blocks);
          }
        },
      );
      this.afterChange();
    });
  }
  startMarquee(down, gesture) {
    const pv = down.pv;
    const [startX, startY] = pv.clientToLayer(gesture.x0, gesture.y0);
    const marquee = document.createElement('div');
    marquee.className = 'marq';
    pv.layer.appendChild(marquee);
    let rect = null;
    gesture.attach({
      move: (moveEv) => {
        const [x, y] = pv.clientToLayer(moveEv.clientX, moveEv.clientY);
        rect = {
          left: Math.min(startX, x),
          top: Math.min(startY, y),
          width: Math.abs(x - startX),
          height: Math.abs(y - startY),
        };
        Object.assign(marquee.style, {
          left: rect.left + 'px',
          top: rect.top + 'px',
          width: rect.width + 'px',
          height: rect.height + 'px',
        });
      },
      end: (reason) => {
        marquee.remove();
        if (reason !== 'up' || !rect || rect.width < 4 || rect.height < 4) return;
        const p1 = pv.layerToPdf(rect.left, rect.top + rect.height);
        const p2 = pv.layerToPdf(rect.left + rect.width, rect.top);
        const area = [
          Math.min(p1[0], p2[0]),
          Math.min(p1[1], p2[1]),
          Math.max(p1[0], p2[0]),
          Math.max(p1[1], p2[1]),
        ];
        const model = this.session.model(pv.index);
        const objs = model.objects.filter((obj) => obj.selectable && boxInside(obj.vis, area));
        const blocks = model.blocks.filter((block) => boxInside(block.bbox, area));
        if (objs.length || blocks.length) this.select(pv, objs, blocks);
      },
    });
  }
  /** „Pfad bearbeiten“ für ein Pfadobjekt öffnen; `pt` (PDF) wählt das Segment darunter. */
  enterPathEdit(pv, obj, pt = null) {
    if (!obj || obj.type !== 'path' || !obj.geom || !obj.geom.subpaths.length) return;
    if (this.pe && this.pe.uid === obj.uid && this.pe.pv === pv) return;
    this.flushNudge();
    this.clearSelection();
    const pe = new PathEditor(this, pv, obj.uid);
    const h = pt && objectHit(obj, pt[0], pt[1], pxPerPt(pv));
    if (h && h.sp != null) pe.selectSegment(h.sp, h.seg);
    this.pe = pe;
    $('#pages').classList.add('pe-active');
    pe.draw();
    this.hideHover(pv);
    this.updateHint();
    this.updatePanel();
    this.hintOnce(
      'pathedit',
      'Pfad bearbeiten: Ankerpunkte oder Kanten anklicken und ziehen (Umschalt = 45°-Schritte, Alt = Verbindung lösen). Esc beendet.',
    );
  }
  exitPathEdit() {
    const pe = this.pe;
    if (!pe) return;
    pe.flushNudge();
    pe.destroy();
    this.pe = null;
    $('#pages').classList.remove('pe-active');
    this.updateHint();
    this.updatePanel();
  }
  onKey(ev) {
    const key = ev.key;
    if (key === 'Escape') {
      if (this.armed) {
        this.arm(null);
        return true;
      }
      if (this.pe) {
        const obj = this.pe.obj;
        const pv = this.pe.pv;
        this.exitPathEdit();
        if (obj) this.select(pv, [obj], []);
        return true;
      }
      return this.sel ? (this.clearSelection(), true) : false;
    }
    if (!this.sel && !this.pe) return false;
    if (key === 'Delete' || key === 'Backspace') {
      ev.preventDefault();
      this.deleteSelection();
      return true;
    }
    if (
      this.sel &&
      key === 'Enter' &&
      this.sel.blocks.length === 1 &&
      !this.sel.objs.length &&
      this.sel.blocks[0].editable
    ) {
      ev.preventDefault();
      const sel = this.sel;
      const block = sel.blocks[0];
      this.startEdit(
        sel.pv,
        block,
        sel.pv.layerToClient(...sel.pv.pdfToLayer(block.bbox[2], (block.bbox[1] + block.bbox[3]) / 2)),
      );
      return true;
    }
    const step = ev.altKey ? 0.1 : ev.shiftKey ? 10 : 1;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[
      key
    ];
    if (delta) {
      ev.preventDefault();
      if (this.pe) {
        this.pe.nudge(delta[0], delta[1]);
        return true;
      }
      const round = (v) => Math.round(v * 1e6) / 1e6;
      this.nudge = this.nudge || [0, 0];
      this.nudge[0] = round(this.nudge[0] + delta[0]);
      this.nudge[1] = round(this.nudge[1] + delta[1]);
      if (this.sel.el && this.sel.el.isConnected) {
        const box = this.sel.pv.boxOf(this.selBox());
        const [dx, dy] = [this.nudge[0] * this.sel.pv.scale, -this.nudge[1] * this.sel.pv.scale];
        Object.assign(this.sel.el.style, { left: box.left + dx + 'px', top: box.top + dy + 'px' });
      }
      clearTimeout(this.nudgeT);
      this.nudgeT = setTimeout(() => this.flushNudge(), 400);
      return true;
    }
    return false;
  }
  /** Gesammelte Pfeiltasten-Verschiebung als eine Änderung übernehmen. */
  flushNudge() {
    clearTimeout(this.nudgeT);
    const nudge = this.nudge;
    this.nudge = null;
    if (!nudge || !this.sel || (!nudge[0] && !nudge[1])) {
      if (this.sel) this.drawSelection();
      return Promise.resolve();
    }
    return this.applyTransform([1, 0, 0, 1, nudge[0], nudge[1]], 'Verschoben');
  }
  defaultStyle() {
    return this.lastStyle
      ? this.lastStyle
      : {
          fam:
            this.session.fonts.list().filter((i) => i.merged() || i.std)[0] ||
            this.session.fonts.get('std:Helvetica'),
          size: 10,
          color: [0, 0, 0],
        };
  }
  startEdit(pv, block, clickPoint, opts = {}) {
    const req =
      this.curReq && !this.curReq.done && !this.curReq.claimed ? this.curReq : { keys: [], done: false };
    req.claimed = true;
    this.curReq = req;
    if (req.gen == null) req.gen = this.escGen || 0;
    const run = async () => {
      try {
        await this.finishEdit();
        if (this.editor) await this.finishEdit();
        if (this.session.pending) this.session.cancelEdit();
        let current = block;
        if (
          current &&
          ((current =
            this.session
              .model(pv.index)
              .blocks.find(
                (block2) =>
                  block2.text === block.text &&
                  Math.abs(block2.bbox[0] - block.bbox[0]) < 0.5 &&
                  Math.abs(block2.bbox[1] - block.bbox[1]) < 0.5,
              ) || null),
          !current)
        )
          return;
        await this._startEdit(pv, current, clickPoint, opts);
        if (req.keys.length && this.editor && document.activeElement === this.editor.te)
          document.execCommand('insertText', false, req.keys.join(''));
        if ((this.escGen || 0) !== req.gen && this.editor) {
          req.done = true;
          await this.finishEdit();
        }
      } finally {
        req.done = true;
        if (this.curReq === req) this.curReq = null;
      }
    };
    this._editChain = (this._editChain || Promise.resolve()).then(run, run);
    return this._editChain;
  }
  async _startEdit(pv, block, clickPoint, opts = {}) {
    this.clearSelection();
    if (pv.rendered) pv.remember(pv.rendered.sig, pv.rendered.scale);
    const editor = new TextEditor(this.app, pv, block, opts);
    this.editor = editor;
    this.session.beginEdit(pv.index, block || null);
    await editor.open(clickPoint);
    document.body.classList.add('editing');
    if (block) {
      pv.ovSig = null;
      this.drawBoxes(pv);
    }
    this.updatePanel();
    if (pv.hov) pv.hov.classList.add('hidden');
    this.app.sync();
  }
  async escapeEdit() {
    const editor = this.editor;
    if (!editor) return this.finishEdit();
    const pv = editor.pv;
    let anchor = null;
    try {
      const firstLine = editor.collect().find((l) => l.segs && l.segs.length);
      if (firstLine) {
        const seg = firstLine.segs[0];
        anchor = [seg.x, seg.y, seg.size || 10];
      }
    } catch {}
    await this.finishEdit();
    if (!anchor || !this.active) return;
    const model = this.session.model(pv.index);
    const area = (box) => (box[2] - box[0]) * (box[3] - box[1]);
    const block = model.blocks
      .filter((block2) => boxContains(block2.bbox, anchor[0] + 0.5, anchor[1] + anchor[2] * 0.3, 1.5))
      .sort((s, o) => area(s.bbox) - area(o.bbox))[0];
    if (block) {
      this.select(pv, [], [block]);
      this.hintOnce(
        'esc',
        'Textblock ausgewählt: Pfeiltasten verschieben ihn (mit Umschalt in größeren Schritten), Enter bearbeitet den Text.',
      );
    }
  }
  /**
   * Textbearbeitung abschließen. `_committing` ist erfüllt, sobald das Modell den neuen Text
   * enthält (vor der Neudarstellung) – darauf warten Klicks, die währenddessen beginnen.
   */
  finishEdit() {
    if (this._finishing) return this._finishing;
    const editor = this.editor;
    if (!editor) return Promise.resolve();
    let markCommitted;
    const committing = new Promise((resolve) => {
      markCommitted = () => {
        if (this._committing === committing) this._committing = null;
        resolve();
      };
    });
    this._committing = committing;
    return (this._finishing = (async () => {
      try {
        this.editor = null;
        document.body.classList.remove('editing');
        if (editor.te) {
          editor.te.contentEditable = 'false';
          editor.te.blur();
        }
        this.hideMissing();
        if (!editor.dirty && editor.block) {
          await this.session.exclusive(() => this.session.cancelEdit());
          markCommitted();
          await this.app.sync();
          editor.destroy();
          return;
        }
        if (editor.isEmpty() && !editor.block) {
          await this.session.exclusive(() => this.session.cancelEdit());
          markCommitted();
          editor.destroy();
          await this.app.sync();
          return;
        }
        const lines = editor.collect();
        const style = editor.currentStyle && editor.currentStyle();
        if (style && style.fam) this.lastStyle = { fam: style.fam, size: style.size, color: style.color };
        const anchorMoves = editor.anchorMoves ? editor.anchorMoves() : { moves: [], removes: [] };
        const label = editor.block ? 'Text bearbeitet' : 'Text hinzugefügt';
        const index = editor.pv.index;
        let result;
        await this.session.exclusive(() =>
          this.session.batch(label, async () => {
            result = await this.session.commitEdit(lines, label);
            for (const move of anchorMoves.moves) {
              const objs = this.findObjs(index, move.objs);
              if (objs.length)
                this.session.transformObjects(index, objs, [1, 0, 0, 1, move.dx, move.dy], label);
            }
            if (anchorMoves.removes.length) {
              const objs = this.findObjs(index, anchorMoves.removes);
              if (objs.length) this.session.deleteObjects(index, objs, label);
            }
          }),
        );
        markCommitted();
        await this.app.sync();
        editor.destroy();
        if (result && result.warn && result.warn.length)
          toast(
            'Einige Zeichen fehlen in der Originalschrift – dafür wurde ' +
              result.warn.join(', ') +
              ' verwendet.',
            'warn',
            5000,
          );
      } catch (err) {
        console.error(err);
        editor.destroy();
        toast('Die Änderung konnte nicht übernommen werden.', 'err');
      } finally {
        markCommitted();
        this._finishing = null;
        this.updatePanel();
      }
    })());
  }
  findObjs(index, targets) {
    const model = this.session.model(index);
    const found = [];
    for (const target of targets) {
      const match = model.objects.find(
        (obj) =>
          !found.includes(obj) &&
          (target.uid != null
            ? obj.uid === target.uid
            : obj.type === target.type && target.vis.every((o, l) => Math.abs(o - obj.vis[l]) < 0.8)),
      );
      if (match) found.push(match);
    }
    return found;
  }
  onEditorSelection() {
    clearTimeout(this._pt);
    this._pt = setTimeout(() => this.updatePanel(), 60);
  }
  arm(mode) {
    this.armed = mode;
    $('#pages').classList.toggle('mode-add', !!mode);
    const addTextBtn = $('#cAddText');
    if (addTextBtn) addTextBtn.classList.toggle('on', mode === 'text');
    const addImageBtn = $('#cAddImg');
    if (addImageBtn) addImageBtn.classList.toggle('on', mode === 'image');
    if (mode) this.clearSelection();
    this.updateHint();
    this.updatePanel();
  }
  /** Hinweiszeile in der Kopfleiste passend zum Zustand (Hinzufügen, Pfad bearbeiten, Standard). */
  updateHint() {
    const hint = $('#cHint');
    if (!hint) return;
    hint.textContent =
      this.armed === 'text'
        ? 'Klicken Sie auf die Stelle, an der der Text beginnen soll.'
        : this.armed === 'image'
          ? 'Klicken Sie auf die Stelle, an der das Bild eingefügt werden soll.'
          : this.pe
            ? 'Pfad bearbeiten · Punkt oder Kante ziehen · Alt = lösen · Entf = Kante löschen · Esc = fertig'
            : 'Klick in Text: bearbeiten · Pfeiltasten: verschieben · Alt+Klick: Element dahinter';
  }
  sameFamilyVariants(fam) {
    const family = parseFontName(fam.key).family;
    return this.session.fonts.list().filter((i) => i !== fam && parseFontName(i.key).family === family);
  }
  boldTarget(fam) {
    if (!fam) return null;
    if (fam.std) {
      const stdPairs = {
        'std:Helvetica': 'std:Helvetica-Bold',
        'std:Helvetica-Bold': 'std:Helvetica',
        'std:Times-Roman': 'std:Times-Bold',
        'std:Times-Bold': 'std:Times-Roman',
      };
      return stdPairs[fam.key] ? this.session.fonts.get(stdPairs[fam.key]) : null;
    }
    const variants = this.sameFamilyVariants(fam).filter((a) => a.italic === fam.italic);
    const weightOf = (variant) => {
      const style = parseFontName(variant.key).style.toLowerCase();
      return /black|heavy/.test(style)
        ? 900
        : /extrabold/.test(style)
          ? 800
          : /bold/.test(style) && !/semi|demi/.test(style)
            ? 700
            : /semi|demi/.test(style)
              ? 600
              : /medium/.test(style)
                ? 500
                : /light/.test(style)
                  ? 300
                  : 400;
    };
    return weightOf(fam) >= 600
      ? variants
          .filter((a) => weightOf(a) <= 500)
          .sort((a, A) => Math.abs(weightOf(a) - 400) - Math.abs(weightOf(A) - 400))[0] || null
      : variants.filter((a) => weightOf(a) >= 600).sort((a, A) => weightOf(a) - weightOf(A))[0] || null;
  }
  async toggleBold() {
    const editor = this.editor;
    if (!editor) return;
    const style = editor.currentStyle();
    const target = this.boldTarget(style && style.fam);
    if (!target) {
      toast('Für diese Schrift ist im Dokument kein fetter Schnitt vorhanden.', 'warn');
      return;
    }
    await this.session.fonts.ensureCss(target);
    editor.applyStyle({ fam: target });
    this.updatePanel();
  }
  showMissing(editor, missing) {
    this.hideMissing();
    if (!missing.size || (editor !== this.editor && this.editor)) return;
    const [fam, chars] = [...missing.entries()][0];
    const list = [...chars]
      .slice(0, 8)
      .map((o) => '„' + o + '“')
      .join(' ');
    const warnEl = (this.missEl = htmlToElement(
      `<div class="te-warn">${icon('warn', 's')} <b>${escapeHtml(list)}</b> ${chars.size > 1 ? 'sind' : 'ist'} in der eingebetteten Schrift <b>${escapeHtml(fam.label)}</b> nicht enthalten. Beim Speichern wird dafür eine Ersatzschrift verwendet.<br><button class="btn">${icon('fonts', 's')}Schriftdatei laden …</button></div>`,
    ));
    warnEl.querySelector('button').addEventListener('click', () => this.loadFontFor(fam));
    const frame = editor.frame;
    warnEl.style.left = frame.style.left;
    warnEl.style.top = parseFloat(frame.style.top) + frame.offsetHeight + 10 + 'px';
    editor.pv.layer.appendChild(warnEl);
  }
  hideMissing() {
    if (this.missEl) {
      this.missEl.remove();
      this.missEl = null;
    }
  }
  async loadFontFor(fam) {
    const file = await pickFiles('.ttf,.otf,.woff,font/ttf,font/otf');
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    let item;
    try {
      item = this.app.library.add(bytes, 'eigene');
    } catch {
      toast('Diese Datei ist keine lesbare Schriftdatei.', 'err');
      return;
    }
    const label = parseFontName(fam.key).label;
    const ps = item.ps;
    if (!(
      fontKey(item.ps) !== fontKey(fam.key) &&
      !(await showDialog({
        title: 'Andere Schrift?',
        icon: 'fonts',
        body: `Die Datei enthält <b>${escapeHtml(ps)}</b>, benötigt wird <b>${escapeHtml(label)}</b>. Trotzdem für fehlende Zeichen verwenden?`,
        buttons: [
          { label: 'Abbrechen', value: false },
          { label: 'Verwenden', primary: true, value: true },
        ],
      }))
    )) {
      idbPut('fonts', item.ps, bytes.buffer.slice(0));
      await this.app.fontsPanel.attach(fam, item);
      if (this.editor) this.editor.checkMissing();
      toast(
        'Schrift „' +
          item.ps +
          '“ geladen – fehlende Zeichen werden jetzt in der Originalschrift geschrieben.',
      );
    }
  }
  async pickImage(pv, point) {
    const file = await pickFiles('image/png,image/jpeg,image/webp,image/gif,image/bmp,image/svg+xml');
    if (!file) return;
    const image = await this.readImage(file);
    if (image) {
      this.pendingImage = image;
      if (pv && point) return this.placeImage(pv, point);
      this.arm('image');
    }
  }
  async readImage(file) {
    let bytes = new Uint8Array(await file.arrayBuffer());
    let type = file.type;
    if (!/^image\/(png|jpeg)$/.test(type))
      try {
        const decoded = await createImageBitmap(new Blob([bytes], { type: type || 'image/png' }));
        const canvas = document.createElement('canvas');
        canvas.width = decoded.width;
        canvas.height = decoded.height;
        canvas.getContext('2d').drawImage(decoded, 0, 0);
        const blob = await new Promise((o) => canvas.toBlob(o, 'image/png'));
        bytes = new Uint8Array(await blob.arrayBuffer());
        type = 'image/png';
      } catch {
        toast('Dieses Bildformat wird nicht unterstützt (bitte PNG oder JPG).', 'err');
        return null;
      }
    const bitmap = await createImageBitmap(new Blob([bytes], { type }));
    return { bytes, mime: type, w: bitmap.width, h: bitmap.height, name: file.name };
  }
  /**
   * Fügt das vorgemerkte Bild mittig am Punkt ein (96 dpi, höchstens halbe Seitenbreite/-höhe).
   */
  async placeImage(pv, point) {
    const pendingImage = this.pendingImage;
    if (!pendingImage) return;
    this.pendingImage = null;
    this.arm(null);
    const infoRaw = pv.infoRaw;
    let width = pendingImage.w * 0.75;
    let height = pendingImage.h * 0.75;
    if (infoRaw.rotate % 180) [width, height] = [height, width]; // gedrehte Seite: Maße im PDF vertauscht
    const maxWidth = infoRaw.w * 0.5;
    const maxHeight = infoRaw.h * 0.5;
    const fit = Math.min(1, maxWidth / width, maxHeight / height);
    width *= fit;
    height *= fit;
    const x = Math.max(infoRaw.x, Math.min(infoRaw.x + infoRaw.w - width, point[0] - width / 2));
    const y = Math.max(infoRaw.y, Math.min(infoRaw.y + infoRaw.h - height, point[1] - height / 2));
    await withBusy(() =>
      this.enqueue(async () => {
        const index = this.app.pvByKey.has(pv.key) ? this.app.pvByKey.get(pv.key).index : pv.index;
        await this.session.insertImage(index, pendingImage.bytes, pendingImage.mime, [x, y, width, height]);
        this.reselect({
          key: pv.key,
          objs: [{ type: 'image', vis: [x, y, x + width, y + height] }],
          blocks: [],
        });
        this.app.sync();
      }),
    );
  }
  async dropImage(file, ev) {
    if (this.app.tool !== 'edit') await this.app.setTool('edit');
    const pv = this.pvAt(ev) || this.app.pvs[this.app.cur];
    const image = await this.readImage(file);
    if (!image) return;
    this.pendingImage = image;
    const point = this.pvAt(ev)
      ? pv.clientToPdf(ev.clientX, ev.clientY)
      : [pv.infoRaw.x + pv.infoRaw.w / 2, pv.infoRaw.y + pv.infoRaw.h / 2];
    return this.placeImage(pv, point);
  }
  async replaceImage() {
    const sel = this.sel;
    if (!sel || sel.objs.length !== 1) return;
    const uid = sel.objs[0].uid;
    const key = sel.pv.key;
    const file = await pickFiles('image/png,image/jpeg,image/webp,image/gif');
    if (!file) return;
    const image = await this.readImage(file);
    if (image) {
      this.clearSelection();
      await withBusy(() =>
        this.enqueue(async () => {
          const pv = this.app.pvByKey.get(key);
          const obj = pv && this.resolveUids(pv.index, [uid])[0];
          if (!obj) return;
          await this.session.replaceImage(pv.index, obj, image.bytes, image.mime);
          this.app.sync();
        }),
      );
      toast('Bild ersetzt');
    }
  }
  updatePanel() {
    if (!this.active || this.app.tool !== 'edit') return;
    const activeElement = document.activeElement;
    const lpBody = document.getElementById('lpBody');
    if (
      activeElement &&
      lpBody &&
      lpBody.contains(activeElement) &&
      /^(INPUT|SELECT)$/.test(activeElement.tagName)
    ) {
      if (!this._panelDeferred) {
        this._panelDeferred = true;
        activeElement.addEventListener(
          'blur',
          () => {
            this._panelDeferred = false;
            setTimeout(() => this.updatePanel(), 0);
          },
          { once: true },
        );
      }
      return;
    }
    const body = this.app.panel('PDF bearbeiten');
    const editor = this.editor;
    body.appendChild(htmlToElement('<div class="sec"><h4>Hinzufügen</h4></div>'));
    const addSection = body.lastChild;
    const addTextBtn = htmlToElement(
      `<button class="btn big ${this.armed === 'text' ? 'on' : ''}">${icon('textbox')}Text hinzufügen</button>`,
    );
    addTextBtn.addEventListener('click', () => this.arm(this.armed === 'text' ? null : 'text'));
    const addImageBtn = htmlToElement(
      `<button class="btn big ${this.armed === 'image' ? 'on' : ''}">${icon('image')}Bild hinzufügen</button>`,
    );
    addImageBtn.addEventListener('click', () => this.pickImage());
    addSection.append(addTextBtn, addImageBtn);
    if (this.signature) this.signature.mountPanel(addSection);
    const style = editor ? editor.currentStyle() : null;
    const formatSection = htmlToElement('<div class="sec"><h4>Format</h4></div>');
    body.appendChild(formatSection);
    const fonts = this.session.fonts;
    const fontSelect = htmlToElement('<select class="fld" style="width:100%"></select>');
    const docGroup = document.createElement('optgroup');
    docGroup.label = 'Schriften im Dokument';
    for (const fam of fonts.list()) {
      const option = document.createElement('option');
      option.value = fam.key;
      const merged = fam.merged();
      const fewChars =
        !fonts.fullFor(fam) &&
        (merged
          ? merged.uni.size < 40
          : !fam.fonts.some((font) => font.codeFor('a') !== null && font.codeFor('e') !== null));
      option.textContent = fam.label + (fewChars ? ' – nur wenige Zeichen' : '');
      docGroup.appendChild(option);
    }
    const stdGroup = document.createElement('optgroup');
    stdGroup.label = 'Standardschriften';
    for (const fam of fonts.stdList()) {
      const option = document.createElement('option');
      option.value = fam.key;
      option.textContent = fam.label;
      stdGroup.appendChild(option);
    }
    fontSelect.append(docGroup, stdGroup);
    if (style && style.fam) fontSelect.value = style.fam.key;
    fontSelect.disabled = !editor;
    fontSelect.addEventListener('change', async () => {
      const fam = fonts.get(fontSelect.value);
      await fonts.ensureCss(fam);
      if (this.editor) {
        this.editor.te.focus();
        this.editor.applyStyle({ fam });
      }
    });
    formatSection.appendChild(htmlToElement('<div class="row"></div>')).appendChild(fontSelect);
    const sizeRow = htmlToElement('<div class="row"></div>');
    formatSection.appendChild(sizeRow);
    const sizeInput = htmlToElement(
      '<input class="fld num" type="number" min="1" max="400" step="0.5" title="Schriftgröße (pt)">',
    );
    sizeInput.value = style ? String(Math.round(style.size * 10) / 10) : '';
    sizeInput.placeholder = '–';
    sizeInput.disabled = !editor;
    sizeInput.addEventListener('change', () => {
      const size = parseFloat(sizeInput.value);
      if (size > 0 && this.editor) {
        const style2 = this.editor.currentStyle();
        this.editor.applyStyle({ size, oldSize: style2 && style2.size });
      }
    });
    sizeInput.addEventListener('keydown', (ev) => ev.stopPropagation());
    const colorInput = htmlToElement('<input class="color" type="color" title="Textfarbe">');
    colorInput.value = style ? rgbToHex(style.color) : '#000000';
    colorInput.disabled = !editor;
    colorInput.addEventListener('input', () => {
      if (this.editor) this.editor.applyStyle({ color: hexToRgb(colorInput.value) });
    });
    const boldBtn = htmlToElement(
      `<button class="btn outline ic" title="Fett (Strg+B)">${icon('bold', 's')}</button>`,
    );
    const boldFam = style && this.boldTarget(style.fam);
    boldBtn.disabled = !editor || !boldFam;
    if (style && style.fam && style.fam.bold) boldBtn.classList.add('on');
    boldBtn.addEventListener('click', () => this.toggleBold());
    sizeRow.append(sizeInput, htmlToElement('<span class="hint">pt</span>'), colorInput, boldBtn);
    const alignSeg = htmlToElement(
      `<div class="seg">${['left', 'center', 'right', 'justify'].map((m) => `<button data-a="${m}" title="${{ left: 'Linksbündig', center: 'Zentriert', right: 'Rechtsbündig', justify: 'Blocksatz' }[m]}">${icon({ left: 'al', center: 'ac', right: 'ar', justify: 'aj' }[m], 's')}</button>`).join('')}</div>`,
    );
    for (const btn of alignSeg.children) {
      btn.disabled = !editor;
      if (style && style.align === btn.dataset.a) btn.classList.add('on');
      btn.addEventListener('click', () => {
        if (this.editor) {
          this.editor.setAlign(btn.dataset.a);
          this.updatePanel();
        }
      });
    }
    formatSection.appendChild(htmlToElement('<div class="row"></div>')).appendChild(alignSeg);
    if (editor) {
      const deleteBtn = htmlToElement(
        `<button class="btn outline" style="width:100%;justify-content:center;margin-top:4px">${icon('trash', 's')}Textblock löschen</button>`,
      );
      deleteBtn.addEventListener('click', async () => {
        if (this.editor) {
          this.editor.te.innerHTML = '';
          this.editor.dirty = true;
          await this.finishEdit();
        }
      });
      formatSection.appendChild(deleteBtn);
      formatSection.appendChild(
        htmlToElement(
          '<p class="hint" style="margin-top:10px">Markieren Sie Text, um nur diesen zu ändern – ohne Markierung gilt die Änderung für den ganzen Block. <kbd>Esc</kbd> übernimmt die Änderung und wählt den Textblock aus – dann verschieben ihn die Pfeiltasten.</p>',
        ),
      );
    } else
      formatSection.appendChild(
        htmlToElement('<p class="hint">Klicken Sie in einen Textblock, um Text und Format zu ändern.</p>'),
      );
    if (this.sel) {
      const sel = this.sel;
      const selBox = this.fieldBox();
      const infoRaw = sel.pv.infoRaw;
      const selSection = htmlToElement(
        `<div class="sec"><h4>Auswahl – ${escapeHtml(this.selLabel())}</h4></div>`,
      );
      body.appendChild(selSection);
      const fmt = (value) => (Math.round(value * 10) / 10).toString().replace('.', ',');
      const grid = htmlToElement(
        '<div style="display:grid;grid-template-columns:auto 1fr auto 1fr;gap:6px 8px;align-items:center;margin-bottom:10px"></div>',
      );
      const fields = [
        ['X', ptToMm(selBox[0] - infoRaw.x)],
        ['Y', ptToMm(infoRaw.y + infoRaw.h - selBox[3])],
        ['B', ptToMm(selBox[2] - selBox[0])],
        ['H', ptToMm(selBox[3] - selBox[1])],
      ];
      const inputs = {};
      for (const [key, value] of fields) {
        grid.appendChild(htmlToElement(`<span class="hint">${key}</span>`));
        const input = htmlToElement(
          `<input class="fld" style="width:100%;text-align:right" title="${{ X: 'Abstand von links', Y: 'Abstand von oben', B: 'Breite', H: 'Höhe' }[key]} in mm">`,
        );
        input.value = fmt(value);
        input.disabled =
          (key === 'B' || key === 'H') &&
          (sel.blocks.length > 0 || (key === 'B' ? selBox[2] - selBox[0] : selBox[3] - selBox[1]) < 1e-6);
        input.addEventListener('keydown', (ev) => {
          ev.stopPropagation();
          if (ev.key === 'Enter') input.blur();
        });
        input.addEventListener('change', () => this.applyFields(inputs));
        inputs[key] = input;
        grid.appendChild(input);
      }
      selSection.appendChild(grid);
      selSection.appendChild(
        htmlToElement(
          '<p class="hint" style="margin:-4px 0 10px">Werte in mm, gemessen von der linken oberen Seitenecke.</p>',
        ),
      );
      const actions = htmlToElement('<div style="display:flex;gap:6px;flex-wrap:wrap"></div>');
      const addButton = (iconName, label, onClick, disabled) => {
        const btn = htmlToElement(
          `<button class="btn outline" ${disabled ? 'disabled' : ''}>${icon(iconName, 's')}${escapeHtml(label)}</button>`,
        );
        btn.addEventListener('click', onClick);
        actions.appendChild(btn);
        return btn;
      };
      const isSingleImage =
        sel.objs.length === 1 && sel.objs[0].type === 'image' && !sel.objs[0].inline && !sel.blocks.length;
      addButton('rotl', '', () => this.rotateSelection(-90), !sel.objs.length || sel.blocks.length).title =
        'Um 90° nach links drehen';
      addButton('rotr', '', () => this.rotateSelection(90), !sel.objs.length || sel.blocks.length).title =
        'Um 90° nach rechts drehen';
      if (isSingleImage) addButton('replace', 'Ersetzen …', () => this.replaceImage());
      addButton('tofront', '', () => this.restack('front'), !sel.objs.length || sel.blocks.length).title =
        'In den Vordergrund (über alle anderen Elemente)';
      addButton('toback', '', () => this.restack('back'), !sel.objs.length || sel.blocks.length).title =
        'In den Hintergrund (hinter alle anderen Elemente)';
      addButton('trash', 'Löschen', () => this.deleteSelection());
      selSection.appendChild(actions);
      selSection.appendChild(
        htmlToElement(
          '<p class="hint" style="margin-top:10px">Ziehen oder <kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> verschiebt (1 pt, mit <kbd>Umschalt</kbd> 10 pt, mit <kbd>Alt</kbd> 0,1 pt). Beim Ziehen rastet es an Hilfslinien ein (Seitenmitte, Ränder, bündig mit anderen Elementen) – mit <kbd>Alt</kbd> frei. Die Griffe ändern die Größe, bei Linien die runden Endpunkte (<kbd>Umschalt</kbd> = 0°/45°/90°). Ein Klick in eine ausgewählte Gruppe wählt nur das Element darunter; ein weiterer Klick oder ein Doppelklick auf eine Grafik öffnet „Pfad bearbeiten“. <kbd>Alt</kbd>+Klick wählt das Element dahinter.</p>',
        ),
      );
    } else if (this.pe) {
      const peSection = htmlToElement(
        `<div class="sec"><h4>Pfad bearbeiten</h4><p class="hint">Ankerpunkt oder Kante anklicken und ziehen; <kbd>Umschalt</kbd>+Klick wählt mehrere. Verbundene Punkte (Ecken, anliegende Linien der Gruppe) wandern mit – mit <kbd>Alt</kbd> wird die Verbindung gelöst. <kbd>Umschalt</kbd> beim Ziehen: 0°/45°/90°. Pfeiltasten verschieben die gewählten Punkte (<kbd>Umschalt</kbd> 10 pt, <kbd>Alt</kbd> 0,1 pt). <kbd>Esc</kbd> oder ein Klick daneben beendet.</p></div>`,
      );
      const doneBtn = htmlToElement(`<button class="btn outline">${icon('check', 's')}Fertig</button>`);
      doneBtn.addEventListener('click', () => {
        const pe = this.pe;
        const obj = pe && pe.obj;
        this.exitPathEdit();
        if (obj) this.select(pe.pv, [obj], []);
      });
      peSection.appendChild(doneBtn);
      body.appendChild(peSection);
    } else if (!editor)
      body.appendChild(
        htmlToElement(
          '<div class="sec"><h4>Bilder &amp; Grafiken</h4><p class="hint">Klicken Sie auf ein Bild oder eine Grafik, um sie auszuwählen. Mit gedrückter Maustaste auf freier Fläche ziehen, um mehrere Elemente auszuwählen. Verdeckte Elemente: <kbd>Alt</kbd>+Klick oder Rechtsklick.</p></div>',
        ),
      );
  }
  applyFields(inputs) {
    const sel = this.sel;
    if (!sel) return;
    if (this.nudge) {
      clearTimeout(this.nudgeT);
      this.nudge = null;
    }
    const selBox = this.fieldBox();
    const infoRaw = sel.pv.infoRaw;
    const read = (input) => parseFloat(String(input.value).replace(',', '.'));
    const x = mmToPt(read(inputs.X)) + infoRaw.x;
    const top = infoRaw.y + infoRaw.h - mmToPt(read(inputs.Y));
    const width = mmToPt(read(inputs.B));
    const height = mmToPt(read(inputs.H));
    // Ohne Ausdehnung (waagerechte bzw. senkrechte Linie) gibt es nichts zu skalieren
    const flatX = selBox[2] - selBox[0] < 1e-6;
    const flatY = selBox[3] - selBox[1] < 1e-6;
    if (![x, top].every(isFinite) || (!flatX && !(width > 0)) || (!flatY && !(height > 0))) {
      this.updatePanel();
      return;
    }
    const scaleX = sel.blocks.length || flatX ? 1 : width / (selBox[2] - selBox[0]);
    const scaleY = sel.blocks.length || flatY ? 1 : height / (selBox[3] - selBox[1]);
    const left = x;
    const bottom = top - (sel.blocks.length || flatY ? selBox[3] - selBox[1] : height);
    const matrix = [scaleX, 0, 0, scaleY, left - scaleX * selBox[0], bottom - scaleY * selBox[1]];
    if (!(
      Math.abs(matrix[4]) < 0.001 &&
      Math.abs(matrix[5]) < 0.001 &&
      Math.abs(scaleX - 1) < 1e-4 &&
      Math.abs(scaleY - 1) < 1e-4
    ))
      this.applyTransform(matrix, 'Position geändert');
  }
}

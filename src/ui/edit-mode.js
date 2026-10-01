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
import { boxContains, boxInside, hexToRgb, mmToPt, ptToMm, rgbToHex, unionBoxes } from './geometry.js';

/**
 * Modus „PDF bearbeiten“: Auswahl, Verschieben, Größe ändern, Drehen, Ebenen, Text und Bilder.
 *
 * Zeigerereignisse (registriert in `wire()` auf #pages):
 *   pointerdown → `onDown()`, pointermove → `onHover()`, contextmenu → `onContext()`,
 *   dblclick → Text bearbeiten. Ziehen läuft in `startDrag()`/`startMarquee()` über
 *   window-Listener für pointermove/pointerup (ohne Pointer-Capture); ein Zug unter 3 px gilt als
 *   Klick (dann `drillDown()`). Der Rahmen des Inline-Editors (Verschiebegriff, Breite) hat eigene
 *   Listener in TextEditor.wire()/dragWidth() mit setPointerCapture.
 *
 * Auswahl: `this.sel = { pv, objs, blocks, el }`; `drawSelection()` zeichnet den Rahmen `.sel`
 * mit acht Griffen `.h` (data-h = nw|n|ne|e|se|s|sw|w) – nur wenn ausschließlich Grafik gewählt ist.
 * Treffer: `hit()` (kleinster Textblock, sonst kleinstes Objekt, Toleranz 3 px; Rückgabe mit
 * Gruppe aus dem Cluster), `stackAt()` (alle Elemente unter dem Zeiger, für Alt+Klick/Kontextmenü).
 * Pfeiltasten sammeln Verschiebungen in `this.nudge` und übernehmen sie nach 400 ms (`flushNudge`).
 */
export class EditMode {
  constructor(app) {
    this.app = app;
    this.editor = null;
    this.sel = null;
    this.armed = null;
    this.lastStyle = null;
    this._finishing = null;
  }
  get session() {
    return this.app.session;
  }
  reset() {
    document.body.classList.remove('editing');
    if (this.editor) {
      this.editor.destroy();
      this.editor = null;
    }
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
    $('#cDone').addEventListener('click', () => this.app.setTool(null));
    if (!this.wired) this.wire();
    this.updatePanel();
    for (const pv of this.app.pvs) if (pv.visible) this.drawBoxes(pv);
  }
  leave() {
    this.active = false;
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
    }
  }
  afterSync() {
    if (this.active) {
      for (const pv of this.app.pvs) if (pv.visible || pv.ov) this.drawBoxes(pv);
      if (this.pendingReselect) {
        const pendingReselect = this.pendingReselect;
        this.pendingReselect = null;
        this.reselect(pendingReselect);
      }
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
  }
  wire() {
    this.wired = true;
    window.addEventListener(
      'keydown',
      (ev) => {
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
      if (this.active && !this.drag) this.onHover(ev);
    });
    pages.addEventListener('pointerleave', () => {
      for (const pv of this.app.pvs) if (pv.hov) pv.hov.classList.add('hidden');
    });
    pages.addEventListener('contextmenu', (ev) => {
      if (this.active) this.onContext(ev);
    });
    pages.addEventListener('dblclick', (ev) => {
      if (!this.active) return;
      const pv = this.pvAt(ev);
      if (!pv) return;
      const hit = this.hit(pv, ev.clientX, ev.clientY);
      if (hit && hit.block && hit.block.editable) this.startEdit(pv, hit.block, [ev.clientX, ev.clientY]);
    });
  }
  pvAt(ev) {
    const pageEl = ev.target.closest && ev.target.closest('.page');
    return pageEl ? this.app.pvByKey.get(pageEl.dataset.key) : null;
  }
  /**
   * Element unter dem Zeiger: zuerst der kleinste Textblock, sonst das kleinste auswählbare
   * Objekt (Toleranz 3 Bildschirmpixel) samt seiner Gruppe.
   */
  hit(pv, clientX, clientY) {
    const model = this.session.model(pv.index);
    const [x, y] = pv.clientToPdf(clientX, clientY);
    const tolerance = 3 / pv.scale;
    const block = model.blocks
      .filter((block2) => boxContains(block2.bbox, x, y, 1))
      .sort(
        (h, u) =>
          (h.bbox[2] - h.bbox[0]) * (h.bbox[3] - h.bbox[1]) -
          (u.bbox[2] - u.bbox[0]) * (u.bbox[3] - u.bbox[1]),
      )[0];
    if (block) return { block };
    const objects = model.objects.filter((obj2) => obj2.selectable && boxContains(obj2.vis, x, y, tolerance));
    if (!objects.length) return null;
    objects.sort((h, u) => h.area - u.area);
    const obj = objects[0];
    return { obj, group: obj.cluster ? obj.cluster.members : [obj] };
  }
  stackAt(pv, clientX, clientY) {
    const model = this.session.model(pv.index);
    const [x, y] = pv.clientToPdf(clientX, clientY);
    const tolerance = 3 / pv.scale;
    const area = (box) => (box[2] - box[0]) * (box[3] - box[1]);
    const blocks = model.blocks
      .filter((block) => boxContains(block.bbox, x, y, 1))
      .sort((h, u) => area(h.bbox) - area(u.bbox));
    const objects = model.objects
      .filter((obj) => obj.selectable && boxContains(obj.vis, x, y, tolerance))
      .reverse();
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
    return !!sel && (item.obj ? sel.objs.includes(item.obj) : sel.blocks.includes(item.block));
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
  drillDown(pv, clientX, clientY) {
    const sel = this.sel;
    if (!(!sel || sel.pv !== pv))
      if (sel.objs.length + sel.blocks.length > 1) {
        const hits = this.stackAt(pv, clientX, clientY).filter((o) => this.isSelected(o));
        if (!hits.length) return;
        const objHits = hits.filter((o) => o.obj).sort((o, l) => o.obj.area - l.obj.area);
        const target = hits.find((o) => o.block) || objHits[0];
        this.select(pv, target.obj ? [target.obj] : [], target.block ? [target.block] : []);
        this.hintOnce(
          'drill',
          'Nur dieses Element ausgewählt. Alt+Klick wählt das Element dahinter, Rechtsklick zeigt alle Elemente an dieser Stelle.',
        );
      } else if (sel.blocks.length === 1 && sel.blocks[0].editable)
        this.startEdit(pv, sel.blocks[0], [clientX, clientY]);
  }
  hintOnce(id, message) {
    this._hints = this._hints || new Set();
    if (!this._hints.has(id)) {
      this._hints.add(id);
      toast(message, '', 4200);
    }
  }
  onHover(ev) {
    const pv = this.pvAt(ev);
    for (const other of this.app.pvs) if (other !== pv && other.hov) other.hov.classList.add('hidden');
    if (!pv || !pv.hov || this.armed) return;
    if (ev.target.closest('.sel,.te-frame,.te-warn')) {
      pv.hov.classList.add('hidden');
      return;
    }
    const hit = this.hit(pv, ev.clientX, ev.clientY);
    const bbox = hit ? (hit.block ? hit.block.bbox : unionBoxes(hit.group.map((A) => A.vis))) : null;
    if (!bbox || (this.editor && hit.block && this.editor.block && hit.block.id === this.editor.block.id)) {
      pv.hov.classList.add('hidden');
      pv.layer.style.cursor = '';
      return;
    }
    const box = pv.boxOf(bbox);
    Object.assign(pv.hov.style, {
      left: box.left + 'px',
      top: box.top + 'px',
      width: box.width + 'px',
      height: box.height + 'px',
    });
    pv.hov.className = 'bx ' + (hit.block ? 'hov' : 'hovo');
    pv.layer.style.cursor = hit.block ? (hit.block.editable ? 'text' : 'not-allowed') : 'move';
  }
  /**
   * Linke Maustaste auf einer Seite: Alt/Strg+Klick wählt das Element dahinter; Klick in die
   * Auswahl oder auf einen Griff startet Ziehen/Skalieren; „Text/Bild hinzufügen“ platziert;
   * Klick in Text öffnet den Editor; Klick auf Grafik wählt deren Gruppe und startet das Ziehen;
   * sonst Auswahlrahmen.
   */
  async onDown(ev) {
    if (ev.button !== 0) return;
    const pv = this.pvAt(ev);
    if (
      !pv ||
      (this.nudge &&
        (this._nudging
          ? ((this.nudge = null), clearTimeout(this.nudgeT))
          : (clearTimeout(this.nudgeT), this.flushNudge())),
      ev.target.closest('.te-frame') || ev.target.closest('.te-warn'))
    )
      return;
    const clientX = ev.clientX;
    const clientY = ev.clientY;
    const pickBehind =
      (ev.altKey || ev.ctrlKey || ev.metaKey) && !ev.shiftKey && !this.armed && !ev.target.dataset.h;
    if (pickBehind && !this.editor) {
      ev.preventDefault();
      if (this.selectBehind(pv, clientX, clientY)) return this.startDrag(ev, pv, null);
      this.clearSelection();
      return;
    }
    if (ev.target.closest('.sel'))
      return this.startDrag(
        ev,
        pv,
        ev.target.dataset.h || null,
        ev.target.dataset.h ? null : { x: clientX, y: clientY },
      );
    if (this.armed === 'text') {
      ev.preventDefault();
      const pdfPoint = pv.clientToPdf(clientX, clientY);
      this.arm(null);
      return this.startEdit(pv, null, null, { point: pdfPoint, ...this.defaultStyle() });
    }
    if (this.armed === 'image') {
      ev.preventDefault();
      const pdfPoint = pv.clientToPdf(clientX, clientY);
      return this.placeImage(pv, pdfPoint);
    }
    if (
      this.editor &&
      (ev.preventDefault(),
      (this.curReq = { keys: [], done: false, gen: this.escGen || 0 }),
      await this.finishEdit(),
      pickBehind && this.selectBehind(pv, clientX, clientY))
    )
      return;
    const hit = this.hit(pv, clientX, clientY);
    if (hit && hit.block) {
      ev.preventDefault();
      if (ev.shiftKey || !hit.block.editable) {
        this.select(pv, [], [hit.block], ev.shiftKey);
        if (!hit.block.editable && !ev.shiftKey)
          toast('Gedrehter Text kann nicht bearbeitet, aber gelöscht werden.', 'warn');
        return;
      }
      this.clearSelection();
      return this.startEdit(pv, hit.block, [clientX, clientY]);
    }
    if (hit && hit.obj) {
      ev.preventDefault();
      const extend = ev.shiftKey && this.sel && this.sel.pv === pv;
      this.select(pv, hit.group, [], extend);
      return this.startDrag(ev, pv, null);
    }
    this.clearSelection();
    this.startMarquee(ev, pv);
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
  async restack(direction) {
    const sel = this.sel;
    if (!sel || !sel.objs.length || sel.blocks.length) return;
    const reselect = this.targetsAfter([1, 0, 0, 1, 0, 0]);
    let ok = false;
    await withBusy(async () => {
      ok = this.session.restackObjects(sel.pv.index, sel.objs, direction);
      if (ok) {
        this.pendingReselect = reselect;
        await this.app.sync();
      }
    });
    if (ok) toast(direction === 'back' ? 'In den Hintergrund gelegt' : 'In den Vordergrund geholt');
    else toast('Die Reihenfolge lässt sich auf dieser Seite nicht ändern.', 'warn');
  }
  select(pv, objs, blocks, extend = false) {
    if (this.editor) this.finishEdit();
    if (extend && this.sel && this.sel.pv === pv) {
      objs = [...new Set([...this.sel.objs, ...objs])];
      blocks = [...new Set([...this.sel.blocks, ...blocks])];
    }
    if (this.sel && this.sel.el) this.sel.el.remove();
    this.sel = { pv, objs, blocks };
    this.drawSelection();
    this.updatePanel();
  }
  clearSelection() {
    if (this.sel && this.sel.el) this.sel.el.remove();
    this.sel = null;
    this.updatePanel();
  }
  hasSelection() {
    return !!(this.sel && (this.sel.objs.length || this.sel.blocks.length));
  }
  selBox(sel = this.sel) {
    return unionBoxes([...sel.objs.map((obj) => obj.vis), ...sel.blocks.map((block) => block.bbox)]);
  }
  drawSelection() {
    const sel = this.sel;
    if (!sel) return;
    if (sel.el) sel.el.remove();
    if (!sel.objs.length && !sel.blocks.length) {
      this.sel = null;
      return;
    }
    const box = sel.pv.boxOf(this.selBox());
    if (this.nudge) {
      box.left += this.nudge[0] * sel.pv.scale;
      box.top -= this.nudge[1] * sel.pv.scale;
    }
    const el = (sel.el = document.createElement('div'));
    el.className = 'sel';
    Object.assign(el.style, {
      left: box.left + 'px',
      top: box.top + 'px',
      width: Math.max(2, box.width) + 'px',
      height: Math.max(2, box.height) + 'px',
    });
    if (sel.objs.length && !sel.blocks.length)
      for (const [dir, x, y] of [
        ['nw', 0, 0],
        ['n', 50, 0],
        ['ne', 100, 0],
        ['e', 100, 50],
        ['se', 100, 100],
        ['s', 50, 100],
        ['sw', 0, 100],
        ['w', 0, 50],
      ]) {
        const handle = document.createElement('div');
        handle.className = 'h';
        handle.dataset.h = dir;
        handle.style.left = x + '%';
        handle.style.top = y + '%';
        el.appendChild(handle);
      }
    const tag = document.createElement('div');
    tag.className = 'tag';
    tag.textContent = this.selLabel();
    el.appendChild(tag);
    sel.pv.layer.appendChild(el);
  }
  selLabel() {
    const sel = this.sel;
    const parts = [];
    const images = sel.objs.filter((obj) => obj.type === 'image').length;
    const others = sel.objs.length - images;
    if (images) parts.push(images === 1 ? 'Bild' : images + ' Bilder');
    if (others) parts.push(others === 1 ? 'Grafikelement' : 'Grafik (' + others + ' Teile)');
    if (sel.blocks.length)
      parts.push(sel.blocks.length === 1 ? 'Textblock' : sel.blocks.length + ' Textblöcke');
    return parts.join(' · ');
  }
  reselect(target) {
    const pv = this.app.pvByKey.get(target.key);
    if (!pv) return;
    const model = this.session.model(pv.index);
    const objs = [];
    const blocks = [];
    for (const obj of target.objs) {
      const match = model.objects.find(
        (obj2) =>
          obj2.selectable &&
          !objs.includes(obj2) &&
          obj2.type === obj.type &&
          obj.vis.every((l, c) => Math.abs(l - obj2.vis[c]) < 1.5),
      );
      if (match) objs.push(match);
    }
    for (const block of target.blocks) {
      const match = model.blocks.find(
        (block2) =>
          block2.text === block.text &&
          Math.abs(block2.bbox[0] - block.bbox[0]) < 1 &&
          Math.abs(block2.bbox[3] - block.bbox[3]) < 1,
      );
      if (match) blocks.push(match);
    }
    if (objs.length || blocks.length) this.select(pv, objs, blocks);
    else this.clearSelection();
  }
  targetsAfter(matrix) {
    const sel = this.sel;
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
      key: sel.pv.key,
      objs: sel.objs.map((obj) => ({ type: obj.type, vis: transformBox(obj.vis) })),
      blocks: sel.blocks.map((block) => ({ text: block.text, bbox: transformBox(block.bbox) })),
    };
  }
  /**
   * Verschieben (handle = null) oder Skalieren über einen Griff. Während des Ziehens wird nur
   * der Auswahlrahmen (und eine Bildkopie „ghost“) bewegt; beim Loslassen wird die Matrix in
   * PDF-Koordinaten berechnet und über `applyTransform()` angewendet. Umschalt = Achse sperren bzw.
   * Seitenverhältnis frei, Alt = ohne Einrasten (SnapGuides).
   */
  startDrag(ev, pv, handle, clickPoint = null) {
    const sel = this.sel;
    if (!sel || !sel.el) return;
    ev.preventDefault();
    const selEl = sel.el;
    const clientX = ev.clientX;
    const clientY = ev.clientY;
    const start = {
      left: parseFloat(selEl.style.left),
      top: parseFloat(selEl.style.top),
      width: parseFloat(selEl.style.width),
      height: parseFloat(selEl.style.height),
    };
    let ghost = null;
    if (pv.rot === 0 && pv.canvas.width) {
      const pxPerLayer = pv.canvas.width / pv.dw;
      ghost = document.createElement('canvas');
      ghost.className = 'ghost';
      ghost.width = Math.max(1, Math.round(start.width * pxPerLayer));
      ghost.height = Math.max(1, Math.round(start.height * pxPerLayer));
      try {
        ghost
          .getContext('2d')
          .drawImage(
            pv.canvas,
            start.left * pxPerLayer,
            start.top * pxPerLayer,
            start.width * pxPerLayer,
            start.height * pxPerLayer,
            0,
            0,
            ghost.width,
            ghost.height,
          );
      } catch {}
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
    const moving = new Set([...sel.objs, ...sel.blocks]);
    let guides = null;
    try {
      guides = new SnapGuides(pv, this.session.model(pv.index), (B) => moving.has(B));
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
    const onUp = async () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      this.drag = false;
      if (guides) guides.clear();
      if (!moved) {
        if (ghost) ghost.remove();
        if (clickPoint) this.drillDown(pv, clickPoint.x, clickPoint.y);
        return;
      }
      const scale = pv.scale;
      let matrix;
      if (!handle)
        matrix = [1, 0, 0, 1, (current.left - start.left) / scale, -(current.top - start.top) / scale];
      else {
        const scaleX = current.width / start.width;
        const scaleY = current.height / start.height;
        const selBox = this.selBox();
        const [x0, y0, x1, y1] = [
          pv.layerToPdf(current.left, current.top + current.height),
          pv.layerToPdf(current.left + current.width, current.top),
        ].flat();
        matrix = [scaleX, 0, 0, scaleY, x0 - scaleX * selBox[0], y0 - scaleY * selBox[1]];
      }
      await this.applyTransform(matrix, handle ? 'Größe geändert' : 'Verschoben');
      if (ghost) ghost.remove();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  async applyTransform(matrix, label) {
    const sel = this.sel;
    if (!sel) return;
    const index = sel.pv.index;
    const reselect = this.targetsAfter(matrix);
    const isTranslation = matrix[0] === 1 && matrix[3] === 1 && matrix[1] === 0 && matrix[2] === 0;
    if (sel.blocks.length && !isTranslation) return;
    if (sel.blocks.filter((block) => !block.editable).length && isTranslation) {
      toast('Gedrehter Text kann nicht verschoben werden.', 'warn');
      this.drawSelection();
      return;
    }
    await withBusy(async () => {
      await this.session.batch(label, async () => {
        if (sel.objs.length) this.session.transformObjects(index, sel.objs, matrix, label);
        if (sel.blocks.length) await this.session.moveBlocks(index, sel.blocks, matrix[4], matrix[5]);
      });
      this.pendingReselect = reselect;
      await this.app.sync();
    });
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
  async deleteSelection() {
    const sel = this.sel;
    if (!sel) return;
    const index = sel.pv.index;
    this.clearSelection();
    await this.session.batch(
      sel.objs.length && sel.blocks.length
        ? 'Auswahl gelöscht'
        : sel.blocks.length
          ? 'Text gelöscht'
          : 'Objekt gelöscht',
      async () => {
        if (sel.objs.length) this.session.deleteObjects(index, sel.objs);
        if (sel.blocks.length) {
          const model = this.session.model(index);
          const blocks = sel.blocks
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
    await this.app.sync();
  }
  startMarquee(ev, pv) {
    const [startX, startY] = pv.clientToLayer(ev.clientX, ev.clientY);
    const marquee = document.createElement('div');
    marquee.className = 'marq';
    pv.layer.appendChild(marquee);
    let rect = null;
    const onMove = (moveEv) => {
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
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      marquee.remove();
      if (!rect || rect.width < 4 || rect.height < 4) return;
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
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }
  onKey(ev) {
    const key = ev.key;
    if (key === 'Escape')
      return this.armed ? (this.arm(null), true) : this.sel ? (this.clearSelection(), true) : false;
    if (!this.sel) return false;
    if (key === 'Delete' || key === 'Backspace') {
      ev.preventDefault();
      this.deleteSelection();
      return true;
    }
    if (
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
    const step = ev.shiftKey ? 10 : 1;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[
      key
    ];
    if (delta) {
      ev.preventDefault();
      this.nudge = this.nudge || [0, 0];
      this.nudge[0] += delta[0];
      this.nudge[1] += delta[1];
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
  flushNudge() {
    if (this._nudging) {
      clearTimeout(this.nudgeT);
      this.nudgeT = setTimeout(() => this.flushNudge(), 120);
      return this._nudging;
    }
    const nudge = this.nudge;
    this.nudge = null;
    return !nudge || !this.sel || (!nudge[0] && !nudge[1])
      ? (this.sel && this.drawSelection(), Promise.resolve())
      : ((this._nudging = this.applyTransform([1, 0, 0, 1, nudge[0], nudge[1]], 'Verschoben').finally(() => {
          this._nudging = null;
        })),
        this._nudging);
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
  finishEdit() {
    if (this._finishing) return this._finishing;
    const editor = this.editor;
    return editor
      ? ((this._finishing = (async () => {
          try {
            this.editor = null;
            document.body.classList.remove('editing');
            if (editor.te) {
              editor.te.contentEditable = 'false';
              editor.te.blur();
            }
            this.hideMissing();
            if (!editor.dirty && editor.block) {
              this.session.cancelEdit();
              await this.app.sync();
              editor.destroy();
              return;
            }
            if (editor.isEmpty() && !editor.block) {
              this.session.cancelEdit();
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
            await this.session.batch(label, async () => {
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
            });
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
            this._finishing = null;
            this.updatePanel();
          }
        })()),
        this._finishing)
      : Promise.resolve();
  }
  findObjs(index, targets) {
    const model = this.session.model(index);
    const found = [];
    for (const target of targets) {
      const match = model.objects.find(
        (obj) =>
          !found.includes(obj) &&
          obj.type === target.type &&
          target.vis.every((o, l) => Math.abs(o - obj.vis[l]) < 0.8),
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
    const hint = $('#cHint');
    if (hint)
      hint.textContent =
        mode === 'text'
          ? 'Klicken Sie auf die Stelle, an der der Text beginnen soll.'
          : mode === 'image'
            ? 'Klicken Sie auf die Stelle, an der das Bild eingefügt werden soll.'
            : 'Klick in Text: bearbeiten · Pfeiltasten: verschieben · Alt+Klick: Element dahinter';
    if (mode) this.clearSelection();
    this.updatePanel();
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
    const maxWidth = infoRaw.w * 0.5;
    const maxHeight = infoRaw.h * 0.5;
    const fit = Math.min(1, maxWidth / width, maxHeight / height);
    width *= fit;
    height *= fit;
    const x = Math.max(infoRaw.x, Math.min(infoRaw.x + infoRaw.w - width, point[0] - width / 2));
    const y = Math.max(infoRaw.y, Math.min(infoRaw.y + infoRaw.h - height, point[1] - height / 2));
    await withBusy(async () => {
      await this.session.insertImage(pv.index, pendingImage.bytes, pendingImage.mime, [x, y, width, height]);
      this.pendingReselect = {
        key: pv.key,
        objs: [{ type: 'image', vis: [x, y, x + width, y + height] }],
        blocks: [],
      };
      await this.app.sync();
    });
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
    const obj = sel.objs[0];
    const file = await pickFiles('image/png,image/jpeg,image/webp,image/gif');
    if (!file) return;
    const image = await this.readImage(file);
    if (image) {
      await withBusy(async () => {
        await this.session.replaceImage(sel.pv.index, obj, image.bytes, image.mime);
        this.pendingReselect = { key: sel.pv.key, objs: [], blocks: [] };
        this.clearSelection();
        await this.app.sync();
      });
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
      const selBox = this.selBox();
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
        input.disabled = (key === 'B' || key === 'H') && sel.blocks.length > 0;
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
          '<p class="hint" style="margin-top:10px">Ziehen oder <kbd>←</kbd><kbd>→</kbd><kbd>↑</kbd><kbd>↓</kbd> verschiebt (mit <kbd>Umschalt</kbd> in 10er-Schritten). Beim Ziehen rastet es an Hilfslinien ein (Seitenmitte, Ränder, bündig mit anderen Elementen) – mit <kbd>Alt</kbd> frei. Eckpunkte ändern die Größe. Ein Klick in eine ausgewählte Gruppe wählt nur das Element darunter; <kbd>Alt</kbd>+Klick wählt das Element dahinter.</p>',
        ),
      );
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
    const selBox = this.selBox();
    const infoRaw = sel.pv.infoRaw;
    const read = (input) => parseFloat(String(input.value).replace(',', '.'));
    const x = mmToPt(read(inputs.X)) + infoRaw.x;
    const top = infoRaw.y + infoRaw.h - mmToPt(read(inputs.Y));
    const width = mmToPt(read(inputs.B));
    const height = mmToPt(read(inputs.H));
    if (![x, top, width, height].every(isFinite) || width <= 0 || height <= 0) {
      this.updatePanel();
      return;
    }
    const scaleX = sel.blocks.length ? 1 : width / (selBox[2] - selBox[0]);
    const scaleY = sel.blocks.length ? 1 : height / (selBox[3] - selBox[1]);
    const left = x;
    const bottom = top - (sel.blocks.length ? selBox[3] - selBox[1] : height);
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

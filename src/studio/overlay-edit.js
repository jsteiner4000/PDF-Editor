/**
 * Freie Bilder und QR-Codes im Editor: einfügen (auf der Seite in der Mitte der Ansicht), wählen,
 * verschieben, an der Ecke in der Größe ziehen. Ergänzt die Klasse Studio (Object.assign).
 */
import { $, $$ } from '../ui/dom.js';
import { pickFiles, toast, withBusy } from '../ui/dialogs.js';
import { showMenu } from '../ui/menu.js';
import { uid } from './model.js';
import { QR_CAPTION_H, serialSources } from './overlays.js';
import { readImage } from './studio.js';

export const overlayEdit = {
  /** Menü „Bild / QR-Code“ im Werkzeugband. */
  insertMenu(anchor) {
    showMenu(
      [
        { label: 'Bild einfügen …', icon: 'image', run: () => this.addOverlayImage() },
        { label: 'QR-Code einfügen', icon: 'fitp', run: () => this.addOverlayQr() },
      ],
      anchor,
    );
  },

  /** Seite für neue Elemente: im gewählten Abschnitt die Seite nahe der Mitte der Ansicht, sonst die Seite in der Mitte. */
  targetPage() {
    if (!this.doc || !this.doc.pages.length) return null;
    const id = this.sel.section || (this.sel.kind === 'section' ? this.sel.id : null);
    const chosen = id && this.doc.pages.some((p) => p.section === id) ? id : null;
    const scroll = $('#sdScroll').getBoundingClientRect();
    const mid = scroll.top + scroll.height / 2;
    let best = null;
    let bestDist = Infinity;
    $$('.sd-page', $('#sdPages')).forEach((el) => {
      const page = this.doc.pages[+el.dataset.index];
      if (!page || (chosen && page.section !== chosen)) return;
      const r = el.getBoundingClientRect();
      const dist = mid < r.top ? r.top - mid : mid > r.bottom ? mid - r.bottom : 0;
      if (dist < bestDist) {
        bestDist = dist;
        best = page;
      }
    });
    const page = best || this.doc.pages[0];
    return { section: page.section, page: page.secPage || 0, w: page.w, h: page.h };
  },

  /** Element mittig auf die Zielseite legen und wählen. */
  placeOverlay(o, label) {
    const t = this.targetPage();
    if (!t) return toast('Zuerst einen Abschnitt anlegen.', 'warn', 3000);
    Object.assign(o, { id: uid('o'), section: t.section, page: t.page, x: (t.w - o.w) / 2, y: (t.h - o.h) / 2 });
    this.change(label, (p) => (p.overlays ||= []).push(o));
    this.select({ kind: 'overlay', id: o.id, section: o.section });
  },

  async addOverlayImage(file = null) {
    file ||= await pickFiles('image/png,image/jpeg,image/webp,image/svg+xml');
    if (!file) return;
    try {
      const image = await withBusy(() => readImage(file, { max: 1600, jpeg: file.type === 'image/jpeg' }));
      const id = uid('img');
      this.project.images[id] = image;
      // höchstens 200 pt breit bzw. hoch, Seitenverhältnis wie das Bild
      const k = Math.min(200 / image.w, 200 / image.h, 1);
      this.placeOverlay({ kind: 'image', image: id, w: Math.round(image.w * k), h: Math.round(image.h * k) }, 'Bild eingefügt');
    } catch {
      toast('Das Bild konnte nicht gelesen werden.', 'err', 5000);
    }
  },

  /** Anderes Bild: Breite bleibt, Höhe nach dem neuen Seitenverhältnis. */
  async replaceOverlayImage(o) {
    const file = await pickFiles('image/png,image/jpeg,image/webp,image/svg+xml');
    if (!file) return;
    try {
      const image = await withBusy(() => readImage(file, { max: 1600, jpeg: file.type === 'image/jpeg' }));
      const id = uid('img');
      this.project.images[id] = image;
      this.change('Bild ersetzt', () => Object.assign(o, { image: id, h: Math.round((o.w * image.h) / image.w) }), { inspector: true });
    } catch {
      toast('Das Bild konnte nicht gelesen werden.', 'err', 5000);
    }
  },

  /** QR-Code: mit dem ersten Gerät mit Seriennummer verknüpft (rechts änderbar). */
  addOverlayQr() {
    const first = serialSources(this.project)[0];
    this.placeOverlay({ kind: 'qr', src: first ? first.id : null, text: '', caption: true, w: 90, h: 90 + QR_CAPTION_H }, 'QR-Code eingefügt');
    if (!first) toast('Seriennummer rechts eingeben – oder in den Zugangsdaten bei einem Gerät eintragen.', '', 5000);
  },

  overlayById(id) {
    return (this.project.overlays || []).find((o) => o.id === id) || null;
  },

  /** Verschieben ('omove') oder Größe an der Ecke ziehen ('oresize'). */
  startOverlayDrag(ev, hit, mode) {
    const o = this.overlayById(mode === 'oresize' ? this.sel.id : hit.item.id);
    if (!o) return;
    ev.preventDefault();
    hit.el.setPointerCapture(ev.pointerId);
    this.drag = { overlay: true, mode, o, x0: o.x, y0: o.y, w0: o.w, h0: o.h, el: hit.el, startX: ev.clientX, startY: ev.clientY, before: this.snap, moved: false };
    $('#sdScroll').classList.add('dragging');
  },

  overlayDragMove(ev) {
    const d = this.drag;
    if (!d.moved && Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 3) return;
    d.moved = true;
    const dx = (ev.clientX - d.startX) / this.scale;
    const dy = (ev.clientY - d.startY) / this.scale;
    const o = d.o;
    if (d.mode === 'omove') {
      o.x = Math.round(d.x0 + dx);
      o.y = Math.round(d.y0 + dy);
    } else {
      // Seitenverhältnis bleibt (QR-Code: quadratisch plus Beschriftung)
      const cap = o.kind === 'qr' && o.caption ? QR_CAPTION_H : 0;
      const w = Math.max(24, Math.min(800, Math.round(d.w0 + Math.max(dx, dy))));
      o.w = w;
      o.h = o.kind === 'qr' ? w + cap : Math.round((w * d.h0) / d.w0);
    }
    this.schedule();
  },
};

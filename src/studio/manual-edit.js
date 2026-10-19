/**
 * Bedienungsanleitung bearbeiten: Produktfoto und Bilder der Karten wählen, Positionen auf
 * Abbildungen setzen (Klick auf die Stelle im Bild) und ziehen (Punkt bzw. Kreis). Ergänzt die
 * Klasse Studio (Object.assign).
 */
import { $ } from '../ui/dom.js';
import { pickFiles, toast, withBusy } from '../ui/dialogs.js';
import { PAGE } from './svg.js';
import { newCard, newMark, uid } from './model.js';
import { markNumbers } from './manual.js';
import { readImage } from './studio.js';

export const manualEdit = {
  /** Bild wählen und in `target[key]` eintragen (ein Schritt für Rückgängig). */
  async pickImageInto(target, key, label, file = null) {
    file ||= await pickFiles('image/png,image/jpeg,image/webp');
    if (!file) return;
    try {
      const image = await withBusy(() => readImage(file, { max: 2000, jpeg: file.type !== 'image/png' }));
      const id = uid('img');
      this.project.images[id] = image;
      this.change(label, () => (target[key] = id), { inspector: true });
    } catch {
      toast('Das Bild konnte nicht gelesen werden.', 'err', 5000);
    }
  },

  pickCover(file = null) {
    return this.pickImageInto(this.project.manual, 'cover', 'Produktfoto gesetzt', file);
  },

  pickCardImage(card, file = null) {
    return this.pickImageInto(card, 'image', 'Foto gesetzt', file);
  },

  addCard(block) {
    const card = newCard();
    this.change('Schritt hinzugefügt', () => block.items.push(card), { inspector: true });
  },

  /** Bereich „Bedienungsanleitung“ (Deckblatt, Kapitelkopf …) ein- oder ausschalten. */
  setDesign(design) {
    this.change(design === 'manual' ? 'Gestaltung: Bedienungsanleitung' : 'Gestaltung: Klassisch', (p) => (p.design = design), { inspector: true });
  },

  /* ---------- Positionen auf Abbildungen ---------- */

  /** Nummern aller Positionen (fortlaufend über das Dokument). */
  markNumbers() {
    return markNumbers(this.project);
  },

  /** Abbildung eines Bausteins (über alle Kapitel-Abschnitte). */
  findBlock(id) {
    for (const s of this.project.sections) if (s.type === 'chapters') for (const b of s.blocks) if (b.id === id) return { s, b };
    return null;
  },

  /** Positionen setzen: jeder Klick auf das Bild setzt eine; Esc beendet. */
  armMarks(blockId) {
    this.arm('tool:mark:' + blockId);
  },

  /** Klick im Bild beim Setzen von Positionen. Liefert true, wenn er verarbeitet wurde. */
  markDown(ev, hit) {
    const id = this.armed.split(':')[2];
    const item = hit.item;
    if (!item || item.kind !== 'figimg' || item.block !== id) return false;
    const found = this.findBlock(id);
    if (!found) return false;
    ev.preventDefault();
    const [ix, iy, iw, ih] = item.img;
    const x = Math.max(0, Math.min(1, (hit.x - ix) / iw));
    const y = Math.max(0, Math.min(1, (hit.y - iy) / ih));
    const mark = newMark(x, y);
    this.change('Position gesetzt', () => found.b.marks.push(mark));
    this.select({ kind: 'block', id, section: found.s.id });
    this.updateArmHint();
    // Bezeichnung gleich eintippen können
    setTimeout(() => {
      const input = document.querySelector(`[data-f^="bi:name:de:${mark.id}"], [data-f^="bi:name:en:${mark.id}"]`);
      if (input) input.focus();
    }, 0);
    return true;
  },

  /** Punkt oder Kreis einer Position ziehen. */
  startMarkDrag(ev, hit) {
    const found = this.findBlock(hit.item.block);
    const mark = found && found.b.marks.find((m) => m.id === hit.item.id);
    if (!mark) return;
    this.select({ kind: 'block', id: found.b.id, section: found.s.id });
    ev.preventDefault();
    hit.el.setPointerCapture(ev.pointerId);
    this.drag = { manual: true, mark, part: hit.item.part, img: hit.item.img, el: hit.el, startX: ev.clientX, startY: ev.clientY, before: this.snap, moved: false, mode: 'mark' };
    $('#sdScroll').classList.add('dragging');
  },

  markDragMove(ev) {
    const d = this.drag;
    if (!d.moved && Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 3) return;
    d.moved = true;
    const r = d.el.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * PAGE.w;
    const py = ((ev.clientY - r.top) / r.height) * PAGE.h;
    const [ix, iy, iw, ih] = d.img;
    const fx = (px - ix) / iw;
    const fy = (py - iy) / ih;
    if (d.part === 'pt') {
      d.mark.x = Math.max(0, Math.min(1, fx));
      d.mark.y = Math.max(0, Math.min(1, fy));
    } else {
      // Kreis: Höhe frei, Seite nach der Zeigerposition
      d.mark.ly = Math.max(-0.2, Math.min(1.2, fy));
      d.mark.side = fx < 0.5 ? 'l' : 'r';
    }
    this.schedule();
  },
};

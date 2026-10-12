/**
 * Formularfelder auf der Seite ausfüllen: über jedem Widget liegt ein Eingabeelement (Text,
 * Kontrollkästchen, Optionsfeld, Auswahlliste). Im Ruhezustand ist es durchsichtig – sichtbar ist
 * das Erscheinungsbild aus der PDF, nur leicht getönt –, beim Bearbeiten deckt es das Feld ab.
 *
 * Übernommen wird ein Text beim Verlassen des Felds (Tab, Klick daneben) oder mit Enter
 * (einzeilig); Esc verwirft die Eingabe. Jede Übernahme ist ein Schritt für Rückgängig.
 */
import { toast } from './dialogs.js';

export class FormLayer {
  constructor(app) {
    this.app = app;
    /** Laufende Übernahmen (Speichern wartet darauf). */
    this.pending = Promise.resolve();
  }
  get session() {
    return this.app.session;
  }
  /** Baut die Felder einer sichtbaren Seite auf bzw. gleicht sie ab (Fokus bleibt erhalten). */
  draw(pv) {
    if (!this.session || pv.index < 0) return;
    // im Werkzeug „Formularfelder“ werden Felder gestaltet, nicht ausgefüllt
    if (this.app.tool === 'formdesign') {
      if (pv.fl) pv.fl.remove();
      pv.fl = null;
      pv.flSig = null;
      return;
    }
    const editing = this.app.tool === 'edit';
    const sig = pv.sig + '@' + pv.scale + '@' + editing;
    if (pv.fl && pv.flSig === sig && pv.fl.isConnected) return;
    const fields = this.session.formFields(pv.index);
    if (!fields.length) {
      if (pv.fl) pv.fl.remove();
      pv.fl = null;
      pv.flSig = sig;
      return;
    }
    if (!pv.fl || !pv.fl.isConnected) {
      pv.fl = document.createElement('div');
      pv.fl.className = 'fl';
      pv.layer.appendChild(pv.fl);
    }
    pv.flSig = sig;
    const existing = new Map([...pv.fl.children].map((el) => [el.dataset.id, el]));
    const order = [];
    for (const entry of fields) {
      let el = existing.get(entry.id);
      existing.delete(entry.id);
      if (!el || el.dataset.type !== entry.type || el.dataset.multi !== String(!!entry.multiline)) {
        if (el) el.remove();
        el = this.create(entry);
      }
      el.entry = entry;
      // schreibgeschützte Felder nur im Bearbeiten-Modus änderbar
      el.locked = entry.readOnly && !editing;
      el.classList.toggle('locked', el.locked);
      el.tabIndex = el.locked ? -1 : 0;
      if ('readOnly' in el && entry.type === 'text') el.readOnly = el.locked;
      if (entry.type === 'choice') el.disabled = el.locked;
      this.place(pv, el, entry);
      if (document.activeElement !== el) this.fill(el, entry);
      order.push(el);
    }
    for (const el of existing.values()) if (document.activeElement !== el) el.remove();
    // DOM-Reihenfolge = Tab-Reihenfolge (Lesereihenfolge der Felder)
    order.forEach((el) => pv.fl.appendChild(el));
  }
  /** Nach Zoom oder Neuaufbau: sichtbare Seiten abgleichen. */
  refresh() {
    for (const pv of this.app.pvs) if (pv.visible || pv.fl) this.draw(pv);
  }
  create(entry) {
    let el;
    if (entry.type === 'text') {
      el = document.createElement(entry.multiline ? 'textarea' : 'input');
      if (!entry.multiline) el.type = 'text';
      el.spellcheck = false;
      el.autocomplete = 'off';
      el.addEventListener('keydown', (ev) => {
        // Tastenkürzel mit Strg (Speichern, Drucken …) gelten weiter für die App
        if (!ev.ctrlKey && !ev.metaKey) ev.stopPropagation();
        if (ev.key === 'Escape') {
          this.fill(el, el.entry);
          el.blur();
        } else if (ev.key === 'Enter' && !entry.multiline) {
          ev.preventDefault();
          this.commit(el, el.value);
        }
      });
      el.addEventListener('blur', () => this.commit(el, el.value));
    } else if (entry.type === 'choice') {
      el = document.createElement('select');
      el.addEventListener('keydown', (ev) => ev.stopPropagation());
      el.addEventListener('change', () => this.commit(el, el.value));
    } else {
      el = document.createElement('button');
      el.type = 'button';
      el.setAttribute('role', entry.type);
      el.addEventListener('click', () => {
        const current = el.entry;
        if (el.locked) return;
        if (current.type === 'radio') {
          if (!current.checked) this.commit(el, true);
        } else this.commit(el, !current.checked);
      });
      el.addEventListener('keydown', (ev) => {
        if (ev.key === ' ' || ev.key === 'Enter') ev.stopPropagation();
      });
    }
    el.addEventListener('click', () => {
      if (el.locked && !this.hinted) {
        this.hinted = true;
        toast('Schreibgeschütztes Formularfeld – zum Ändern „PDF bearbeiten“ wählen.', 'warn', 5000);
      }
    });
    el.className = 'ff ff-' + entry.type;
    el.dataset.id = entry.id;
    el.dataset.type = entry.type;
    el.dataset.multi = String(!!entry.multiline);
    // Klicks und Ziehen in Feldern gehören dem Feld, nicht dem Bearbeiten-Modus darunter
    for (const type of ['pointerdown', 'dblclick', 'contextmenu'])
      el.addEventListener(type, (ev) => ev.stopPropagation());
    return el;
  }
  place(pv, el, entry) {
    const box = pv.boxOf(entry.rect);
    const style = el.style;
    style.left = box.left + 'px';
    style.top = box.top + 'px';
    style.width = box.width + 'px';
    style.height = box.height + 'px';
    if (entry.type === 'text' || entry.type === 'choice') {
      const size =
        entry.fontSize || (entry.multiline ? 10 : Math.min(12, (entry.rect[3] - entry.rect[1] - 4) * 0.72));
      style.fontSize = Math.max(4, size) * pv.scale + 'px';
      style.textAlign = ['left', 'center', 'right'][entry.align] || 'left';
    }
  }
  fill(el, entry) {
    el.title = (entry.name || '') + (entry.readOnly ? ' (schreibgeschützt)' : '');
    el.dataset.name = entry.name || '';
    el.setAttribute('aria-label', entry.name || 'Formularfeld');
    el.classList.remove('pending');
    el.lastCommit = undefined;
    if (entry.type === 'text') {
      el.value = entry.value;
      el.maxLength = entry.maxLen || 524288;
    } else if (entry.type === 'choice') {
      el.innerHTML = '';
      const options = entry.options.some((o) => o.value === entry.value)
        ? entry.options
        : [{ value: entry.value, label: entry.value }, ...entry.options];
      for (const option of options) {
        const node = document.createElement('option');
        node.value = option.value;
        node.textContent = option.label;
        el.appendChild(node);
      }
      el.value = entry.value;
    } else el.setAttribute('aria-checked', String(entry.checked));
  }
  /**
   * Übernimmt ein gerade bearbeitetes Textfeld und wartet auf alle laufenden Übernahmen – vor
   * dem Speichern, Drucken und der Rückfrage beim Schließen.
   */
  async flush() {
    const el = document.activeElement;
    if (el && el.entry && el.classList.contains('ff') && /^(INPUT|TEXTAREA)$/.test(el.tagName))
      this.commit(el, el.value);
    await this.pending;
  }
  commit(el, value) {
    const run = this._commit(el, value);
    this.pending = Promise.all([this.pending, run]).catch(() => {});
    return run;
  }
  async _commit(el, value) {
    const entry = el.entry;
    if (!entry || !this.session || el.locked) return;
    if (
      (entry.type === 'text' || entry.type === 'choice') &&
      (value === entry.value || value === el.lastCommit)
    )
      return;
    el.lastCommit = value;
    // bis zum Neuzeichnen zeigt das Feld selbst den neuen Wert (die Seite zeigt noch den alten)
    if (entry.type === 'text' || entry.type === 'choice') el.classList.add('pending');
    else el.setAttribute('aria-checked', String(entry.type === 'radio' ? true : !!value));
    const changed = await this.session.setFormValue(entry, value);
    if (changed) await this.app.sync();
    else this.fill(el, entry);
  }
}

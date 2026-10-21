/**
 * Werkzeug „Formularfelder“: Textfelder und Kontrollkästchen anlegen, vorhandene Felder
 * auswählen, verschieben, in der Größe ändern, löschen und ihre Eigenschaften (Name,
 * Schriftgröße, Ausrichtung, mehrzeilig, schreibgeschützt, Rahmen) bearbeiten.
 *
 * Felder erscheinen als Rahmen über der Seite (ausgefüllt wird außerhalb dieses Werkzeugs).
 * Jede Änderung ist ein Schritt für Rückgängig (siehe PdfSession.formEdit).
 */
import { icon } from './icons.js';
import { $, htmlToElement, escapeHtml } from './dom.js';
import { toast } from './dialogs.js';
import { FIELD_FONTS, fieldFont } from '../pdf/form-fields.js';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const TYPE_LABEL = {
  text: 'Textfeld',
  checkbox: 'Kontrollkästchen',
  radio: 'Optionsfeld',
  choice: 'Auswahlliste',
};
/** Standardgröße neuer Felder beim einfachen Klick (Punkte). */
const DEFAULT_SIZE = { text: [160, 22], checkbox: [14, 14] };
const MIN_SIZE = 6;
/** Im Werkzeug erscheinen auch versteckte Felder (blass), damit man sie wieder einblenden kann. */
const ALL = { all: true };
const FONT_SIZES = [0, 8, 9, 10, 11, 12, 14, 16, 18, 24];

export class FormDesign {
  constructor(app) {
    this.app = app;
    this.active = false;
    /** Gewähltes Werkzeug zum Anlegen: 'text' | 'checkbox' | null */
    this.armed = null;
    /** Auswahl: { id, key } (Widget-Referenz, Seite) */
    this.sel = null;
  }
  get session() {
    return this.app.session;
  }
  enter() {
    this.active = true;
    if (!this.wired) this.wire();
    $('#pages').classList.add('mode-fd');
    const ctx = $('#ctx');
    ctx.classList.remove('hidden');
    ctx.innerHTML = `<button class="btn" id="fdText">${icon('field', 's')}Textfeld</button>
      <button class="btn" id="fdCheck">${icon('checkbox', 's')}Kontrollkästchen</button>
      <span class="chip" id="fdHint"></span>
      <div class="grow"></div>
      <button class="btn outline" id="fdDone">${icon('check', 's')}Fertig</button>`;
    $('#fdText').addEventListener('click', () => this.arm(this.armed === 'text' ? null : 'text'));
    $('#fdCheck').addEventListener('click', () => this.arm(this.armed === 'checkbox' ? null : 'checkbox'));
    $('#fdDone').addEventListener('click', () => this.app.setTool(null));
    this.arm(null);
    this.refresh();
  }
  leave() {
    this.active = false;
    this.armed = null;
    this.sel = null;
    if (this.gesture) this.gesture.abort();
    $('#pages').classList.remove('mode-fd', 'fd-armed');
    for (const pv of this.app.pvs) if (pv.fd) (pv.fd.remove(), (pv.fd = null));
  }
  /** Werkzeug zum Anlegen wählen (null = Auswählen/Verschieben). */
  arm(type) {
    this.armed = type;
    $('#pages').classList.toggle('fd-armed', !!type);
    $('#fdText')?.classList.toggle('on', type === 'text');
    $('#fdCheck')?.classList.toggle('on', type === 'checkbox');
    const hint = $('#fdHint');
    if (hint)
      hint.textContent = type
        ? `Auf die Seite klicken oder einen Rahmen aufziehen · Esc: abbrechen`
        : 'Klick: auswählen · Ziehen: verschieben · Entf: löschen';
    this.updatePanel();
  }
  refresh() {
    if (!this.active) return;
    for (const pv of this.app.pvs) if (pv.visible || pv.fd) this.draw(pv);
    this.updatePanel();
  }
  layoutChanged() {
    if (this.active) for (const pv of this.app.pvs) if (pv.visible || pv.fd) this.draw(pv);
  }
  afterSync() {
    if (!this.active) return;
    // Auswahl verwerfen, wenn das Feld nicht mehr existiert (z. B. nach Rückgängig)
    if (this.sel && !this.selected()) this.sel = null;
    this.refresh();
  }
  draw(pv) {
    if (!this.active || !this.session || pv.index < 0) return;
    if (!pv.fd || !pv.fd.isConnected) {
      pv.fd = document.createElement('div');
      pv.fd.className = 'fd';
      pv.layer.appendChild(pv.fd);
    }
    const frag = document.createDocumentFragment();
    for (const entry of this.session.formFields(pv.index, ALL)) {
      const box = pv.boxOf(entry.rect);
      const el = htmlToElement(
        `<div class="fdb${entry.visibility === 'hidden' || entry.visibility === 'hiddenPrint' ? ' hid' : ''}" data-id="${escapeHtml(entry.id)}"><span class="fdn">${escapeHtml(entry.name || TYPE_LABEL[entry.type])}</span></div>`,
      );
      Object.assign(el.style, {
        left: box.left + 'px',
        top: box.top + 'px',
        width: box.width + 'px',
        height: box.height + 'px',
      });
      if (this.sel && this.sel.key === pv.key && this.sel.id === entry.id) {
        el.classList.add('on');
        // kleine Felder (z. B. Kästchen): nur Eckgriffe, sonst verdecken die Griffe das Feld
        const small = box.width < 36 || box.height < 36;
        for (const h of HANDLES)
          if (!small || h.length === 2)
            el.appendChild(htmlToElement(`<div class="fdh" data-h="${h}"></div>`));
      }
      frag.appendChild(el);
    }
    pv.fd.replaceChildren(frag);
  }
  /** Eintrag des gewählten Felds (frisch gelesen) samt Seitenansicht oder null. */
  selected() {
    if (!this.sel || !this.session) return null;
    const pv = this.app.pvByKey.get(this.sel.key);
    if (!pv || pv.index < 0) return null;
    const entry = this.session.formFields(pv.index, ALL).find((e) => e.id === this.sel.id);
    return entry ? { pv, entry } : null;
  }
  select(pv, id) {
    this.sel = id ? { key: pv.key, id } : null;
    for (const view of this.app.pvs) if (view.fd) this.draw(view);
    this.updatePanel();
  }
  wire() {
    this.wired = true;
    window.addEventListener('pointerdown', () => (this.pointerDown = true), true);
    window.addEventListener('pointerup', () => (this.pointerDown = false), true);
    const pages = $('#pages');
    pages.addEventListener('pointerdown', (ev) => {
      if (!this.active || ev.button !== 0 || !this.session) return;
      const pageEl = ev.target.closest && ev.target.closest('.page');
      const pv = pageEl && this.app.pvByKey.get(pageEl.dataset.key);
      if (!pv) return;
      const handle = ev.target.closest('.fdh');
      const boxEl = ev.target.closest('.fdb');
      if (handle && this.sel) this.startGesture(ev, pv, 'resize', handle.dataset.h);
      else if (boxEl && !this.armed) {
        if (!this.sel || this.sel.id !== boxEl.dataset.id) this.select(pv, boxEl.dataset.id);
        this.startGesture(ev, pv, 'move');
      } else if (this.armed) {
        if (pv.rot) {
          toast('Auf gedrehten Seiten lassen sich noch keine Felder anlegen.', 'warn', 5000);
          this.arm(null);
          return;
        }
        this.startGesture(ev, pv, 'create');
      } else this.select(pv, null);
    });
  }
  /**
   * Ziehen: verschieben, Größe ändern oder neues Feld aufziehen. Die Vorschau ändert nur den
   * Rahmen; übernommen wird beim Loslassen (ein Schritt für Rückgängig). Esc bricht ab.
   */
  startGesture(ev, pv, mode, handle = null) {
    ev.preventDefault();
    // preventDefault verhindert den Fokuswechsel: Eingaben im Seitenpanel selbst abschließen, damit
    // Tastenkürzel (Entf, Pfeiltasten) wieder der Seite gelten
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
    const pages = $('#pages');
    try {
      pages.setPointerCapture(ev.pointerId);
    } catch {}
    const start = pv.clientToLayer(ev.clientX, ev.clientY);
    const sel = mode === 'create' ? null : this.selected();
    if (mode !== 'create' && !sel) return;
    const el = sel && pv.fd.querySelector(`.fdb[data-id="${CSS.escape(sel.entry.id)}"]`);
    const box0 = sel ? pv.boxOf(sel.entry.rect) : null;
    let ghost = null;
    let rect = null; // Ebenen-Rechteck { l, t, r, b }
    let moved = false;
    const controller = new AbortController();
    const stop = () => {
      controller.abort();
      this.gesture = null;
      try {
        pages.releasePointerCapture(ev.pointerId);
      } catch {}
    };
    this.gesture = { abort: () => (stop(), ghost && ghost.remove(), this.draw(pv)) };
    const minPx = MIN_SIZE * pv.scale;
    const onMove = (e) => {
      if ((e.buttons & 1) === 0) return onUp(e);
      const [x, y] = pv.clientToLayer(e.clientX, e.clientY);
      const dx = x - start[0];
      const dy = y - start[1];
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      if (mode === 'create') {
        rect = {
          l: Math.min(start[0], x),
          t: Math.min(start[1], y),
          r: Math.max(start[0], x),
          b: Math.max(start[1], y),
        };
        if (!ghost) ghost = pv.layer.appendChild(htmlToElement('<div class="fd-ghost"></div>'));
        place(ghost, rect);
        return;
      }
      const r0 = { l: box0.left, t: box0.top, r: box0.left + box0.width, b: box0.top + box0.height };
      if (mode === 'move') rect = { l: r0.l + dx, t: r0.t + dy, r: r0.r + dx, b: r0.b + dy };
      else {
        rect = { ...r0 };
        if (handle.includes('w')) rect.l = Math.min(r0.r - minPx, r0.l + dx);
        if (handle.includes('e')) rect.r = Math.max(r0.l + minPx, r0.r + dx);
        if (handle.includes('n')) rect.t = Math.min(r0.b - minPx, r0.t + dy);
        if (handle.includes('s')) rect.b = Math.max(r0.t + minPx, r0.b + dy);
      }
      place(el, rect);
    };
    const onUp = async () => {
      stop();
      if (ghost) ghost.remove();
      if (mode === 'create') {
        const type = this.armed;
        let pdfRect;
        if (rect && rect.r - rect.l >= minPx && rect.b - rect.t >= minPx) pdfRect = this.toPdf(pv, rect);
        else {
          // einfacher Klick: Standardgröße (Textfeld ab dem Klickpunkt, Kästchen mittig darauf)
          const [px, py] = pv.layerToPdf(start[0], start[1]);
          const [w, h] = DEFAULT_SIZE[type];
          pdfRect =
            type === 'checkbox' ? [px - w / 2, py - h / 2, px + w / 2, py + h / 2] : [px, py - h, px + w, py];
        }
        this.arm(null);
        const id = await this.session.addFormField(pv.index, type, this.clamp(pv, pdfRect));
        this.sel = id ? { key: pv.key, id } : null;
        await this.app.sync();
        return;
      }
      if (!moved || !rect) return;
      await this.session.updateFormField(
        sel.entry,
        { rect: this.clamp(pv, this.toPdf(pv, rect)) },
        mode === 'move' ? 'Formularfeld verschoben' : 'Formularfeld: Größe geändert',
      );
      await this.app.sync();
    };
    const place = (node, r) =>
      node &&
      Object.assign(node.style, {
        left: r.l + 'px',
        top: r.t + 'px',
        width: r.r - r.l + 'px',
        height: r.b - r.t + 'px',
      });
    const opts = { signal: controller.signal };
    window.addEventListener('pointermove', onMove, opts);
    window.addEventListener('pointerup', onUp, opts);
    window.addEventListener('pointercancel', () => this.gesture && this.gesture.abort(), opts);
    window.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        this.gesture && this.gesture.abort();
      },
      { ...opts, capture: true },
    );
  }
  /** Ebenen-Rechteck → PDF-Rechteck [x1, y1, x2, y2]. */
  toPdf(pv, r) {
    const [x1, y2] = pv.layerToPdf(r.l, r.t);
    const [x2, y1] = pv.layerToPdf(r.r, r.b);
    return [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];
  }
  /** Hält ein Rechteck auf der sichtbaren Seite (Größe bleibt, soweit sie passt). */
  clamp(pv, rect) {
    const { x, y, w, h } = pv.infoRaw;
    let [x1, y1, x2, y2] = rect;
    const dw = Math.min(x2 - x1, w);
    const dh = Math.min(y2 - y1, h);
    x1 = Math.max(x, Math.min(x1, x + w - dw));
    y1 = Math.max(y, Math.min(y1, y + h - dh));
    return [x1, y1, x1 + dw, y1 + dh];
  }
  onKey(ev) {
    const key = ev.key;
    if (key === 'Escape') {
      if (this.armed) return (this.arm(null), true);
      if (this.sel) return (this.select(null, null), true);
      return false;
    }
    const current = this.selected();
    if (!current) return false;
    if (key === 'Delete' || key === 'Backspace') {
      ev.preventDefault();
      this.remove(current.entry);
      return true;
    }
    const step = ev.shiftKey ? 10 : 1;
    const screen = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[key];
    if (!screen) return false;
    ev.preventDefault();
    // Bildschirmrichtung → Seitenrichtung (auch bei gedrehten Seiten); y der Seite zeigt nach oben
    const [lx, ly] = current.pv.clientDeltaToLayer(screen[0], screen[1]);
    const delta = [lx, -ly];
    // nacheinander: jeder Schritt geht vom Ergebnis des vorigen aus (gehaltene Taste)
    this.nudging = (this.nudging || Promise.resolve()).then(async () => {
      const fresh = this.selected();
      if (!fresh) return;
      const [x1, y1, x2, y2] = fresh.entry.rect;
      const rect = this.clamp(fresh.pv, [x1 + delta[0], y1 + delta[1], x2 + delta[0], y2 + delta[1]]);
      const changes = await this.session.updateFormField(fresh.entry, { rect }, 'Formularfeld verschoben');
      if (changes.length) await this.app.sync();
    });
    return true;
  }
  async remove(entry) {
    this.sel = null;
    await this.session.deleteFormField(entry);
    await this.app.sync();
  }
  async change(entry, props, label) {
    const changes = await this.session.updateFormField(entry, props, label);
    if (changes.length) await this.app.sync();
  }
  updatePanel() {
    if (!this.active || this.app.tool !== 'formdesign') return;
    // nicht neu aufbauen, während im Panel getippt wird (z. B. Name)
    const focused = document.activeElement;
    if (
      focused &&
      $('#lpBody').contains(focused) &&
      // Texteingaben und Auswahllisten (eine offene Liste ginge sonst verloren), nicht Schalter
      (focused.tagName === 'SELECT' ||
        (focused.tagName === 'INPUT' && !['checkbox', 'radio', 'color'].includes(focused.type)))
    ) {
      if (!this.panelDeferred) {
        this.panelDeferred = true;
        // erst nach dem laufenden Klick neu aufbauen – sonst ginge der Klick ins Leere
        focused.addEventListener(
          'blur',
          () => {
            this.panelDeferred = false;
            const rebuild = () => setTimeout(() => this.updatePanel(), 0);
            if (this.pointerDown)
              window.addEventListener('pointerup', rebuild, { once: true, capture: true });
            else rebuild();
          },
          { once: true },
        );
      }
      return;
    }
    // Textfeld und Kontrollkästchen anlegen: Befehlsleiste oben
    const body = this.app.panel('Formularfelder');
    const current = this.selected();
    if (!current) {
      body.appendChild(
        htmlToElement(
          `<div class="sec"><h4>Felder</h4><p class="hint">Klicken Sie auf ein Feld, um es auszuwählen. Ziehen verschiebt es, die Griffe ändern die Größe, <kbd>Entf</kbd> löscht es. Pfeiltasten verschieben in kleinen Schritten.</p><p class="hint">Ausgefüllt werden Felder außerhalb dieses Werkzeugs direkt auf der Seite.</p></div>`,
        ),
      );
      return;
    }
    this.propertiesPanel(body, current.entry);
  }
  /**
   * Eigenschaften des gewählten Felds – gegliedert wie der Eigenschaften-Dialog in Acrobat:
   * Allgemein, Darstellung, Optionen (Aktionen, Format, Prüfen und Berechnen beruhen in Acrobat
   * auf JavaScript, das PlantPDF bewusst nicht ausführt).
   */
  propertiesPanel(body, entry) {
    const isText = entry.type === 'text';
    const hasText = isText || entry.type === 'choice';
    // Darstellung nur, wo PlantPDF das Aussehen neu zeichnet: Text, Auswahl, eigene Kontrollkästchen
    const canDraw = hasText || (entry.type === 'checkbox' && entry.ownAppearance);
    const section = (title) => {
      const sec = htmlToElement(
        `<div class="sec"><h4>${escapeHtml(title)}</h4><div class="fd-grid"></div></div>`,
      );
      body.appendChild(sec);
      return sec.querySelector('.fd-grid');
    };
    const row = (grid, label, control) => {
      grid.append(htmlToElement(`<label>${escapeHtml(label)}</label>`), control);
      return control;
    };
    const textInput = (value, onCommit, aria) => {
      const input = htmlToElement(`<input class="fld" spellcheck="false" aria-label="${escapeHtml(aria)}">`);
      input.value = value;
      input.addEventListener('keydown', (ev) => {
        ev.stopPropagation();
        if (ev.key === 'Enter') input.blur();
        if (ev.key === 'Escape') ((input.value = value), input.blur());
      });
      input.addEventListener('change', () => onCommit(input.value, input));
      return input;
    };
    const select = (options, value, onChange, aria) => {
      const el = htmlToElement(`<select class="fld" aria-label="${escapeHtml(aria)}"></select>`);
      for (const [v, label] of options) {
        const option = document.createElement('option');
        option.value = String(v);
        option.textContent = label;
        el.appendChild(option);
      }
      el.value = String(value);
      el.addEventListener('change', () => onChange(el.value));
      return el;
    };
    const check = (grid, label, checked, onChange, disabled = false) => {
      const el = htmlToElement(
        `<label class="fd-check"><input type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''}> <span>${escapeHtml(label)}</span></label>`,
      );
      el.querySelector('input').addEventListener('change', (ev) => onChange(ev.target.checked));
      grid.appendChild(el);
      return el;
    };
    /** Farbe mit „aus“-Schalter (Rahmen, Füllung) oder ohne (Textfarbe). */
    const color = (value, onChange, aria, optional = true) => {
      const wrap = htmlToElement('<div class="fd-color"></div>');
      const picker = htmlToElement(`<input type="color" aria-label="${escapeHtml(aria)}">`);
      picker.value = toHex(value || [0.6, 0.6, 0.6]);
      picker.addEventListener('change', () => onChange(fromHex(picker.value)));
      if (optional) {
        // Schalter: Farbe verwenden (aus = keine Farbe)
        const toggle = htmlToElement(
          `<input type="checkbox" class="fd-toggle" ${value ? 'checked' : ''} title="${escapeHtml(aria)} verwenden" aria-label="${escapeHtml(aria)} verwenden">`,
        );
        picker.disabled = !value;
        toggle.addEventListener('change', () => onChange(toggle.checked ? fromHex(picker.value) : null));
        wrap.append(toggle, picker);
        if (!value) wrap.appendChild(htmlToElement('<span class="hint">Keine</span>'));
      } else wrap.append(picker);
      return wrap;
    };
    const set = (props, label) => this.change(entry, props, label);

    // ---------- Allgemein ----------
    const general = section(TYPE_LABEL[entry.type]);
    // bearbeitet wird der eigene Teil des Namens; bei verschachtelten Feldern („Formular.Seite1.Name“)
    // bleibt der vordere Teil erhalten
    const prefix = entry.name.slice(0, entry.name.length - entry.partialName.length);
    const name = row(
      general,
      'Name',
      textInput(
        entry.partialName,
        (raw, input) => {
          const value = raw.trim();
          if (!value || value.includes('.')) {
            toast('Der Name darf nicht leer sein und keinen Punkt enthalten.', 'warn');
            input.value = entry.partialName;
            return;
          }
          const taken = this.app.pvs.some(
            (pv) =>
              pv.index >= 0 &&
              this.session
                .formFields(pv.index, ALL)
                .some((e) => e.name === prefix + value && e.field !== entry.field),
          );
          if (taken) {
            toast(
              `Es gibt schon ein Feld „${value}“ – Felder mit gleichem Namen teilen sich ihren Wert.`,
              'warn',
              5000,
            );
            input.value = entry.partialName;
            return;
          }
          set({ name: value }, 'Formularfeld umbenannt');
        },
        'Feldname',
      ),
    );
    if (prefix) name.title = `Vollständiger Name: ${entry.name}`;
    row(
      general,
      'QuickInfo',
      textInput(entry.tooltip, (v) => set({ tooltip: v.trim() }, 'QuickInfo geändert'), 'QuickInfo'),
    );
    row(
      general,
      'Sichtbarkeit',
      select(
        [
          ['visible', 'Sichtbar'],
          ['hidden', 'Ausgeblendet'],
          ['noPrint', 'Sichtbar, nicht drucken'],
          ['hiddenPrint', 'Ausgeblendet, aber drucken'],
        ],
        entry.visibility,
        (v) => set({ visibility: v }, 'Sichtbarkeit geändert'),
        'Sichtbarkeit',
      ),
    );
    if (hasText)
      row(
        general,
        'Drehung',
        select(
          [0, 90, 180, 270].map((d) => [d, `${d}°`]),
          entry.rotation,
          (v) => set({ rotation: Number(v) }, 'Drehung geändert'),
          'Drehung',
        ),
      );
    check(general, 'Schreibgeschützt', entry.readOnly, (on) =>
      set({ readOnly: on }, 'Schreibschutz geändert'),
    );
    check(general, 'Erforderlich', entry.required, (on) => set({ required: on }, 'Pflichtfeld geändert'));

    // ---------- Darstellung ----------
    if (canDraw) {
      const look = section('Darstellung');
      const l = entry.look || {};
      row(
        look,
        'Rahmenfarbe',
        color(l.border, (c) => set({ borderColor: c }, 'Rahmenfarbe geändert'), 'Rahmenfarbe'),
      );
      row(
        look,
        'Füllfarbe',
        color(l.background, (c) => set({ fillColor: c }, 'Füllfarbe geändert'), 'Füllfarbe'),
      );
      row(
        look,
        'Linienstärke',
        select(
          [
            [1, 'Dünn'],
            [2, 'Mittel'],
            [3, 'Dick'],
          ],
          Math.min(3, Math.max(1, Math.round(l.width || 1))),
          (v) => set({ borderWidth: Number(v) }, 'Linienstärke geändert'),
          'Linienstärke',
        ),
      );
      row(
        look,
        'Linienart',
        select(
          [
            ['S', 'Durchgezogen'],
            ['D', 'Gestrichelt'],
            ['B', 'Abgeschrägt'],
            ['I', 'Eingelassen'],
            ['U', 'Unterstrichen'],
          ],
          l.style || 'S',
          (v) => set({ borderStyle: v }, 'Linienart geändert'),
          'Linienart',
        ),
      );
      if (hasText) {
        const known = fieldFont(entry.font);
        const fonts = FIELD_FONTS.map((f) => [f.res, f.label]);
        if (!known) fonts.unshift(['', `${entry.font || 'Unbekannt'} (aus dem Dokument)`]);
        row(
          look,
          'Schriftart',
          select(
            fonts,
            known ? known.res : '',
            (v) => v && set({ font: v }, 'Schriftart geändert'),
            'Schriftart',
          ),
        );
        const sizes = FONT_SIZES.includes(entry.fontSize)
          ? FONT_SIZES
          : [...FONT_SIZES, entry.fontSize].sort((a, b) => a - b);
        row(
          look,
          'Schriftgröße',
          select(
            sizes.map((v) => [v, v ? `${String(v).replace('.', ',')} pt` : 'Automatisch']),
            entry.fontSize,
            (v) => set({ fontSize: Number(v) }, 'Schriftgröße geändert'),
            'Schriftgröße',
          ),
        );
        row(
          look,
          'Textfarbe',
          color(entry.color, (c) => set({ textColor: c }, 'Textfarbe geändert'), 'Textfarbe', false),
        );
      }
    }

    // ---------- Optionen ----------
    if (hasText) {
      const options = section('Optionen');
      const align = htmlToElement(
        `<div class="seg">${[
          [0, 'al', 'Linksbündig'],
          [1, 'ac', 'Zentriert'],
          [2, 'ar', 'Rechtsbündig'],
        ]
          .map(
            ([q, ic, t]) =>
              `<button data-q="${q}" title="${t}" class="${entry.align === q ? 'on' : ''}">${icon(ic, 's')}</button>`,
          )
          .join('')}</div>`,
      );
      for (const btn of align.children)
        btn.addEventListener('click', () => set({ align: Number(btn.dataset.q) }, 'Ausrichtung geändert'));
      row(options, 'Ausrichtung', align);
      if (isText) {
        row(
          options,
          'Standardwert',
          textInput(
            entry.defaultValue,
            (v) => set({ defaultValue: v }, 'Standardwert geändert'),
            'Standardwert',
          ),
        );
        check(
          options,
          'Mehrzeilig',
          entry.multiline,
          (on) => set({ multiline: on }, 'Mehrzeilig geändert'),
          entry.comb || entry.password,
        );
        check(options, 'Lange Texte scrollen', !entry.doNotScroll, (on) =>
          set({ doNotScroll: !on }, 'Scrollen geändert'),
        );
        check(options, 'Rechtschreibprüfung', !entry.doNotSpellCheck, (on) =>
          set({ doNotSpellCheck: !on }, 'Rechtschreibprüfung geändert'),
        );
        check(
          options,
          'Kennwort (verdeckte Eingabe)',
          entry.password,
          (on) => set({ password: on }, 'Kennwort geändert'),
          entry.comb || entry.multiline,
        );
        // Zeichen begrenzen: Schalter + Anzahl
        const limit = htmlToElement('<div class="fd-color"></div>');
        const limitOn = htmlToElement(
          `<input type="checkbox" class="fd-toggle" ${entry.maxLen ? 'checked' : ''} aria-label="Zeichenzahl begrenzen">`,
        );
        const count = htmlToElement(
          '<input class="fld num" type="number" min="1" max="9999" aria-label="Höchstens Zeichen">',
        );
        count.value = entry.maxLen || 10;
        count.disabled = !entry.maxLen;
        count.addEventListener('keydown', (ev) => (ev.stopPropagation(), ev.key === 'Enter' && count.blur()));
        count.addEventListener('change', () => {
          const n = Math.max(1, Math.min(9999, Math.round(Number(count.value)) || 1));
          set({ maxLen: n }, 'Zeichenbegrenzung geändert');
        });
        limitOn.addEventListener('change', () =>
          set(
            limitOn.checked ? { maxLen: Math.max(1, Number(count.value) || 10) } : { maxLen: 0, comb: false },
            'Zeichenbegrenzung geändert',
          ),
        );
        limit.append(limitOn, count, htmlToElement('<span class="hint">Zeichen</span>'));
        row(options, 'Höchstens', limit);
        check(options, 'Kammfeld (ein Kästchen je Zeichen)', entry.comb, (on) =>
          set({ comb: on }, 'Kammfeld geändert'),
        );
      }
    }
    const del = htmlToElement(
      `<button class="btn outline" style="width:100%;justify-content:center;margin-top:14px">${icon('trash', 's')}Feld löschen</button>`,
    );
    del.addEventListener('click', () => this.remove(entry));
    body.appendChild(del);
    body.appendChild(
      htmlToElement(
        '<p class="hint" style="margin-top:12px">Aktionen, Format, Prüfen und Berechnen arbeiten in Acrobat mit JavaScript. PlantPDF führt aus Sicherheitsgründen kein JavaScript aus und bietet sie daher nicht an.</p>',
      ),
    );
  }
}

/** [r, g, b] (0–1) ↔ #rrggbb */
const toHex = (c) =>
  '#' +
  c
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');
const fromHex = (hex) => [1, 3, 5].map((i) => +(parseInt(hex.slice(i, i + 2), 16) / 255).toFixed(3));

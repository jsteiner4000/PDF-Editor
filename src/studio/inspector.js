/**
 * Eigenschaften (rechts) für das Gewählte: Projekt, Abschnitt, Baugruppe, Anschluss, Hinweis,
 * Steuerung. Texte sind zweisprachig: Je nach Sprache des Dokuments erscheint das deutsche, das
 * englische oder beide Felder.
 *
 * Eingaben werden sofort übernommen (Vorschau läuft mit); schnelles Tippen in einem Feld ist ein
 * Schritt für Rückgängig.
 */
import { icon } from '../ui/icons.js';
import { escapeHtml, htmlToElement } from '../ui/dom.js';
import { FONTS, LANGS, T, langsOf, sectionTitle, tx, uid } from './model.js';
import { sideOf } from './wiring.js';
import { color as safeColor } from './svg.js';

const KIND_TITLE = {
  project: 'Projekt',
  box: 'Baugruppe',
  pin: 'Anschluss',
  hint: 'Hinweis',
  hub: 'Steuerung',
};

export class Inspector {
  constructor(studio, head, body) {
    this.studio = studio;
    this.head = head;
    this.body = body;
  }

  get project() {
    return this.studio.project;
  }

  /** Erstes Eingabefeld fokussieren (nach dem Anlegen, Doppelklick im Plan). */
  focusFirst() {
    const el = this.body.querySelector('input:not([type=checkbox]):not([type=color]), textarea');
    if (el) {
      el.focus();
      if (el.select) el.select();
    }
  }

  render() {
    if (!this.project) return;
    const studio = this.studio;
    const sel = studio.sel;
    const item = studio.selected();
    const active = document.activeElement;
    const keepFocus = active && this.body.contains(active) ? active.dataset.f : null;
    this.body.innerHTML = '';
    this.head.innerHTML = '';
    if (!item) {
      studio.sel = { kind: 'project' };
      return this.render();
    }
    const section = sel.section ? studio.section(sel.section) : sel.kind === 'section' ? item : null;
    // Kopf: Brotkrumen bei Elementen eines Abschnitts
    if (sel.section) {
      const back = htmlToElement(`<button class="btn ic" title="Zurück zum Abschnitt">${icon('back')}</button>`);
      back.addEventListener('click', () => studio.select({ kind: 'section', id: sel.section }));
      this.head.append(back, htmlToElement(`<span class="crumb"><small>${escapeHtml(sectionTitle(section))}</small>${KIND_TITLE[sel.kind]}</span>`));
    } else {
      const title = sel.kind === 'project' ? 'Projekt' : sectionTitle(item);
      this.head.append(htmlToElement(`<span class="crumb">${escapeHtml(title)}</span>`));
    }
    if (sel.kind === 'project') this.projectForm();
    else if (sel.kind === 'section') this.sectionForm(item);
    else if (sel.kind === 'box') this.boxForm(section, item);
    else if (sel.kind === 'pin') this.pinForm(section, item);
    else if (sel.kind === 'hint') this.hintForm(section, item);
    else if (sel.kind === 'hub') this.hubForm(section);
    if (keepFocus) {
      const again = this.body.querySelector(`[data-f="${keepFocus}"]`);
      if (again) again.focus();
    }
  }

  /* ---------- Bausteine ---------- */

  group(title, ...children) {
    const el = htmlToElement(`<section class="sd-grp"><h4>${escapeHtml(title)}</h4></section>`);
    el.append(...children.filter(Boolean));
    this.body.appendChild(el);
    return el;
  }

  field(label, control, hint) {
    const el = htmlToElement(`<label class="sd-f"><span class="sd-l">${escapeHtml(label)}</span></label>`);
    el.append(...[].concat(control));
    if (hint) el.appendChild(htmlToElement(`<span class="sd-hint">${escapeHtml(hint)}</span>`));
    return el;
  }

  input(value, onInput, { multiline = false, placeholder = '', type = 'text', id = '' } = {}) {
    const el = document.createElement(multiline ? 'textarea' : 'input');
    if (!multiline) el.type = type;
    el.className = 'fld';
    el.value = value ?? '';
    el.placeholder = placeholder;
    el.spellcheck = type === 'text';
    el.autocomplete = 'off';
    if (id) el.dataset.f = id;
    if (multiline) el.rows = Math.min(8, Math.max(2, String(value || '').split('\n').length + 1));
    el.addEventListener('input', () => onInput(el.value));
    el.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') el.blur();
      if (ev.key === 'Enter' && !multiline) el.blur();
    });
    return el;
  }

  /** Text-Eigenschaft (einsprachig). */
  text(label, obj, prop, opts = {}) {
    const key = `t:${opts.id || prop}:${this.studio.sel.id || this.studio.sel.kind}`;
    return this.field(
      label,
      this.input(obj[prop], (v) => this.studio.change(opts.undo || label + ' geändert', () => (obj[prop] = v), { key }), {
        ...opts,
        id: key,
      }),
      opts.hint,
    );
  }

  /** Zweisprachige Text-Eigenschaft ({ de, en }); Felder je nach Sprache des Dokuments. */
  bi(label, obj, prop, opts = {}) {
    const langs = langsOf(this.project);
    if (typeof obj[prop] !== 'object' || obj[prop] == null) obj[prop] = T(obj[prop] || '', '');
    const value = obj[prop];
    const controls = langs.map((lang) => {
      const key = `bi:${prop}:${lang}:${opts.id || this.studio.sel.id || this.studio.sel.kind}`;
      const other = lang === 'en' ? value.de : value.en;
      const input = this.input(
        value[lang],
        (v) => this.studio.change(opts.undo || label + ' geändert', () => (value[lang] = v), { key }),
        { multiline: opts.multiline, placeholder: (lang === 'en' && other) || opts.placeholder || '', id: key },
      );
      if (langs.length < 2) return input;
      const wrap = htmlToElement(`<span class="sd-bi" data-lang="${lang.toUpperCase()}"></span>`);
      wrap.appendChild(input);
      return wrap;
    });
    return this.field(label, controls, opts.hint);
  }

  seg(label, options, current, onPick) {
    const el = htmlToElement('<div class="sd-seg" role="radiogroup"></div>');
    for (const [value, text] of options) {
      const b = htmlToElement(
        `<button type="button" role="radio" aria-checked="${value === current}" class="${value === current ? 'on' : ''}">${escapeHtml(text)}</button>`,
      );
      b.addEventListener('click', () => value !== current && onPick(value));
      el.appendChild(b);
    }
    return label ? this.field(label, el) : el;
  }

  select(label, options, current, onPick) {
    const el = document.createElement('select');
    el.className = 'fld';
    for (const [value, text] of options) {
      const o = document.createElement('option');
      o.value = value ?? '';
      o.textContent = text;
      el.appendChild(o);
    }
    el.value = current ?? '';
    el.addEventListener('change', () => onPick(el.value || null));
    return this.field(label, el);
  }

  check(label, checked, onToggle, hint) {
    const el = htmlToElement(
      `<label class="sd-check"><input type="checkbox"${checked ? ' checked' : ''}><span>${escapeHtml(label)}${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</span></label>`,
    );
    el.querySelector('input').addEventListener('change', (ev) => onToggle(ev.target.checked));
    return el;
  }

  /** Farbwahl aus den Leitungsarten (Punkte wie in Office-Farbauswahl). */
  catChips(section, current, onPick, extra = []) {
    const el = htmlToElement('<div class="sd-chips" role="radiogroup"></div>');
    const options = [...section.categories.map((c) => [c.id, c.color, tx(c.name, 'de')]), ...extra];
    for (const [id, col, name] of options) {
      const b = htmlToElement(
        `<button type="button" role="radio" aria-checked="${id === current}" class="${id === current ? 'on' : ''}" title="${escapeHtml(name)}"><i style="background:${safeColor(col)}"></i>${escapeHtml(name)}</button>`,
      );
      b.addEventListener('click', () => onPick(id));
      el.appendChild(b);
    }
    return el;
  }

  rows(items, { empty, render, onOpen }) {
    const el = htmlToElement('<div class="sd-rows"></div>');
    if (!items.length) el.appendChild(htmlToElement(`<div class="sd-empty">${escapeHtml(empty)}</div>`));
    for (const item of items) {
      const row = htmlToElement(`<button type="button" class="sd-row">${render(item)}${icon('right', 's chev')}</button>`);
      row.addEventListener('click', () => onOpen(item));
      el.appendChild(row);
    }
    return el;
  }

  addButton(label, run) {
    const b = htmlToElement(`<button type="button" class="btn sd-add">${icon('plus', 's')}${escapeHtml(label)}</button>`);
    b.addEventListener('click', run);
    return b;
  }

  actions(...buttons) {
    const el = htmlToElement('<div class="sd-acts"></div>');
    for (const [label, iconName, run, danger] of buttons.filter(Boolean)) {
      const b = htmlToElement(`<button type="button" class="btn outline${danger ? ' danger' : ''}">${icon(iconName, 's')}${escapeHtml(label)}</button>`);
      b.addEventListener('click', run);
      el.appendChild(b);
    }
    this.body.appendChild(el);
    return el;
  }

  note(text) {
    return htmlToElement(`<p class="sd-note">${escapeHtml(text)}</p>`);
  }

  /* ---------- Projekt ---------- */

  projectForm() {
    const p = this.project;
    const studio = this.studio;
    this.group(
      'Dokument',
      this.bi('Titel', p, 'title'),
      this.seg('Sprache', LANGS.map((l) => [l.id, l.id === 'de+en' ? 'Beide' : l.label]), p.lang, (v) => studio.setLang(v)),
      this.seg('Schrift', FONTS.map((f) => [f.id, f.label]), p.font, (v) => studio.setFont(v)),
    );
    const logo = p.company.logo && p.images[p.company.logo];
    const logoBox = htmlToElement(
      `<div class="sd-logo${logo ? ' has' : ''}" role="button" tabindex="0" title="Logo hochladen (PNG, JPG oder SVG)">${
        logo ? `<img alt="Firmenlogo" src="${escapeHtml(logo.data)}">` : `${icon('image')}<span>Logo hochladen<small>PNG, JPG oder SVG – oder hierher ziehen</small></span>`
      }</div>`,
    );
    logoBox.addEventListener('click', () => studio.pickLogo());
    logoBox.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        studio.pickLogo();
      }
    });
    logoBox.addEventListener('dragover', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      logoBox.classList.add('over');
    });
    logoBox.addEventListener('dragleave', () => logoBox.classList.remove('over'));
    logoBox.addEventListener('drop', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      logoBox.classList.remove('over');
      const file = [...(ev.dataTransfer.files || [])].find((f) => /^image\//.test(f.type));
      if (file) studio.setLogo(file);
    });
    const company = this.group('Firma', this.field('Logo', logoBox));
    if (logo) {
      const remove = htmlToElement(`<button type="button" class="btn sd-link">${icon('trash', 's')}Logo entfernen</button>`);
      remove.addEventListener('click', () => studio.change('Logo entfernt', () => (p.company.logo = null), { inspector: true }));
      company.appendChild(remove);
    }
    company.append(this.text('Firmenname', p.company, 'name'), this.bi('Zusatz', p.company, 'tagline'));
    const m = p.meta;
    const two = (a, b) => {
      const el = htmlToElement('<div class="sd-two"></div>');
      el.append(a, b);
      return el;
    };
    this.group(
      'Projekt',
      this.text('Kunde', m, 'customer'),
      this.text('Anschrift', m, 'address', { multiline: true }),
      this.text('Anlage', m, 'site', { placeholder: 'z. B. Einbruchmeldeanlage Halle 2' }),
      two(this.text('Datum', m, 'date', { type: 'date' }), this.text('Version', m, 'version')),
      two(this.text('Techniker', m, 'technician'), this.text('Dokument-Nr.', m, 'docNo')),
    );
  }

  /* ---------- Abschnitte ---------- */

  sectionForm(section) {
    const studio = this.studio;
    if (section.type === 'cover') {
      const edit = htmlToElement(`<button type="button" class="btn outline">${icon('edit', 's')}Projektangaben bearbeiten</button>`);
      edit.addEventListener('click', () => studio.select({ kind: 'project' }));
      this.group('Deckblatt', this.note('Titel, Kunde, Anlage, Datum und Techniker kommen aus den Projektangaben.'), edit);
    } else if (section.type === 'toc') {
      this.group('Inhaltsverzeichnis', this.note('Entsteht automatisch aus den Abschnitten der Projektmappe – mit Seitenzahlen.'));
    } else if (section.type === 'wiring') this.wiringForm(section);
    this.actions(['Abschnitt entfernen', 'trash', () => studio.removeSection(section.id), true]);
  }

  wiringForm(s) {
    const studio = this.studio;
    const lang = langsOf(this.project)[0];
    this.group('Anschlussplan', this.bi('Anlage', s, 'system', { placeholder: 'z. B. Zufallsgenerator' }));
    this.hubFields(s, 'Steuerung');
    const sideName = { left: 'links', right: 'rechts', bottom: 'unten' };
    const byId = new Map(s.boxes.map((b) => [b.id, b]));
    const boxes = this.group(
      `Baugruppen (${s.boxes.length})`,
      this.rows(s.boxes, {
        empty: 'Noch keine Baugruppe.',
        render: (b) =>
          `<i class="dot" style="background:${safeColor(catOf(s, b.cat))}"></i><span class="t">${escapeHtml(tx(b.title, lang) || 'Ohne Titel')}</span><small>${sideName[sideOf(b, byId)] || ''}</small>`,
        onOpen: (b) => studio.select({ kind: 'box', id: b.id, section: s.id }, { reveal: true }),
      }),
    );
    boxes.appendChild(this.addButton('Baugruppe', () => studio.addBox()));
    const pins = this.group(
      `Anschlüsse (${s.hub.pins.length})`,
      this.rows(s.hub.pins, {
        empty: 'Noch kein Anschluss.',
        render: (p) => `<b class="pin">${escapeHtml(p.name || '–')}</b><span class="t">${escapeHtml(tx(p.func, lang))}</span>`,
        onOpen: (p) => studio.select({ kind: 'pin', id: p.id, section: s.id }, { reveal: true }),
      }),
    );
    pins.appendChild(this.addButton('Anschluss', () => studio.addPin()));
    const hints = this.group(
      `Hinweise (${s.hints.length})`,
      this.rows(s.hints, {
        empty: 'Noch kein Hinweis.',
        render: (h) =>
          `<i class="dot" style="background:${safeColor(catOf(s, h.cat))}"></i><span class="t">${escapeHtml(tx(h.title, lang) || 'Ohne Titel')}</span>`,
        onOpen: (h) => studio.select({ kind: 'hint', id: h.id, section: s.id }, { reveal: true }),
      }),
    );
    hints.appendChild(this.addButton('Hinweis', () => studio.addHint()));
    this.categoriesGroup(s);
    const badge = s.badge;
    const colorInput = htmlToElement(`<input type="color" class="sd-color" value="${safeColor(badge.color, '#b45309')}">`);
    colorInput.addEventListener('input', () =>
      studio.change('Farbe geändert', () => (badge.color = colorInput.value), { key: 'badgecolor:' + s.id }),
    );
    const row = htmlToElement('<div class="sd-two narrow"></div>');
    row.append(this.text('Kennzeichen', badge, 'label', { id: 'badge' + s.id, placeholder: '12 V' }), this.field('Farbe', colorInput));
    this.group('Versorgungskennzeichen', row, this.bi('Erklärung in der Legende', badge, 'text', { id: 'badgetext' + s.id }));
  }

  categoriesGroup(s) {
    const studio = this.studio;
    const el = htmlToElement('<div class="sd-cats"></div>');
    for (const cat of s.categories) {
      const row = htmlToElement(`<div class="sd-cat"><input type="color" class="sd-color" value="${safeColor(cat.color)}" title="Farbe"></div>`);
      const name = this.input(
        tx(cat.name, langsOf(this.project)[0]),
        (v) => studio.change('Leitungsart umbenannt', () => {
          if (typeof cat.name !== 'object') cat.name = T(cat.name || '', '');
          cat.name[langsOf(this.project)[0]] = v;
        }, { key: 'catname:' + cat.id }),
        { id: 'cat' + cat.id },
      );
      const del = htmlToElement(`<button type="button" class="btn ic" title="Leitungsart entfernen">${icon('trash', 's')}</button>`);
      const used = s.boxes.some((b) => b.cat === cat.id) || s.hints.some((h) => h.cat === cat.id);
      del.disabled = used || s.categories.length < 2;
      if (used) del.title = 'Wird noch verwendet';
      del.addEventListener('click', () =>
        studio.change('Leitungsart entfernt', () => (s.categories = s.categories.filter((c) => c !== cat)), { inspector: true }),
      );
      row.querySelector('input').addEventListener('input', (ev) =>
        studio.change('Farbe geändert', () => (cat.color = ev.target.value), { key: 'catcolor:' + cat.id }),
      );
      row.append(name, del);
      el.appendChild(row);
    }
    const group = this.group('Leitungsarten', el);
    group.appendChild(
      this.addButton('Leitungsart', () =>
        studio.change('Leitungsart hinzugefügt', () => s.categories.push({ id: uid('c'), name: T('Neue Leitung', 'New line'), color: '#5b6b7a' }), {
          inspector: true,
        }),
      ),
    );
  }

  hubFields(s, title) {
    this.group(
      title,
      this.bi('Bezeichnung', s.hub, 'name', { id: 'hubname' + s.id }),
      this.bi('Kurzname', s.hub, 'short', {
        id: 'hubshort' + s.id,
        placeholder: tx(s.hub.name, 'de'),
        hint: 'Für die Überschrift des Klemmenplans, z. B. „Arduino“.',
      }),
      this.bi('Typ', s.hub, 'model', { id: 'hubmodel' + s.id, placeholder: 'z. B. ATmega328P' }),
      this.bi('Hinweis in der Steuerung', s.hub, 'note', { id: 'hubnote' + s.id, multiline: true }),
    );
  }

  hubForm(s) {
    this.hubFields(s, 'Steuerung');
    const lang = langsOf(this.project)[0];
    const pins = this.group(
      `Anschlüsse (${s.hub.pins.length})`,
      this.rows(s.hub.pins, {
        empty: 'Noch kein Anschluss.',
        render: (p) => `<b class="pin">${escapeHtml(p.name || '–')}</b><span class="t">${escapeHtml(tx(p.func, lang))}</span>`,
        onOpen: (p) => this.studio.select({ kind: 'pin', id: p.id, section: s.id }, { reveal: true }),
      }),
    );
    pins.appendChild(this.addButton('Anschluss', () => this.studio.addPin(null)));
  }

  /* ---------- Baugruppe ---------- */

  boxForm(s, box) {
    const studio = this.studio;
    const lang = langsOf(this.project)[0];
    const byId = new Map(s.boxes.map((b) => [b.id, b]));
    const side = sideOf(box, byId);
    this.group(
      'Beschriftung',
      this.bi('Titel', box, 'title'),
      this.bi('Beschreibung', box, 'lines', { multiline: true, hint: 'Jede Zeile erscheint als eigene Zeile im Kasten.' }),
    );
    const parents = s.boxes.filter((b) => b.id !== box.id && sideOf(b, byId) !== 'bottom' && b.parent !== box.id);
    this.group(
      'Darstellung',
      this.field('Leitungsart', this.catChips(s, box.cat, (id) => studio.change('Leitungsart geändert', () => (box.cat = id), { inspector: true }))),
      box.parent
        ? null
        : this.seg(
            'Lage',
            [
              ['left', 'Links'],
              ['right', 'Rechts'],
              ['bottom', 'Unten'],
            ],
            box.side,
            (v) =>
              studio.change('Lage geändert', () => {
                box.side = v;
                box.y = null;
                box.fill = v === 'bottom';
              }, { inspector: true }),
          ),
      side === 'bottom'
        ? null
        : this.select(
            'Unter Baugruppe',
            [[null, '– keine –'], ...parents.map((b) => [b.id, tx(b.title, lang) || 'Ohne Titel'])],
            box.parent,
            (v) => studio.change('Zuordnung geändert', () => ((box.parent = v), (box.y = null)), { inspector: true }),
          ),
      this.check(
        `Kennzeichen „${s.badge.label || '12 V'}“`,
        box.badge,
        (v) => studio.change('Kennzeichen geändert', () => (box.badge = v)),
        tx(s.badge.text, lang),
      ),
      side === 'bottom'
        ? this.check('Hintergrund füllen', box.fill, (v) => studio.change('Füllung geändert', () => (box.fill = v)))
        : this.check('Sammelleitung', box.bus, (v) => studio.change('Sammelleitung geändert', () => (box.bus = v)), 'Alle Anschlüsse als eine Leitung, z. B. „D10-D13“'),
    );
    const own = s.hub.pins.filter((p) => p.box === box.id);
    const pins = this.group(
      `Anschlüsse (${own.length})`,
      this.rows(own, {
        empty: 'Mit der Steuerung noch nicht verbunden.',
        render: (p) => `<b class="pin">${escapeHtml(p.name || '–')}</b><span class="t">${escapeHtml(tx(p.terminal, lang) || tx(p.func, lang))}</span>`,
        onOpen: (p) => studio.select({ kind: 'pin', id: p.id, section: s.id }, { reveal: true }),
      }),
    );
    pins.appendChild(this.addButton('Anschluss', () => studio.addPin(box.id)));
    const placed = [box.y, box.h, box.pinY, box.pinGap].some((v) => v != null && v !== '');
    this.actions(
      placed && [
        'Lage automatisch',
        'sparkle',
        () =>
          studio.change('Lage automatisch', () => {
            box.y = box.h = box.pinY = box.pinGap = null;
          }, { inspector: true }),
      ],
      ['Löschen', 'trash', () => studio.removeSelected(), true],
    );
    this.body.appendChild(this.note('Im Plan verschieben: Kasten ziehen (auch auf die andere Seite). Unterkante ziehen ändert die Höhe, eine Leitung ziehen verschiebt die Anschlüsse. Pfeiltasten: 1 pt, mit Umschalt 10 pt.'));
  }

  /* ---------- Anschluss ---------- */

  pinForm(s, pin) {
    const studio = this.studio;
    const lang = langsOf(this.project)[0];
    const two = htmlToElement('<div class="sd-two"></div>');
    two.append(
      this.text('Pin', pin, 'name', { id: 'pin' + pin.id, placeholder: 'z. B. D2' }),
      this.text('Im Plan', pin, 'label', { id: 'pinlabel' + pin.id, placeholder: pin.name || 'wie Pin' }),
    );
    this.group(
      'Anschluss',
      two,
      this.bi('Funktion', pin, 'func'),
      this.select(
        'Baugruppe',
        [[null, '– nicht im Plan –'], ...s.boxes.map((b) => [b.id, tx(b.title, lang) || 'Ohne Titel'])],
        pin.box,
        (v) => studio.change('Baugruppe zugeordnet', () => (pin.box = v), { inspector: true }),
      ),
      this.bi('Angeschlossen an', pin, 'terminal', { placeholder: 'z. B. Display TX' }),
      this.bi('Bemerkung', pin, 'note'),
    );
    const index = s.hub.pins.indexOf(pin);
    const move = (dir) =>
      studio.change('Reihenfolge geändert', () => {
        const j = index + dir;
        [s.hub.pins[index], s.hub.pins[j]] = [s.hub.pins[j], s.hub.pins[index]];
      }, { inspector: true });
    const acts = this.actions(['Löschen', 'trash', () => studio.removeSelected(), true]);
    const order = htmlToElement(
      `<div class="sd-order"><button type="button" class="btn ic" title="Nach oben"${index === 0 ? ' disabled' : ''}>${icon('up', 's')}</button><button type="button" class="btn ic" title="Nach unten"${index === s.hub.pins.length - 1 ? ' disabled' : ''}>${icon('down', 's')}</button></div>`,
    );
    const [up, down] = order.querySelectorAll('button');
    up.addEventListener('click', () => move(-1));
    down.addEventListener('click', () => move(1));
    acts.prepend(order);
  }

  /* ---------- Hinweis ---------- */

  hintForm(s, hint) {
    const studio = this.studio;
    const custom = s.categories.some((c) => c.id === hint.cat) ? [] : [[hint.cat, hint.cat, 'Eigene Farbe']];
    this.group(
      'Hinweis',
      this.bi('Überschrift', hint, 'title'),
      this.bi('Text', hint, 'text', { multiline: true }),
      this.field('Farbe', this.catChips(s, hint.cat, (id) => studio.change('Farbe geändert', () => (hint.cat = id), { inspector: true }), custom)),
    );
    const index = s.hints.indexOf(hint);
    const move = (dir) =>
      studio.change('Reihenfolge geändert', () => {
        const j = index + dir;
        [s.hints[index], s.hints[j]] = [s.hints[j], s.hints[index]];
      }, { inspector: true });
    const acts = this.actions(['Löschen', 'trash', () => studio.removeSelected(), true]);
    const order = htmlToElement(
      `<div class="sd-order"><button type="button" class="btn ic" title="Nach oben"${index === 0 ? ' disabled' : ''}>${icon('up', 's')}</button><button type="button" class="btn ic" title="Nach unten"${index === s.hints.length - 1 ? ' disabled' : ''}>${icon('down', 's')}</button></div>`,
    );
    const [up, down] = order.querySelectorAll('button');
    up.addEventListener('click', () => move(-1));
    down.addEventListener('click', () => move(1));
    acts.prepend(order);
  }
}

function catOf(section, cat) {
  const found = section.categories.find((c) => c.id === cat);
  return found ? found.color : cat;
}


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
import { toast } from '../ui/dialogs.js';
import {
  ACCESS_BLOCKS,
  BLOCK_TYPES,
  FONTS,
  LANGS,
  PHOTO_LAYOUTS,
  SYMBOLS,
  T,
  TONES,
  STRINGS,
  langsOf,
  projectSymbols,
  sectionTitle,
  symbolInfo,
  symbolLabels,
  tx,
  uid,
} from './model.js';
import { symbolIconSvg } from './site.js';
import { chapterLabels, referenceTargets } from './chapters.js';
import { sideOf } from './wiring.js';
import { color as safeColor } from './svg.js';

const KIND_TITLE = {
  project: 'Projekt',
  box: 'Baugruppe',
  pin: 'Anschluss',
  hint: 'Hinweis',
  hub: 'Steuerung',
  device: 'Gerät',
  wifi: 'WLAN',
  remote: 'Fernzugriff',
  sym: 'Symbol',
  photo: 'Foto',
  block: 'Baustein',
};

/** Vorschläge für Fernzugriff-Dienste (frei änderbar). */
const SERVICES = ['DDNS', 'Portfreigabe', 'VPN', 'Hik-Connect', 'DMSS (Dahua)', 'Telenot compasX', 'Ajax PRO', 'TeamViewer', 'AnyDesk'];

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
    if (!this.focusTracked) {
      this.focusTracked = true;
      this.body.addEventListener('focusin', (ev) => {
        if (/^(INPUT|TEXTAREA)$/.test(ev.target.tagName) && ev.target.type !== 'range' && ev.target.type !== 'color') this.lastField = ev.target;
      });
    }
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
    else if (sel.kind === 'block') this.blockForm(section, item);
    else if (sel.kind === 'sym') this.symForm(section, item);
    else if (sel.kind === 'photo') this.photoForm(section, item);
    else if (sel.kind === 'device') this.deviceForm(section, item);
    else if (sel.kind === 'wifi') this.wifiForm(section, item);
    else if (sel.kind === 'remote') this.remoteForm(section, item);
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
    else if (section.type === 'access') this.accessForm(section);
    else if (section.type === 'site') this.siteForm(section);
    else if (section.type === 'chapters') this.chaptersForm(section);
    else if (section.type === 'photos') this.photosForm(section);
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
    // als Baugruppe wählbar: keine untere, nicht sie selbst und keine ihrer Unterbaugruppen
    const below = new Set([box.id]);
    for (let grew = true; grew; ) {
      grew = false;
      for (const b of s.boxes) if (b.parent && below.has(b.parent) && !below.has(b.id)) below.add(b.id), (grew = true);
    }
    const parents = s.boxes.filter((b) => !below.has(b.id) && sideOf(b, byId) !== 'bottom');
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
                // Unterbaugruppen bleiben auf ihrer Seite, wenn die Baugruppe nach unten wandert
                if (v === 'bottom')
                  for (const child of s.boxes)
                    if (child.parent === box.id) {
                      child.parent = null;
                      child.side = box.side === 'bottom' ? 'left' : box.side;
                      child.y = null;
                    }
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

/* ---------- Zugangsdaten ---------- */

Object.assign(Inspector.prototype, {
  /** Passwortfeld mit Auge zum Anzeigen. */
  secret(label, obj, prop) {
    const key = `s:${prop}:${this.studio.sel.id}`;
    const input = this.input(obj[prop], (v) => this.studio.change(label + ' geändert', () => (obj[prop] = v), { key }), {
      id: key,
    });
    input.type = 'password';
    input.classList.add('mono');
    input.autocomplete = 'new-password';
    const wrap = htmlToElement('<span class="sd-secret"></span>');
    const eye = htmlToElement(`<button type="button" class="btn ic" title="Anzeigen">${icon('eye', 's')}</button>`);
    eye.addEventListener('click', (ev) => {
      ev.preventDefault();
      input.type = input.type === 'password' ? 'text' : 'password';
      eye.classList.toggle('on', input.type === 'text');
    });
    wrap.append(input, eye);
    return this.field(label, wrap);
  },

  mono(label, obj, prop, opts = {}) {
    const f = this.text(label, obj, prop, opts);
    f.querySelector('input').classList.add('mono');
    f.querySelector('input').spellcheck = false;
    return f;
  },

  pair(a, b) {
    const el = htmlToElement('<div class="sd-two"></div>');
    el.append(a, b);
    return el;
  },

  accessForm(s) {
    const studio = this.studio;
    const lang = langsOf(this.project)[0];
    this.group(
      'Zugangsdaten',
      this.bi('Überschrift', s, 'title'),
      this.check(
        'Passwörter und Schlüssel in der PDF zeigen',
        s.showPasswords,
        (v) => {
          studio.change(v ? 'Passwörter sichtbar' : 'Passwörter ausgeblendet', () => (s.showPasswords = v));
          studio.app.renderRibbon();
        },
        'Sonst erscheinen Punkte. Beim Erstellen der PDF fragt PDFix noch einmal nach.',
      ),
    );
    const blocks = this.group('In der PDF');
    for (const b of ACCESS_BLOCKS)
      blocks.appendChild(
        this.check(tx(b.title, 'de'), !!s.blocks[b.id], (v) =>
          studio.change(`${tx(b.title, 'de')} ${v ? 'ein' : 'aus'}`, () => (s.blocks[b.id] = v), { inspector: true }),
        ),
      );
    // wählbare Spalten je Tabelle (leere Spalten entfallen ohnehin)
    const cols = this.group('Spalten');
    for (const b of ACCESS_BLOCKS) {
      if (!b.columns || !s.blocks[b.id]) continue;
      const hidden = new Set(s.hide[b.id] || []);
      const chips = htmlToElement('<div class="sd-chips multi"></div>');
      for (const c of b.columns.filter((x) => !x.fixed)) {
        const on = !hidden.has(c.key);
        const chip = htmlToElement(
          `<button type="button" aria-pressed="${on}" class="${on ? 'on' : ''}">${on ? icon('check', 's') : ''}${escapeHtml(tx(c.label, 'de'))}</button>`,
        );
        chip.addEventListener('click', () =>
          studio.change(
            'Spalten geändert',
            () => {
              const list = new Set(s.hide[b.id] || []);
              if (list.has(c.key)) list.delete(c.key);
              else list.add(c.key);
              s.hide[b.id] = [...list];
            },
            { inspector: true },
          ),
        );
        chips.appendChild(chip);
      }
      cols.append(htmlToElement(`<span class="sd-l">${escapeHtml(tx(b.title, 'de'))}</span>`), chips);
    }
    if (!cols.querySelector('.sd-chips')) cols.remove();
    const devices = this.group(
      `Geräte (${s.devices.length})`,
      this.rows(s.devices, {
        empty: 'Noch kein Gerät.',
        render: (d) =>
          `<span class="t">${escapeHtml(tx(d.name, lang) || 'Ohne Namen')}</span><small class="mono">${escapeHtml(d.ip || '')}</small>`,
        onOpen: (d) => studio.select({ kind: 'device', id: d.id, section: s.id }, { reveal: true }),
      }),
    );
    devices.appendChild(this.addButton('Gerät', () => studio.addAccessItem('device')));
    if (s.blocks.network) {
      const n = s.network;
      this.group(
        'Netzwerk',
        this.pair(this.mono('Subnetzmaske', n, 'subnet', { id: 'net-subnet', placeholder: '255.255.255.0' }), this.mono('Gateway', n, 'gateway', { id: 'net-gw', placeholder: '192.168.1.1' })),
        this.pair(this.mono('DNS-Server', n, 'dns', { id: 'net-dns' }), this.mono('VLAN', n, 'vlan', { id: 'net-vlan' })),
        this.mono('DHCP-Bereich', n, 'dhcp', { id: 'net-dhcp', placeholder: 'z. B. 192.168.1.100 – 192.168.1.199' }),
        this.bi('Bemerkung', n, 'note', { id: 'net-note' }),
      );
    }
    const wifi = this.group(
      `WLAN (${s.wifi.length})`,
      this.rows(s.wifi, {
        empty: 'Noch kein WLAN.',
        render: (w) => `<span class="t">${escapeHtml(w.ssid || 'Ohne Namen')}</span><small>${escapeHtml(w.security || '')}</small>`,
        onOpen: (w) => studio.select({ kind: 'wifi', id: w.id, section: s.id }, { reveal: true }),
      }),
    );
    wifi.appendChild(this.addButton('WLAN', () => studio.addAccessItem('wifi')));
    const remote = this.group(
      `Fernzugriff (${s.remote.length})`,
      this.rows(s.remote, {
        empty: 'Noch kein Fernzugriff.',
        render: (r) => `<span class="t">${escapeHtml(r.service || 'Ohne Namen')}</span><small class="mono">${escapeHtml(r.address || '')}</small>`,
        onOpen: (r) => studio.select({ kind: 'remote', id: r.id, section: s.id }, { reveal: true }),
      }),
    );
    remote.appendChild(this.addButton('Fernzugriff', () => studio.addAccessItem('remote')));
  },

  /** Reihenfolge-Knöpfe und Löschen für Listeneinträge. */
  itemActions(list, item) {
    const studio = this.studio;
    const index = list.indexOf(item);
    const move = (dir) =>
      studio.change(
        'Reihenfolge geändert',
        () => {
          const j = index + dir;
          [list[index], list[j]] = [list[j], list[index]];
        },
        { inspector: true },
      );
    const acts = this.actions(['Löschen', 'trash', () => studio.removeSelected(), true]);
    const order = htmlToElement(
      `<div class="sd-order"><button type="button" class="btn ic" title="Nach oben"${index === 0 ? ' disabled' : ''}>${icon('up', 's')}</button><button type="button" class="btn ic" title="Nach unten"${index === list.length - 1 ? ' disabled' : ''}>${icon('down', 's')}</button></div>`,
    );
    const [up, down] = order.querySelectorAll('button');
    up.addEventListener('click', () => move(-1));
    down.addEventListener('click', () => move(1));
    acts.prepend(order);
  },

  deviceForm(s, d) {
    this.group(
      'Zugang',
      this.bi('Gerät', d, 'name', { placeholder: 'z. B. Rekorder (NVR)' }),
      this.pair(this.mono('IP-Adresse', d, 'ip', { placeholder: '192.168.1.20' }), this.mono('Port / Web', d, 'web', { placeholder: '443 / https://…' })),
      this.pair(this.mono('Benutzer', d, 'user', { placeholder: 'admin' }), this.secret('Passwort', d, 'password')),
      this.bi('Bemerkung', d, 'note'),
    );
    this.group(
      'Gerätedaten',
      this.text('Hersteller / Typ', d, 'model', { placeholder: 'z. B. Hikvision DS-7608NXI' }),
      this.pair(this.mono('Seriennummer', d, 'serial'), this.mono('MAC-Adresse', d, 'mac', { placeholder: 'AA:BB:CC:DD:EE:FF' })),
      this.pair(this.mono('Firmware', d, 'firmware'), this.bi('Standort', d, 'location')),
    );
    this.itemActions(s.devices, d);
  },

  wifiForm(s, w) {
    const studio = this.studio;
    this.group(
      'WLAN',
      this.mono('WLAN-Name (SSID)', w, 'ssid'),
      this.secret('Schlüssel', w, 'key'),
      this.select(
        'Verschlüsselung',
        ['WPA2', 'WPA3', 'WPA2/WPA3', 'WPA', 'WEP', 'Offen'].map((v) => [v, v]),
        w.security,
        (v) => studio.change('Verschlüsselung geändert', () => (w.security = v)),
      ),
      this.bi('Bemerkung', w, 'note', { placeholder: 'z. B. Gäste-WLAN, 2,4 GHz' }),
    );
    this.itemActions(s.wifi, w);
  },

  remoteForm(s, r) {
    const service = this.text('Dienst', r, 'service', { placeholder: 'z. B. DDNS, Hik-Connect, Portfreigabe' });
    const list = htmlToElement(`<datalist id="sdServices">${SERVICES.map((v) => `<option value="${escapeHtml(v)}">`).join('')}</datalist>`);
    service.querySelector('input').setAttribute('list', 'sdServices');
    service.appendChild(list);
    this.group(
      'Fernzugriff',
      service,
      this.mono('Adresse / ID', r, 'address', { placeholder: 'z. B. kunde.ddns.net:8443 oder Geräte-ID' }),
      this.pair(this.mono('Benutzer', r, 'user'), this.secret('Passwort', r, 'password')),
      this.bi('Bemerkung', r, 'note'),
    );
    this.itemActions(s.remote, r);
  },
});

/* ---------- Lageplan und Fotos ---------- */

Object.assign(Inspector.prototype, {
  /** Regler mit Zahlenfeld (Werte in Anzeigeeinheit; `scale` rechnet in den gespeicherten Wert um). */
  slider(label, obj, prop, { min, max, step = 1, scale = 1, unit = '' }) {
    const studio = this.studio;
    const key = `r:${prop}:${studio.sel.id || studio.sel.kind}`;
    const shown = () => Math.round(obj[prop] * scale * 100) / 100;
    const range = htmlToElement(`<input type="range" min="${min}" max="${max}" step="${step}" value="${shown()}">`);
    const num = htmlToElement(`<input class="fld num" type="number" min="${min}" max="${max}" step="${step}" value="${shown()}" aria-label="${escapeHtml(label)} (${unit})">`);
    const set = (raw) => {
      const v = Math.max(min, Math.min(max, Number(raw)));
      if (!Number.isFinite(v)) return;
      studio.change(label + ' geändert', () => (obj[prop] = v / scale), { key });
    };
    range.addEventListener('input', () => {
      num.value = range.value;
      set(range.value);
    });
    num.addEventListener('input', () => {
      range.value = num.value;
      set(num.value);
    });
    num.addEventListener('keydown', (ev) => ev.key === 'Enter' && num.blur());
    const wrap = htmlToElement('<div class="sd-range"></div>');
    wrap.append(range, num);
    return this.field(unit ? `${label} (${unit})` : label, wrap);
  },

  siteForm(s) {
    const studio = this.studio;
    const lang = langsOf(this.project)[0];
    const labels = symbolLabels(s);
    this.group(
      'Lageplan',
      this.bi('Überschrift', s, 'title'),
      this.check('Nummern an den Symbolen', s.showNumbers, (v) => studio.change('Nummern geändert', () => (s.showNumbers = v))),
      this.check('Geräteliste auf einer Folgeseite', s.showList, (v) => studio.change('Geräteliste geändert', () => (s.showList = v))),
    );
    // Hintergrund
    const img = s.bg.image && this.project.images[s.bg.image];
    const bg = this.group('Hintergrund');
    bg.appendChild(
      htmlToElement(
        `<div class="sd-thumbrow">${img ? `<img alt="Hintergrund" src="${escapeHtml(img.data)}">` : `<span class="sd-empty" style="padding:0">Noch kein Bild</span>`}</div>`,
      ),
    );
    const buttons = htmlToElement('<div class="sd-acts" style="padding-top:8px"></div>');
    for (const [label, iconName, run] of [
      ['Bild …', 'image', () => studio.pickBackground(s)],
      ['PDF-Seite …', 'file', () => studio.pickBackgroundPdf(s)],
    ]) {
      const b = htmlToElement(`<button type="button" class="btn outline">${icon(iconName, 's')}${label}</button>`);
      b.addEventListener('click', run);
      buttons.appendChild(b);
    }
    bg.appendChild(buttons);
    if (img) {
      bg.appendChild(
        this.seg('Drehung', [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']], s.bg.rotate, (v) =>
          studio.change('Hintergrund gedreht', () => (s.bg.rotate = v), { inspector: true }),
        ),
      );
      bg.appendChild(
        this.seg('Darstellung', [['contain', 'Einpassen'], ['cover', 'Füllen']], s.bg.fit, (v) =>
          studio.change('Hintergrund geändert', () => (s.bg.fit = v), { inspector: true }),
        ),
      );
      bg.appendChild(this.slider('Aufhellen', s.bg, 'fade', { min: 0, max: 80, scale: 0.01, unit: '%' }));
    }
    // Symbole
    const palette = htmlToElement('<div class="sd-symbols"></div>');
    const kinds = [...SYMBOLS, ...s.custom.map((c) => ({ id: 'custom:' + c.id, ...symbolInfo(s, 'custom:' + c.id) }))];
    for (const kind of kinds) {
      const info = symbolInfo(s, kind.id);
      const b = htmlToElement(
        `<button type="button" class="sd-symbol${studio.armed === kind.id ? ' on' : ''}" aria-pressed="${studio.armed === kind.id}" title="${escapeHtml(tx(info.name, 'de'))}">${symbolIconSvg(info, this.project.images)}<span>${escapeHtml(tx(info.name, lang))}</span></button>`,
      );
      b.addEventListener('click', () => studio.arm(kind.id));
      palette.appendChild(b);
    }
    const symbols = this.group('Symbole', palette, this.note('Symbol wählen, dann in den Plan klicken – so oft wie nötig. Esc beendet. Eigene Symbole oben im Werkzeugband.'));
    void symbols;
    this.group(
      `Im Plan (${s.symbols.length})`,
      this.rows(s.symbols, {
        empty: 'Noch kein Symbol gesetzt.',
        render: (y) => {
          const info = symbolInfo(s, y.kind);
          return `<b class="pin">${escapeHtml(labels.get(y.id) || '')}</b><span class="t">${escapeHtml(tx(y.name, lang) || (info ? tx(info.name, lang) : ''))}</span>`;
        },
        onOpen: (y) => studio.select({ kind: 'sym', id: y.id, section: s.id }, { reveal: true }),
      }),
    );
    this.actions(['Abschnitt entfernen', 'trash', () => studio.removeSection(s.id), true]);
  },

  symForm(s, y) {
    const studio = this.studio;
    const lang = langsOf(this.project)[0];
    const info = symbolInfo(s, y.kind);
    const labels = symbolLabels(s);
    const kinds = [...SYMBOLS.map((k) => [k.id, tx(k.name, lang)]), ...s.custom.map((c) => ['custom:' + c.id, tx(c.name, lang)])];
    this.group(
      `${labels.get(y.id) || 'Symbol'}`,
      this.bi('Bezeichnung', y, 'name', { placeholder: info ? tx(info.name, lang) : '' }),
      this.bi('Bemerkung', y, 'note'),
      this.select('Art', kinds, y.kind, (v) =>
        studio.change(
          'Art geändert',
          () => {
            const next = symbolInfo(s, v);
            y.kind = v;
            y.fov = !!(next && next.fov);
            if (next && next.fov) {
              y.angle = next.fov.angle;
              y.range = next.fov.range;
            }
          },
          { inspector: true },
        ),
      ),
      this.seg('Größe', [[0.75, 'Klein'], [1, 'Mittel'], [1.5, 'Groß']], y.scale, (v) =>
        studio.change('Größe geändert', () => (y.scale = v), { inspector: true }),
      ),
    );
    if (info && info.fov) {
      const group = this.group(
        'Erfassungsbereich',
        this.check('Erfassungsbereich zeigen', y.fov, (v) => studio.change('Erfassungsbereich geändert', () => (y.fov = v), { inspector: true })),
      );
      if (y.fov)
        group.append(
          this.slider('Blickrichtung', y, 'dir', { min: 0, max: 359, unit: '°' }),
          this.slider('Öffnungswinkel', y, 'angle', { min: 10, max: 360, unit: '°' }),
          this.slider('Reichweite', y, 'range', { min: 20, max: 400, unit: 'pt' }),
          this.note('Im Plan den Punkt am Ende ziehen: Richtung und Reichweite zugleich (mit Umschalt in 15°-Schritten).'),
        );
    }
    // Fotos, die auf dieses Symbol verweisen
    const photos = [];
    for (const sec of this.project.sections)
      if (sec.type === 'photos') for (const p of sec.items) if (p.link === y.id) photos.push({ p, sec });
    if (photos.length)
      this.group(
        `Fotos (${photos.length})`,
        this.rows(photos, {
          render: ({ p }) => `<span class="t">${escapeHtml(tx(p.caption, lang) || 'Foto')}</span>`,
          onOpen: ({ p, sec }) => studio.select({ kind: 'photo', id: p.id, section: sec.id }, { reveal: true }),
        }),
      );
    this.actions(['Löschen', 'trash', () => studio.removeSelected(), true]);
  },

  photosForm(s) {
    const studio = this.studio;
    const lang = langsOf(this.project)[0];
    this.group(
      'Fotodokumentation',
      this.bi('Überschrift', s, 'title'),
      this.seg('Fotos je Seite', PHOTO_LAYOUTS.map((n) => [n, String(n)]), s.perPage, (v) =>
        studio.change('Fotos je Seite geändert', () => (s.perPage = v), { inspector: true }),
      ),
      this.check('Aufnahmedatum zeigen', s.showDate, (v) => studio.change('Datum geändert', () => (s.showDate = v))),
    );
    const list = this.group(
      `Fotos (${s.items.length})`,
      this.rows(s.items, {
        empty: 'Noch kein Foto.',
        render: (p) => {
          const img = this.project.images[p.image];
          return `${img ? `<img alt="" src="${escapeHtml(img.data)}" style="width:34px;height:26px;object-fit:cover;border-radius:3px;flex:none">` : ''}<span class="t">${escapeHtml(tx(p.caption, lang) || 'Ohne Unterschrift')}</span><small>${escapeHtml(p.date || '')}</small>`;
        },
        onOpen: (p) => studio.select({ kind: 'photo', id: p.id, section: s.id }, { reveal: true }),
      }),
    );
    list.appendChild(this.addButton('Fotos hinzufügen', () => studio.pickPhotos(s)));
    this.actions(['Abschnitt entfernen', 'trash', () => studio.removeSection(s.id), true]);
  },

  photoForm(s, p) {
    const studio = this.studio;
    const img = this.project.images[p.image];
    const links = projectSymbols(this.project, langsOf(this.project)[0]);
    const group = this.group('Foto');
    if (img) group.appendChild(htmlToElement(`<img class="sd-photo" alt="Foto" src="${escapeHtml(img.data)}">`));
    group.append(
      this.bi('Bildunterschrift', p, 'caption', { multiline: true }),
      this.text('Aufnahmedatum', p, 'date', { type: 'date' }),
      this.select(
        'Gerät im Lageplan',
        [[null, '– keine Verknüpfung –'], ...links.map((l) => [l.id, `${l.label} ${l.name}`])],
        p.link,
        (v) => studio.change('Verknüpfung geändert', () => (p.link = v)),
      ),
    );
    this.itemActions(s.items, p);
  },
});

/* ---------- Anleitung / Technische Beschreibung ---------- */

const blockPreview = (b, lang) => {
  const first = (v) => String(tx(v, lang) || '').split('\n')[0];
  if (b.type === 'h') return first(b.text);
  if (b.type === 'p' || b.type === 'ul' || b.type === 'steps') return first(b.text);
  if (b.type === 'callout') return first(b.title) || first(b.text);
  if (b.type === 'figure' || b.type === 'figsteps') return first(b.caption);
  if (b.type === 'table') return first(b.caption) || b.head.join(' · ');
  return String(b.text || '').split('\n')[0];
};

Object.assign(Inspector.prototype, {
  chaptersForm(s) {
    const studio = this.studio;
    const lang = langsOf(this.project)[0];
    const labels = chapterLabels(s);
    this.group(
      s.kind === 'tech' ? 'Technische Beschreibung' : 'Anleitung',
      this.bi('Titel', s, 'title'),
      this.check('Überschriften nummerieren', s.numbering, (v) => studio.change('Nummerierung geändert', () => (s.numbering = v))),
    );
    const list = this.group(
      `Bausteine (${s.blocks.length})`,
      this.rows(s.blocks, {
        empty: 'Noch kein Baustein.',
        render: (b) => {
          const meta = BLOCK_TYPES.find((t) => t.id === (b.type === 'table' ? b.preset : b.type)) || BLOCK_TYPES[1];
          const num = labels.get(b.id);
          const lead = b.type === 'h' ? `<b class="pin">${escapeHtml(num ? num.label : '')}</b>` : `<small style="min-width:96px">${escapeHtml(meta.label)}</small>`;
          return `${lead}<span class="t">${escapeHtml(blockPreview(b, lang))}</span>`;
        },
        onOpen: (b) => studio.select({ kind: 'block', id: b.id, section: s.id }, { reveal: true }),
      }),
    );
    list.appendChild(this.addButton('Baustein', () => studio.blockMenu(list.lastChild, s)));
    this.actions(
      ['Suchen und Ersetzen', 'replace', () => studio.replaceDialog()],
      ['Abschnitt entfernen', 'trash', () => studio.removeSection(s.id), true],
    );
  },

  /** Auswahl „Verweis einfügen“: fügt {ref:…} in das zuletzt bearbeitete Textfeld ein. */
  refSelect(s) {
    const targets = referenceTargets(s, langsOf(this.project)[0]);
    if (!targets.length) return null;
    const select = document.createElement('select');
    select.className = 'fld';
    select.innerHTML = `<option value="">Verweis einfügen …</option>${targets.map((t) => `<option value="${escapeHtml(t.id)}">${escapeHtml(t.text)}</option>`).join('')}`;
    select.addEventListener('change', () => {
      const field = this.lastField;
      const id = select.value;
      select.value = '';
      if (!id) return;
      if (!field || !field.isConnected) return toast('Zuerst in ein Textfeld klicken, dann den Verweis wählen.');
      const token = `{ref:${id}}`;
      const at = field.selectionStart ?? field.value.length;
      field.value = field.value.slice(0, at) + token + field.value.slice(field.selectionEnd ?? at);
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.focus();
      field.setSelectionRange(at + token.length, at + token.length);
    });
    return this.field('Verweis', select, 'Fügt „Abschnitt 2.1“, „Abbildung 3“ … automatisch ein und aktualisiert sich.');
  },

  blockForm(s, b) {
    const studio = this.studio;
    const meta = BLOCK_TYPES.find((t) => t.id === (b.type === 'table' ? b.preset : b.type)) || BLOCK_TYPES[1];
    const group = this.group(meta.label);
    const textual = ['p', 'ul', 'steps', 'callout', 'figsteps', 'table'].includes(b.type);
    if (b.type === 'h') {
      group.append(
        this.bi('Überschrift', b, 'text'),
        this.seg('Ebene', [[1, 'Kapitel'], [2, 'Unterkapitel']], b.level, (v) =>
          studio.change('Ebene geändert', () => (b.level = v), { inspector: true }),
        ),
      );
    } else if (b.type === 'p') group.append(this.bi('Text', b, 'text', { multiline: true }));
    else if (b.type === 'ul') group.append(this.bi('Punkte', b, 'text', { multiline: true, hint: 'Ein Punkt je Zeile.' }));
    else if (b.type === 'steps') group.append(this.bi('Schritte', b, 'text', { multiline: true, hint: 'Ein Schritt je Zeile – die Nummern entstehen automatisch.' }));
    else if (b.type === 'callout') {
      group.append(
        this.seg('Art', TONES.map((t) => [t.id, tx(STRINGS.tone[t.id], 'de')]), b.tone, (v) =>
          studio.change('Art geändert', () => (b.tone = v), { inspector: true }),
        ),
        this.bi('Titel', b, 'title', { placeholder: tx(STRINGS.tone[b.tone], 'de'), hint: 'Leer lassen für die Standardbezeichnung.' }),
        this.bi('Text', b, 'text', { multiline: true }),
      );
    } else if (b.type === 'figure' || b.type === 'figsteps') {
      const img = b.image && this.project.images[b.image];
      if (img) group.appendChild(htmlToElement(`<img class="sd-photo" alt="Abbildung" src="${escapeHtml(img.data)}">`));
      const buttons = htmlToElement('<div class="sd-acts" style="padding:0 0 10px"></div>');
      for (const [label, iconName, run] of [
        [img ? 'Bild ersetzen …' : 'Bild wählen …', 'image', () => studio.pickBlockImage(b)],
        ...(img ? [['Entfernen', 'trash', () => studio.change('Bild entfernt', () => (b.image = null), { inspector: true })]] : []),
      ]) {
        const btn = htmlToElement(`<button type="button" class="btn outline">${icon(iconName, 's')}${label}</button>`);
        btn.addEventListener('click', run);
        buttons.appendChild(btn);
      }
      group.append(buttons, this.bi('Bildunterschrift', b, 'caption'));
      if (b.type === 'figure')
        group.append(this.seg('Breite', [['full', 'Ganze Seite'], ['half', 'Halb']], b.width, (v) => studio.change('Breite geändert', () => (b.width = v), { inspector: true })));
      else group.append(this.bi('Schritte', b, 'text', { multiline: true, hint: 'Ein Schritt je Zeile.' }));
    } else if (b.type === 'table') {
      group.append(this.bi('Beschriftung', b, 'caption', { hint: 'Mit Beschriftung wird die Tabelle nummeriert („Tabelle 2“).' }), this.tableGrid(b));
    } else if (b.type === 'code') {
      const f = this.text('Code', b, 'text', { multiline: true });
      f.querySelector('textarea').classList.add('mono');
      f.querySelector('textarea').spellcheck = false;
      group.append(f);
    } else if (b.type === 'formula') group.append(this.text('Formel', b, 'text', { multiline: true, hint: 'Sonderzeichen direkt tippen: · × ÷ ± √ ² ³ ≈ ≤ ≥ Ω µ' }));
    if (textual) {
      const ref = this.refSelect(s);
      if (ref) group.append(ref);
    }
    this.itemActions(s.blocks, b);
  },

  /** Tabelle als Gitter von Eingabefeldern. */
  tableGrid(b) {
    const studio = this.studio;
    const cols = b.head.length;
    const grid = htmlToElement(`<div class="sd-grid" style="grid-template-columns:repeat(${cols},minmax(0,1fr)) 26px"></div>`);
    const cell = (value, onInput, key, head = false) => {
      const input = htmlToElement('<input class="fld" type="text" autocomplete="off">');
      input.value = value;
      input.dataset.f = key;
      if (head) input.classList.add('head');
      input.addEventListener('input', () => onInput(input.value));
      input.addEventListener('keydown', (ev) => ev.key === 'Escape' && input.blur());
      return input;
    };
    b.head.forEach((t, c) =>
      grid.appendChild(cell(t, (v) => studio.change('Tabelle geändert', () => (b.head[c] = v), { key: `th:${b.id}:${c}` }), `th:${b.id}:${c}`, true)),
    );
    grid.appendChild(document.createElement('span'));
    b.rows.forEach((row, r) => {
      row.forEach((t, c) =>
        grid.appendChild(cell(t, (v) => studio.change('Tabelle geändert', () => (b.rows[r][c] = v), { key: `td:${b.id}:${r}:${c}` }), `td:${b.id}:${r}:${c}`)),
      );
      const del = htmlToElement(`<button type="button" class="btn ic" title="Zeile löschen"${b.rows.length < 2 ? ' disabled' : ''}>${icon('x', 's')}</button>`);
      del.addEventListener('click', () => studio.change('Zeile gelöscht', () => b.rows.splice(r, 1), { inspector: true }));
      grid.appendChild(del);
    });
    const tools = htmlToElement('<div class="sd-acts" style="padding-top:8px"></div>');
    for (const [label, run, disabled] of [
      ['Zeile', () => studio.change('Zeile hinzugefügt', () => b.rows.push(Array(cols).fill('')), { inspector: true }), false],
      [
        'Spalte',
        () =>
          studio.change(
            'Spalte hinzugefügt',
            () => {
              b.head.push(`Spalte ${cols + 1}`);
              b.rows.forEach((r) => r.push(''));
              b.weights.push(1);
            },
            { inspector: true },
          ),
        cols >= 6,
      ],
      [
        'Spalte −',
        () =>
          studio.change(
            'Spalte gelöscht',
            () => {
              b.head.pop();
              b.rows.forEach((r) => r.pop());
              b.weights.pop();
            },
            { inspector: true },
          ),
        cols <= 1,
      ],
    ]) {
      const btn = htmlToElement(`<button type="button" class="btn outline"${disabled ? ' disabled' : ''}>${label.endsWith('−') ? '' : icon('plus', 's')}${label}</button>`);
      btn.addEventListener('click', run);
      tools.appendChild(btn);
    }
    const wrap = htmlToElement('<div></div>');
    wrap.append(grid, tools);
    return wrap;
  },
});

function catOf(section, cat) {
  const found = section.categories.find((c) => c.id === cat);
  return found ? found.color : cat;
}


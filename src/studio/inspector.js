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
  SHAPE_COLORS,
  SHAPE_TYPES,
  SYMBOLS,
  T,
  TONES,
  STRINGS,
  langsOf,
  projectSymbols,
  deviceOf,
  newUser,
  ROLES,
  sectionTitle,
  symbolInfo,
  symbolLabels,
  symbolNumber,
  symbolsInOrder,
  setSymbolNumber,
  appendToGroup,
  tx,
  uid,
} from './model.js';
import { thumbOf } from './thumbs.js';
import { QR_CAPTION_H, serialSources } from './overlays.js';
import { chapterLabels, referenceTargets } from './chapters.js';
import { sideOf } from './wiring.js';
import { color as safeColor } from './svg.js';
import { formatArea, formatLength, metersPerPt, pathLength, polygonArea, ratio, siteArea, toPt } from './geo.js';

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
  shape: 'Zeichnung',
  link: 'Richtfunk',
  photo: 'Foto',
  block: 'Baustein',
  overlay: 'Bild / QR-Code',
};

/** Vorschläge für Fernzugriff-Dienste (frei änderbar). */
const SERVICES = ['DDNS', 'Portfreigabe', 'VPN', 'Hersteller-Cloud', 'Fernwartung', 'Weboberfläche'];

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
      const kindTitle = sel.kind === 'shape' ? studio.shapeName(item) : KIND_TITLE[sel.kind];
      this.head.append(back, htmlToElement(`<span class="crumb"><small>${escapeHtml(sectionTitle(section))}</small>${escapeHtml(kindTitle)}</span>`));
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
    else if (sel.kind === 'shape') this.shapeForm(section, item);
    else if (sel.kind === 'link') this.linkForm(section, item);
    else if (sel.kind === 'photo') this.photoForm(section, item);
    else if (sel.kind === 'device') this.deviceForm(section, item);
    else if (sel.kind === 'wifi') this.wifiForm(section, item);
    else if (sel.kind === 'remote') this.remoteForm(section, item);
    else if (sel.kind === 'overlay') this.overlayForm(item);
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
    const manual = p.design === 'manual';
    const doc = this.group(
      'Dokument',
      this.bi(manual ? 'Titel (Produkt)' : 'Titel', p, 'title', manual ? { multiline: true, hint: p.lang === 'de+en' ? 'Englischer Titel erscheint als Untertitel. Zeilenumbruch mit Enter.' : 'Zeilenumbruch mit Enter.' } : {}),
      this.seg('Sprache', LANGS.map((l) => [l.id, l.id === 'de+en' ? 'Beide' : l.label]), p.lang, (v) => studio.setLang(v)),
    );
    if (!manual) doc.appendChild(this.seg('Schrift', FONTS.map((f) => [f.id, f.label]), p.font, (v) => studio.setFont(v)));
    // Gestaltung „Bedienungsanleitung“ (Deckblatt, Kapitelköpfe, Deutsch und Englisch nebeneinander)
    if (p.sections.some((x) => x.type === 'chapters'))
      doc.appendChild(this.seg('Gestaltung', [['classic', 'Klassisch'], ['manual', 'Bedienungsanleitung']], p.design || 'classic', (v) => studio.setDesign(v)));
    if (manual) this.manualCoverForm(p);
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
    company.append(
      this.text('Firmenname', p.company, 'name', { placeholder: 'Wird in der Kopfzeile jeder Seite gezeigt' }),
      this.bi('Zusatz', p.company, 'tagline', { placeholder: 'z. B. Fachgebiet oder Abteilung' }),
    );
    if (!manual) {
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
    // Eigene Vorlage: erscheint auf der Startseite unter „Neue Dokumentation“
    const save = htmlToElement(`<button type="button" class="btn outline sd-wide" data-a="tpl">${icon('binder', 's')}Als Vorlage speichern …</button>`);
    save.addEventListener('click', () => studio.saveAsTemplate());
    this.group('Vorlage', save, htmlToElement('<p class="sd-hint">Für weitere Kunden oder Projekte: neue Dokumentationen starten dann mit diesem Stand.</p>'));
  }

  /** Deckblatt der Bedienungsanleitung: Dokumentart, Foto, Ausführung, Hinweis, Farben. */
  manualCoverForm(p) {
    const studio = this.studio;
    const m = p.manual;
    const group = this.group('Deckblatt', this.bi('Dokumentart', m, 'kicker', { placeholder: 'Bedienungsanleitung' }));
    if (p.lang !== 'de+en') group.appendChild(this.bi('Untertitel', m, 'subtitle', { placeholder: 'optional' }));
    const img = m.cover && p.images[m.cover];
    if (img) group.appendChild(htmlToElement(`<img class="sd-photo" alt="Produktfoto" src="${escapeHtml(img.data)}">`));
    const acts = htmlToElement(
      `<div class="sd-acts" style="padding:0 0 10px"><button type="button" class="btn outline" data-a="pick">${icon('image', 's')}${img ? 'Anderes Foto …' : 'Produktfoto wählen …'}</button>${img ? `<button type="button" class="btn outline danger ic" data-a="del" title="Foto entfernen" aria-label="Foto entfernen">${icon('trash', 's')}</button>` : ''}</div>`,
    );
    acts.querySelector('[data-a="pick"]').addEventListener('click', () => studio.pickCover());
    acts.querySelector('[data-a="del"]')?.addEventListener('click', () => studio.change('Produktfoto entfernt', () => (m.cover = null), { inspector: true }));
    group.appendChild(acts);
    group.append(
      this.pair(this.bi('Feld', m, 'modelLabel', { placeholder: 'Ausführung' }), this.text('Ausführung', m, 'model', { placeholder: 'z. B. Typ 500' })),
      this.pair(this.text('Version', m, 'version', { placeholder: 'optional' }), this.text('Stand', m, 'date', { placeholder: 'z. B. 03/2026' })),
      this.bi('Hinweis unten rechts', m, 'note'),
      this.note('Logo und Firmenname stehen unter „Firma“.'),
    );
    const colors = htmlToElement('<div class="sd-two"></div>');
    for (const [key, labelText] of [['accent', 'Akzentfarbe'], ['accent2', 'Dokumentart']]) {
      const input = htmlToElement(`<input type="color" class="fld sd-color" value="${escapeHtml(m[key])}" aria-label="${labelText}">`);
      input.addEventListener('input', () => studio.change('Farbe geändert', () => (m[key] = input.value), { key: 'color:' + key }));
      colors.appendChild(this.field(labelText, input));
    }
    this.group('Farben', colors, this.note('Akzentfarbe: Kapitelnummern, Schritte, Hinweiskästen. Dokumentart: Linie und Schrift über dem Titel auf dem Deckblatt.'));
  }

  /** Positionen einer Abbildung: setzen, benennen, Seite wählen, entfernen; Legende und Text daneben. */
  marksForm(b) {
    const studio = this.studio;
    const nums = studio.markNumbers();
    const group = this.group(`Positionen (${b.marks.length})`);
    const arm = htmlToElement(`<button type="button" class="btn ${studio.armed === 'tool:mark:' + b.id ? 'primary' : 'outline'} sd-wide">${icon('plus', 's')}Positionen im Bild setzen</button>`);
    arm.addEventListener('click', () => (b.image ? studio.armMarks(b.id) : toast('Zuerst ein Bild wählen.', 'warn', 3000)));
    group.appendChild(arm);
    if (!b.marks.length) group.appendChild(this.note('Im Bild auf eine Stelle klicken: Die Nummer erscheint mit Hinweislinie am Rand, darunter entsteht die Legende. Punkt und Kreis lassen sich ziehen.'));
    b.marks.forEach((m, i) => {
      const box = htmlToElement(`<div class="sd-user sd-mark"><div class="sd-mark-h"><span class="sd-num">${escapeHtml(nums.get(m.id) || String(i + 1))}</span></div></div>`);
      box.append(
        this.bi('Bauteil', m, 'name', { id: m.id, placeholder: 'z. B. Deckel' }),
        this.bi('Beschreibung', m, 'desc', { id: 'd' + m.id, placeholder: 'optional' }),
        this.seg('Kreis', [['auto', 'Automatisch'], ['l', 'Links'], ['r', 'Rechts']], m.side, (v) =>
          studio.change('Seite geändert', () => {
            m.side = v;
            m.ly = null;
          }, { inspector: true }),
        ),
      );
      const del = htmlToElement(`<button type="button" class="btn ic sd-user-del" title="Position entfernen" aria-label="Position ${i + 1} entfernen">${icon('trash', 's')}</button>`);
      del.addEventListener('click', () => studio.change('Position entfernt', () => b.marks.splice(i, 1), { inspector: true }));
      box.appendChild(del);
      group.appendChild(box);
    });
    if (b.marks.length) group.appendChild(this.check('Legende zeigen', b.legend !== false, (v) => studio.change('Legende geändert', () => (b.legend = v))));
    if (b.width === 'side')
      this.group('Text neben der Abbildung', this.bi('Zwischentitel', b.aside, 'title', { id: 'at' + b.id }), this.bi('Text', b.aside, 'text', { id: 'ax' + b.id, multiline: true }));
  }

  /** Schritte mit Fotos: je Karte Foto, Titel, Text; hinzufügen, verschieben, entfernen. */
  cardsForm(group, b) {
    const studio = this.studio;
    b.items.forEach((c, i) => {
      const img = c.image && this.project.images[c.image];
      const box = htmlToElement(`<div class="sd-user sd-card"><div class="sd-mark-h"><span class="sd-num sq">${i + 1}</span></div></div>`);
      if (img) box.appendChild(htmlToElement(`<img class="sd-photo" alt="Foto" src="${escapeHtml(img.data)}">`));
      const acts = htmlToElement(
        `<div class="sd-acts" style="padding:0 0 8px"><button type="button" class="btn outline" data-a="pick">${icon('image', 's')}${img ? 'Anderes Foto …' : 'Foto wählen …'}</button></div>`,
      );
      acts.querySelector('button').addEventListener('click', () => studio.pickCardImage(c));
      box.append(
        acts,
        this.check('Foto füllt die Fläche', !!c.fill, (v) => studio.change('Foto geändert', () => (c.fill = v))),
        this.bi('Titel', c, 'title', { id: 't' + c.id }),
        this.bi('Text', c, 'text', { id: 'x' + c.id, multiline: true }),
      );
      const tools = htmlToElement(
        `<div class="sd-order"><button type="button" class="btn ic" title="Nach oben"${i === 0 ? ' disabled' : ''}>${icon('up', 's')}</button><button type="button" class="btn ic" title="Nach unten"${i === b.items.length - 1 ? ' disabled' : ''}>${icon('down', 's')}</button><button type="button" class="btn ic" title="Schritt entfernen" aria-label="Schritt ${i + 1} entfernen">${icon('trash', 's')}</button></div>`,
      );
      const [up, down, del] = tools.querySelectorAll('button');
      const move = (d) => studio.change('Reihenfolge geändert', () => b.items.splice(i + d, 0, ...b.items.splice(i, 1)), { inspector: true });
      up.addEventListener('click', () => move(-1));
      down.addEventListener('click', () => move(1));
      del.addEventListener('click', () => studio.change('Schritt entfernt', () => b.items.splice(i, 1), { inspector: true }));
      box.appendChild(tools);
      group.appendChild(box);
    });
    group.appendChild(this.addButton('Schritt hinzufügen', () => studio.addCard(b)));
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
    // Seitenformat je Abschnitt (Kapitel im Stil der Bedienungsanleitung bleiben hoch)
    const first = this.body.querySelector('.sd-grp');
    if (first && section.type !== 'cover' && section.type !== 'toc' && !(section.type === 'chapters' && this.project.design === 'manual'))
      first.appendChild(this.seg('Seite', [[false, 'Hochformat'], [true, 'Querformat']], !!section.landscape, (v) => studio.setLandscape(section, v)));
    this.actions(['Abschnitt entfernen', 'trash', () => studio.removeSection(section.id), true]);
  }

  wiringForm(s) {
    const studio = this.studio;
    const lang = langsOf(this.project)[0];
    this.group('Anschlussplan', this.bi('Anlage', s, 'system', { placeholder: 'z. B. Torsteuerung Halle 2' }));
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
    const pins = this.group(
      `Anschlüsse (${s.hub.pins.length})`,
      this.rows(s.hub.pins, {
        empty: 'Noch kein Anschluss.',
        render: (p) => `<b class="pin">${escapeHtml(p.name || '–')}</b><span class="t">${escapeHtml(tx(p.func, lang))}</span>`,
        onOpen: (p) => studio.select({ kind: 'pin', id: p.id, section: s.id }, { reveal: true }),
      }),
    );
    const hints = this.group(
      `Hinweise (${s.hints.length})`,
      this.rows(s.hints, {
        empty: 'Noch kein Hinweis.',
        render: (h) =>
          `<i class="dot" style="background:${safeColor(catOf(s, h.cat))}"></i><span class="t">${escapeHtml(tx(h.title, lang) || 'Ohne Titel')}</span>`,
        onOpen: (h) => studio.select({ kind: 'hint', id: h.id, section: s.id }, { reveal: true }),
      }),
    );
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
        hint: 'Für die Überschrift des Klemmenplans, z. B. „Zentrale“.',
      }),
      this.bi('Typ', s.hub, 'model', { id: 'hubmodel' + s.id, placeholder: 'Hersteller und Modell' }),
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
    this.group(
      `Anschlüsse (${own.length})`,
      this.rows(own, {
        empty: 'Mit der Steuerung noch nicht verbunden.',
        render: (p) => `<b class="pin">${escapeHtml(p.name || '–')}</b><span class="t">${escapeHtml(tx(p.terminal, lang) || tx(p.func, lang))}</span>`,
        onOpen: (p) => studio.select({ kind: 'pin', id: p.id, section: s.id }, { reveal: true }),
      }),
    );
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
      this.text('Pin', pin, 'name', { id: 'pin' + pin.id, placeholder: 'z. B. E1' }),
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
      this.bi('Angeschlossen an', pin, 'terminal', { placeholder: 'z. B. Klemme 1' }),
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
        'Sonst erscheinen Punkte. Beim Erstellen der PDF fragt PlantPDF noch einmal nach.',
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
        onOpen: (d) => studio.select({ kind: 'device', id: d.id, section: s.id }, { reveal: true, pulse: true }),
      }),
    );
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
    const remote = this.group(
      `Fernzugriff (${s.remote.length})`,
      this.rows(s.remote, {
        empty: 'Noch kein Fernzugriff.',
        render: (r) => `<span class="t">${escapeHtml(r.service || 'Ohne Namen')}</span><small class="mono">${escapeHtml(r.address || '')}</small>`,
        onOpen: (r) => studio.select({ kind: 'remote', id: r.id, section: s.id }, { reveal: true }),
      }),
    );
  },

  /**
   * Benutzer eines Geräts: der erste in user/password/role, weitere in `users`. Je Benutzer Name,
   * Passwort und Rolle; „Benutzer hinzufügen“ und Entfernen.
   */
  usersEditor(group, d) {
    const studio = this.studio;
    const list = [d, ...d.users];
    if (!document.getElementById('sdRoles'))
      document.body.appendChild(htmlToElement(`<datalist id="sdRoles">${ROLES.map((r) => `<option value="${escapeHtml(r)}">`).join('')}</datalist>`));
    group.appendChild(htmlToElement(`<span class="sd-l sd-users-h">Benutzer (${list.filter((u) => u.user || u.password).length || 0})</span>`));
    list.forEach((u, i) => {
      const row = htmlToElement('<div class="sd-user"></div>');
      const name = this.mono('Benutzer', u, 'user', { id: `u${i}${d.id}`, placeholder: i ? '' : 'admin' });
      const role = this.text('Rolle', u, 'role', { id: `r${i}${d.id}`, placeholder: 'z. B. Administrator' });
      role.querySelector('input').setAttribute('list', 'sdRoles');
      const pass = this.secret('Passwort', u, 'password');
      pass.querySelector('input').dataset.f = `p${i}${d.id}`;
      row.append(this.pair(name, pass), role);
      if (i > 0 || d.users.length) {
        const del = htmlToElement(`<button type="button" class="btn ic sd-user-del" title="Benutzer entfernen" aria-label="Benutzer ${escapeHtml(u.user || String(i + 1))} entfernen">${icon('trash', 's')}</button>`);
        del.addEventListener('click', () =>
          studio.change(
            'Benutzer entfernt',
            () => {
              if (i > 0) d.users.splice(i - 1, 1);
              else {
                // erster Benutzer: der nächste rückt nach
                const next = d.users.shift();
                Object.assign(d, { user: next.user, password: next.password, role: next.role });
              }
            },
            { inspector: true },
          ),
        );
        row.appendChild(del);
      }
      group.appendChild(row);
    });
    // gut sichtbarer Knopf direkt unter den Benutzern; danach gleich den Namen eintippen
    const add = htmlToElement(`<button type="button" class="btn outline sd-wide sd-user-add">${icon('plus', 's')}Weiteren Benutzer hinzufügen</button>`);
    add.addEventListener('click', () => {
      const user = newUser();
      studio.change('Benutzer hinzugefügt', () => d.users.push(user), { inspector: true });
      setTimeout(() => {
        const input = document.querySelector(`[data-f="u${d.users.length}${d.id}"]`);
        if (input) input.focus();
      }, 0);
    });
    group.appendChild(add);
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
    const studio = this.studio;
    // verknüpft mit dem Lageplan: Name kommt vom Symbol und wird dort mitgeändert
    const found = d.sym && studio.findSymbol(d.sym);
    const group = this.group(
      'Zugang',
      found
        ? this.bi('Gerät', found.y, 'name', { placeholder: tx(d.name, 'de'), id: 'dn' + d.id })
        : this.bi('Gerät', d, 'name', { placeholder: 'z. B. Rekorder (NVR)' }),
      this.pair(this.mono('IP-Adresse', d, 'ip', { placeholder: '192.168.1.20' }), this.mono('Port / Web', d, 'web', { placeholder: '443 / https://…' })),
    );
    if (found) {
      group.prepend(htmlToElement(`<div class="sd-linked">${icon('map', 's')}<span>Verknüpft mit <b>${escapeHtml(found.label)}</b> im Lageplan</span></div>`));
      const show = htmlToElement(`<button type="button" class="btn sd-linkbtn">Im Lageplan zeigen</button>`);
      show.addEventListener('click', () => studio.select({ kind: 'sym', id: found.y.id, section: found.s.id }, { reveal: true, pulse: true }));
      group.firstElementChild.appendChild(show);
    }
    this.usersEditor(group, d);
    group.appendChild(this.bi('Bemerkung', d, 'note'));
    this.group(
      'Gerätedaten',
      this.text('Hersteller / Typ', d, 'model', { placeholder: 'Hersteller und Modell' }),
      this.pair(this.mono('Seriennummer', d, 'serial'), this.mono('MAC-Adresse', d, 'mac', { placeholder: 'AA:BB:CC:DD:EE:FF' })),
      this.pair(this.mono('Firmware', d, 'firmware'), this.bi('Standort', d, 'location')),
    );
    this.itemActions(s.devices, d);
  },

  wifiForm(s, w) {
    const studio = this.studio;
    // WLAN einer Richtfunkstrecke: SSID und Schlüssel gehören der Strecke
    const found = w.link && studio.findLink(w.link);
    const src = found ? found.l : w;
    const group = this.group(
      'WLAN',
      this.mono('WLAN-Name (SSID)', src, 'ssid'),
      this.secret('Schlüssel', src, 'key'),
      this.select(
        'Verschlüsselung',
        ['WPA2', 'WPA3', 'WPA2/WPA3', 'WPA', 'WEP', 'Offen'].map((v) => [v, v]),
        w.security,
        (v) => studio.change('Verschlüsselung geändert', () => (w.security = v)),
      ),
      this.bi('Bemerkung', w, 'note', { placeholder: 'z. B. Gäste-WLAN, 2,4 GHz' }),
    );
    if (found) {
      const head = htmlToElement(`<div class="sd-linked">${icon('wifi', 's')}<span>Gehört zur Richtfunkstrecke <b>${escapeHtml(found.title)}</b></span></div>`);
      const show = htmlToElement(`<button type="button" class="btn sd-linkbtn">Strecke zeigen</button>`);
      show.addEventListener('click', () => studio.select({ kind: 'link', id: found.l.id, section: found.s.id }, { reveal: true, pulse: true }));
      head.appendChild(show);
      group.prepend(head);
    }
    this.itemActions(s.wifi, w);
  },

  remoteForm(s, r) {
    const service = this.text('Dienst', r, 'service', { placeholder: 'z. B. DDNS, VPN, Portfreigabe' });
    const list = htmlToElement(`<datalist id="sdServices">${SERVICES.map((v) => `<option value="${escapeHtml(v)}">`).join('')}</datalist>`);
    service.querySelector('input').setAttribute('list', 'sdServices');
    service.appendChild(list);
    this.group(
      'Fernzugriff',
      service,
      this.mono('Adresse / ID', r, 'address', { placeholder: 'z. B. name.ddns.net:8443 oder Geräte-ID' }),
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
    const labels = symbolLabels(s, this.project);
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
        `<div class="sd-thumbrow">${img ? `<img alt="Hintergrund" src="${escapeHtml(img.data)}">` : `<span class="sd-empty" style="padding:0">Noch kein Bild – Luftbild, Karte oder Grundriss wählen, auch eine Seite aus einer PDF.</span>`}</div>`,
      ),
    );
    // Bild wählen, Seite einer PDF, Entfernen – nur hier (nicht im Werkzeugband)
    const pick = htmlToElement(
      `<div class="sd-acts sd-bg-acts"><button type="button" class="btn outline" data-bg="image">${icon('image', 's')}${img ? 'Anderes Bild …' : 'Bild wählen …'}</button><button type="button" class="btn outline" data-bg="pdf">${icon('file', 's')}Aus PDF-Seite …</button>${img ? `<button type="button" class="btn outline danger ic" data-bg="remove" title="Hintergrund entfernen" aria-label="Hintergrund entfernen">${icon('trash', 's')}</button>` : ''}</div>`,
    );
    for (const b of pick.querySelectorAll('button'))
      b.addEventListener('click', () => {
        if (b.dataset.bg === 'image') studio.pickBackground(s);
        else if (b.dataset.bg === 'pdf') studio.pickBackgroundPdf(s);
        else studio.change('Hintergrund entfernt', () => (s.bg.image = null), { inspector: true });
      });
    bg.appendChild(pick);
    if (img) {
      bg.appendChild(
        this.seg('Drehung', [[0, '0°'], [90, '90°'], [180, '180°'], [270, '270°']], s.bg.rotate, (v) =>
          {
          studio.change('Hintergrund gedreht', () => (s.bg.rotate = v), { inspector: true });
          studio.checkScale(s);
        },
        ),
      );
      bg.appendChild(
        this.seg('Darstellung', [['contain', 'Einpassen'], ['cover', 'Füllen']], s.bg.fit, (v) =>
          {
          studio.change('Hintergrund geändert', () => (s.bg.fit = v), { inspector: true });
          studio.checkScale(s);
        },
        ),
      );
      bg.appendChild(this.slider('Aufhellen', s.bg, 'fade', { min: 0, max: 80, scale: 100, unit: '%' }));
    }
    // Maßstab: Bezugsstrecke im Plan ziehen, Länge eingeben
    const mpp = metersPerPt(s);
    if (!s.scale)
      this.group(
        'Maßstab',
        this.note('Noch kein Maßstab. Ziehe eine Strecke, deren Länge du kennst (z. B. von Haus A zu Haus B), und gib ihre Länge ein – danach stehen Längen und Flächen in Metern im Plan.'),
        this.addButton('Maßstab festlegen', () => studio.arm('tool:scale')),
      );
    else {
      const ref = this.field('Bezugsstrecke (m)', this.number(s.scale.m, (v) => studio.change('Maßstab geändert', () => (s.scale.m = v), { key: 'scale:' + s.id }), { min: 0.01, step: 0.01, id: 'scale' }));
      const acts = htmlToElement(`<div class="sd-acts" style="padding-top:8px"><button type="button" class="btn outline">${icon('ruler', 's')}Neu ziehen</button><button type="button" class="btn outline danger">${icon('trash', 's')}Entfernen</button></div>`);
      const [again, remove] = acts.querySelectorAll('button');
      again.addEventListener('click', () => studio.arm('tool:scale'));
      remove.addEventListener('click', () => studio.change('Maßstab entfernt', () => (s.scale = null), { inspector: true }));
      this.group(
        'Maßstab',
        ref,
        this.note(`1 : ${ratio(mpp).toLocaleString('de-DE')} auf der gedruckten Seite. Die Bezugsstrecke ist gestrichelt im Plan zu sehen (nur hier, nicht in der PDF).`),
        this.check('Maßstabsleiste im Plan', s.scaleBar, (v) => studio.change('Maßstabsleiste geändert', () => (s.scaleBar = v))),
        acts,
      );
    }
    // Symbole setzen: Galerie „Objekt“ im Werkzeugband (dort auch eigene Symbole hochladen)
    for (const c of s.custom) {
      const code = this.text('Kürzel', c, 'code', { id: 'cc' + c.id, placeholder: 'ES', hint: 'Steht vor der Nummer, z. B. „ES 1“.' });
      code.querySelector('input').maxLength = 6;
      const remove = htmlToElement(`<div class="sd-acts" style="padding-top:8px"><button type="button" class="btn outline danger">${icon('trash', 's')}Entfernen</button></div>`);
      remove.querySelector('button').addEventListener('click', () => studio.removeCustom(s, c.id));
      this.group(`Eigenes Symbol · ${tx(c.name, lang) || c.code}`, this.bi('Bezeichnung', c, 'name', { id: 'cn' + c.id }), code, remove);
    }
    this.group(
      `Im Plan (${s.symbols.length})`,
      this.rows(symbolsInOrder(s), {
        empty: 'Noch kein Symbol gesetzt.',
        render: (y) => {
          const info = symbolInfo(s, y.kind);
          return `<b class="pin">${escapeHtml(labels.get(y.id) || '')}</b><span class="t">${escapeHtml(tx(y.name, lang) || (info ? tx(info.name, lang) : ''))}</span>`;
        },
        onOpen: (y) => studio.select({ kind: 'sym', id: y.id, section: s.id }, { reveal: true, pulse: true }),
      }),
    );
    if (s.symbols.length > 1) {
      const renumber = htmlToElement(`<button type="button" class="btn outline sd-wide" data-a="renumber">${icon('list', 's')}Neu nummerieren nach Lage</button>`);
      renumber.addEventListener('click', () => studio.renumberSite(s));
      this.group(
        'Nummerierung',
        renumber,
        this.note('Je Art zeilenweise von links oben nach rechts unten. Eine einzelne Nummer ändert man am Symbol – die anderen rücken nach.'),
      );
    }
    this.thinGroup(s);
    if (s.links.length)
      this.group(
        `Richtfunk (${s.links.length})`,
        this.rows(s.links, {
          render: (l) => `<span class="t">${escapeHtml(linkTitle(s, l, labels))}</span><small>${escapeHtml(l.band || '')}</small>`,
          onOpen: (l) => studio.select({ kind: 'link', id: l.id, section: s.id }, { reveal: true, pulse: true }),
        }),
      );
    if (s.shapes.length)
      this.group(
        `Zeichnungen (${s.shapes.length})`,
        this.rows(s.shapes, {
          render: (z) => `<i class="sd-dot" style="background:${safeColor(z.color)}"></i><span class="t">${escapeHtml(tx(z.name, lang) || studio.shapeName(z))}</span><small>${escapeHtml(mpp ? shapeMeasure(z, mpp, s) : '')}</small>`,
          onOpen: (z) => studio.select({ kind: 'shape', id: z.id, section: s.id }, { reveal: true, pulse: true }),
        }),
      );
  },

  /** „Darstellung“: Deckkraft, Ebene; bei Symbolen Beschriftung und Erfassungsbereich als Umriss. */
  lookGroup(obj, kind, cone = false) {
    const studio = this.studio;
    const group = this.group(
      'Darstellung',
      this.seg('Deckkraft', [[0, '100 %'], [0.4, '60 %'], [0.7, '30 %']], obj.fade || 0, (v) => studio.setFade(v)),
    );
    const layers = htmlToElement(
      `<div class="sd-layers" role="group" aria-label="Ebene">${[
        ['back', 'In den Hintergrund', 'Ganz hinten'],
        ['backward', 'Eine Ebene nach hinten (Strg+Umschalt+↓)', 'Hinten'],
        ['forward', 'Eine Ebene nach vorne (Strg+Umschalt+↑)', 'Vorne'],
        ['front', 'In den Vordergrund', 'Ganz vorne'],
      ]
        .map(([to, title, text]) => `<button type="button" class="btn outline" data-to="${to}" title="${title}">${text}</button>`)
        .join('')}</div>`,
    );
    for (const b of layers.querySelectorAll('button')) b.addEventListener('click', () => studio.moveLayer(b.dataset.to));
    group.appendChild(this.field('Ebene', layers));
    if (kind === 'sym') {
      group.appendChild(
        this.select(
          'Beschriftung',
          [['auto', 'Automatisch'], ['right', 'Rechts'], ['left', 'Links'], ['top', 'Oben'], ['bottom', 'Unten'], ['none', 'Keine']],
          obj.labelPos || 'auto',
          (v) =>
            studio.change('Beschriftung geändert', () => {
              if (v && v !== 'auto') obj.labelPos = v;
              else delete obj.labelPos;
            }),
        ),
      );
      if (cone)
        group.appendChild(
          this.check('Erfassungsbereich nur als Umriss', obj.cone === 'outline', (v) =>
            studio.change('Erfassungsbereich geändert', () => {
              if (v) obj.cone = 'outline';
              else delete obj.cone;
            }),
          ),
        );
    }
  },

  /** „Plan ausdünnen“: ganze Arten blass oder aus (die Legende bleibt vollständig). */
  thinGroup(s) {
    const studio = this.studio;
    const lang = langsOf(this.project)[0];
    const kinds = [];
    const seen = new Set();
    const add = (key, name) => !seen.has(key) && (seen.add(key), kinds.push([key, name]));
    for (const y of s.symbols) {
      const info = symbolInfo(s, y.kind);
      if (info) add(y.kind, tx(info.name, lang));
    }
    if (s.links.length) add('link', 'Richtfunkstrecken');
    for (const z of s.shapes) add(z.closed ? 'zone' : z.type, tx(SHAPE_TYPES[z.closed ? 'zone' : z.type], lang));
    if (kinds.length < 2) return;
    const group = this.group('Plan ausdünnen');
    group.appendChild(this.note('Arten blass stellen oder ausblenden, damit Wichtiges hervortritt. Die Legende bleibt vollständig.'));
    for (const [key, name] of kinds)
      group.appendChild(
        this.seg(name, [['', 'Normal'], ['faded', 'Blass'], ['hidden', 'Aus']], (s.thin || {})[key] || '', (v) =>
          studio.change(
            'Plan ausgedünnt',
            () => {
              s.thin ||= {};
              if (v) s.thin[key] = v;
              else delete s.thin[key];
            },
            { inspector: true },
          ),
        ),
      );
  },

  /** Zahl (z. B. Meter); leere oder ungültige Eingaben ändern nichts. */
  number(value, onSet, { min = 0, step = 1, id = '' } = {}) {
    const el = htmlToElement(`<input class="fld num" type="number" min="${min}" step="${step}" value="${value}" data-f="${escapeHtml(id)}" style="width:110px">`);
    el.addEventListener('input', () => {
      const v = Number(el.value);
      if (Number.isFinite(v) && v >= min && v > 0) onSet(v);
    });
    el.addEventListener('keydown', (ev) => ev.key === 'Enter' && el.blur());
    return el;
  },

  /** Farbwahl für Zeichnungen (Punkte wie in Vorschau/Office). */
  swatches(current, onPick) {
    const el = htmlToElement('<div class="sd-swatches" role="radiogroup" aria-label="Farbe"></div>');
    for (const [c, name] of SHAPE_COLORS) {
      const b = htmlToElement(`<button type="button" role="radio" aria-checked="${c === current}" aria-label="${name}" class="${c === current ? 'on' : ''}" title="${name}" style="--c:${c}"></button>`);
      b.addEventListener('click', () => c !== current && onPick(c));
      el.appendChild(b);
    }
    const custom = htmlToElement(`<label class="sd-swatch-custom" title="Eigene Farbe"><input type="color" value="${safeColor(current, '#1d4ed8')}" aria-label="Eigene Farbe"></label>`);
    custom.querySelector('input').addEventListener('change', (ev) => onPick(ev.target.value));
    el.appendChild(custom);
    return this.field('Farbe', el);
  },

  shapeForm(s, z) {
    const studio = this.studio;
    const mpp = metersPerPt(s);
    const group = this.group(studio.shapeName(z));
    if (z.type === 'fence')
      group.append(
        this.bi('Bezeichnung', z, 'name', { placeholder: z.closed ? 'z. B. Zone 1 – Lager' : 'z. B. Zaun Nord' }),
        this.check('Als Zone schließen', z.closed, (v) => studio.change(v ? 'Zone geschlossen' : 'Zone geöffnet', () => (z.closed = v), { inspector: true }), z.pts.length < 3 ? 'Braucht mindestens drei Eckpunkte.' : 'Fläche wird leicht eingefärbt; Name und Fläche stehen in der Mitte.'),
      );
    else group.append(this.bi('Bezeichnung', z, 'name', { placeholder: 'optional' }));
    if (z.type === 'fence' && z.pts.length < 3) group.querySelector('.sd-check input').disabled = true;
    group.append(
      this.swatches(z.color, (c) => {
        // nächste Zeichnung dieser Art in derselben Farbe
        if (z.type === 'fence') studio.fenceColor = c;
        else studio.shapeColor = c;
        studio.change('Farbe geändert', () => (z.color = c), { inspector: true });
      }),
    );
    if (mpp) {
      group.append(this.field(z.closed ? 'Umfang · Fläche' : 'Länge', htmlToElement(`<span class="sd-val">${escapeHtml(shapeMeasure(z, mpp, s))}</span>`)));
      if (z.type !== 'dim')
        group.append(this.check(z.closed ? 'Fläche im Plan zeigen' : 'Länge im Plan zeigen', z.showLen, (v) => studio.change('Anzeige geändert', () => (z.showLen = v))));
    } else group.append(this.note('Längen in Metern erscheinen, sobald der Lageplan einen Maßstab hat.'));
    if (z.type !== 'free') group.append(this.note('Eckpunkte im Plan ziehen; die ganze Zeichnung an der Linie verschieben.'));
    this.lookGroup(z, 'shape');
    this.actions(['Löschen', 'trash', () => studio.removeSelected(), true]);
  },

  linkForm(s, l) {
    const studio = this.studio;
    const labels = symbolLabels(s, this.project);
    const mpp = metersPerPt(s);
    const group = this.group(linkTitle(s, l, labels));
    group.append(
      this.seg('Art', [['ptp', 'Punkt-zu-Punkt'], ['ptmp', 'Mehrpunkt']], l.mode, (v) => {
        if (v === 'ptp' && l.to.length > 1) return toast('Erst Gegenstellen entfernen – Punkt-zu-Punkt hat genau eine.', 'warn', 4000);
        studio.change('Art geändert', () => (l.mode = v), { inspector: true });
      }),
      this.text('Frequenz / Band', l, 'band', { placeholder: 'z. B. 5 GHz' }),
      this.text('SSID', l, 'ssid', { placeholder: 'optional' }),
      this.secret('WLAN-Schlüssel', l, 'key'),
    );
    if (!document.getElementById('sdBands'))
      document.body.appendChild(htmlToElement('<datalist id="sdBands"><option value="2,4 GHz"><option value="5 GHz"><option value="6 GHz"><option value="24 GHz"><option value="60 GHz"></datalist>'));
    group.querySelector('[data-f^="t:band"]')?.setAttribute('list', 'sdBands');
    const byId = new Map(s.symbols.map((y) => [y.id, y]));
    const dist = (a, b) => (mpp && a && b ? formatLength(Math.hypot(...[0, 1].map((k) => toPt([a.x, a.y], siteArea(s))[k] - toPt([b.x, b.y], siteArea(s))[k])) * mpp) : '');
    const rows = [{ id: l.from, role: l.mode === 'ptmp' ? 'Basis' : 'Station A', len: '' }, ...l.to.map((t, i) => ({ id: t, role: l.mode === 'ptmp' ? 'Gegenstelle' : 'Station B', len: dist(byId.get(l.from), byId.get(t)), i }))];
    const stations = this.group(
      'Stationen',
      this.rows(rows, {
        render: (r) => {
          const y = byId.get(r.id);
          return `<b class="pin">${escapeHtml(labels.get(r.id) || '')}</b><span class="t">${escapeHtml(r.role)}${y && y.ip ? ' · ' + escapeHtml(y.ip) : ''}</span><small>${escapeHtml(r.len)}</small>`;
        },
        onOpen: (r) => studio.select({ kind: 'sym', id: r.id, section: s.id }, { reveal: true, pulse: true }),
      }),
    );
    if (l.mode === 'ptmp') stations.appendChild(this.addButton('Gegenstelle hinzufügen', () => studio.arm('tool:add:' + l.id)));
    stations.appendChild(this.note('IP-Adressen stehen bei der jeweiligen Antenne. Antennen lassen sich im Plan verschieben – die Strecke folgt.'));
    this.lookGroup(l, 'link');
    this.actions(['Strecke löschen', 'trash', () => studio.removeSelected(), true]);
  },

  /** Freies Bild bzw. QR-Code: Quelle, Beschriftung, Größe, Löschen. */
  overlayForm(o) {
    const studio = this.studio;
    const lang = langsOf(this.project)[0];
    const size = this.number(Math.round(o.w), (v) =>
      studio.change('Größe geändert', () => {
        const cap = o.kind === 'qr' && o.caption ? QR_CAPTION_H : 0;
        const k = v / o.w;
        o.w = v;
        o.h = o.kind === 'qr' ? v + cap : Math.round(o.h * k);
      }),
      { min: 24, id: 'ow' + o.id },
    );
    if (o.kind === 'image') {
      const swap = htmlToElement(`<button type="button" class="btn outline">${icon('image', 's')}Anderes Bild …</button>`);
      swap.addEventListener('click', () => studio.replaceOverlayImage(o));
      this.group('Bild', this.field('Breite (pt)', size, 'Ziehen am Griff unten rechts ändert die Größe; Pfeiltasten verschieben.'), swap);
    } else {
      const sources = serialSources(this.project, lang);
      const options = [['', 'Eigener Text'], ...sources.map((d) => [d.id, `${d.name || 'Gerät'} – SN ${d.serial}`])];
      const group = this.group(
        'QR-Code',
        this.select('Inhalt', options, o.src || '', (v) => studio.change('QR-Code geändert', () => (o.src = v || null), { inspector: true })),
      );
      if (!o.src) group.appendChild(this.text('Text', o, 'text', { placeholder: 'z. B. Seriennummer für die App' }));
      if (!sources.length) group.appendChild(this.note('Geräte mit Seriennummer (Zugangsdaten › Gerätedaten) erscheinen hier zur Auswahl – der QR-Code folgt dann automatisch.'));
      group.append(
        this.check('Beschriftung unter dem Code', o.caption, (v) =>
          studio.change('Beschriftung geändert', () => {
            o.caption = v;
            o.h = o.w + (v ? QR_CAPTION_H : 0);
          }, { inspector: true }),
        ),
        this.field('Breite (pt)', size),
      );
    }
    this.actions(['Löschen', 'trash', () => studio.removeSelected(), true]);
  },

  /** Meldegruppenmodul: Zahl der Meldegruppen (MGM 2, MGM 5 oder eigene Zahl) – bestimmt das Kürzel. */
  mgmField(s, y) {
    const studio = this.studio;
    const set = (v) =>
      studio.change(
        `Typ: MGM ${v}`,
        () => {
          y.groups = v;
          appendToGroup(s, y); // im neuen Typ hinten anstellen
        },
        { inspector: true },
      );
    const other = y.groups !== 2 && y.groups !== 5;
    const box = htmlToElement('<div></div>');
    box.appendChild(this.seg('Typ', [[2, 'MGM 2'], [5, 'MGM 5'], ['x', 'Andere']], other ? 'x' : y.groups, (v) => set(v === 'x' ? 1 : v)));
    if (other) {
      const input = htmlToElement(`<input class="fld num" type="number" min="1" max="99" step="1" value="${y.groups}" aria-label="Meldegruppen" style="width:80px">`);
      input.addEventListener('change', () => {
        const v = Math.round(Number(input.value));
        if (Number.isFinite(v) && v >= 1 && v <= 99 && v !== y.groups) set(v);
        else input.value = y.groups;
      });
      box.appendChild(this.field('Meldegruppen', input, 'Bezeichnung im Plan: MGM-Anzahl-Nummer, z. B. MGM-8-1.'));
    }
    return box;
  },

  /** Nummer eines Symbols ändern: Kürzel, Zahl (1 … Anzahl), die übrigen rücken nach. */
  symNumberField(s, y, nr) {
    const studio = this.studio;
    const box = htmlToElement(
      `<div class="sd-nr"><span class="sd-nr-code">${escapeHtml(nr.code)}${nr.sep === '-' ? '-' : ''}</span><input class="fld num" type="number" min="${nr.first}" max="${nr.last}" step="1" value="${nr.n}" data-f="nr${y.id}" aria-label="Nummer"><span class="sd-nr-of">${nr.first === 1 ? `von ${nr.last}` : `${nr.first} bis ${nr.last}`}</span></div>`,
    );
    const input = box.querySelector('input');
    const commit = () => {
      const v = Math.round(Number(input.value));
      if (!Number.isFinite(v) || v < 1) return void (input.value = nr.n);
      // bei mehreren Lageplänen: nur innerhalb des Bereichs dieses Plans
      const n = Math.max(nr.first, Math.min(nr.last, v));
      if (n === nr.n) return void (input.value = nr.n);
      studio.change(`Nummer geändert: ${nr.code}${nr.sep}${nr.n} → ${nr.code}${nr.sep}${n}`, () => setSymbolNumber(s, y, n - nr.first + 1), { inspector: true });
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') input.blur();
      if (ev.key === 'Escape') ((input.value = nr.n), input.blur());
    });
    return this.field('Nummer', box, nr.first === 1 ? 'Andere Symbole dieser Art rücken nach.' : 'Andere Symbole dieser Art rücken nach. Die Nummern zählen über alle Lagepläne durch.');
  },

  symForm(s, y) {
    const studio = this.studio;
    const lang = langsOf(this.project)[0];
    const info = symbolInfo(s, y.kind);
    const labels = symbolLabels(s, this.project);
    const mpp = metersPerPt(s);
    // Antennen gehören zu Strecken: Art nur unter den übrigen Symbolen wechseln
    const kinds = [...SYMBOLS.filter((k) => !k.link || k.id === y.kind).map((k) => [k.id, tx(k.name, lang)]), ...s.custom.map((c) => ['custom:' + c.id, tx(c.name, lang)])];
    const nr = symbolNumber(s, y, this.project);
    this.group(
      `${labels.get(y.id) || 'Symbol'}`,
      nr && nr.count > 1 ? this.symNumberField(s, y, nr) : null,
      this.bi('Bezeichnung', y, 'name', { placeholder: info ? tx(info.name, lang) : '' }),
      this.bi('Bemerkung', y, 'note'),
      this.select('Art', kinds, y.kind, (v) =>
        studio.change(
          'Art geändert',
          () => {
            const next = symbolInfo(s, v);
            y.kind = v;
            appendToGroup(s, y); // in der neuen Art hinten anstellen
            y.fov = !!(next && next.fov);
            if (next && next.fov) {
              y.angle = next.fov.angle;
              y.range = next.fov.range;
            }
          },
          { inspector: true },
        ),
      ),
      y.kind === 'mgm' ? this.mgmField(s, y) : null,
      this.seg('Größe', [[0.75, 'Klein'], [1, 'Mittel'], [1.5, 'Groß']], y.scale, (v) =>
        studio.change('Größe geändert', () => (y.scale = v), { inspector: true }),
      ),
    );
    // Netzwerkgerät: Zugang (IP, Benutzer) – dieselben Daten wie unter Zugangsdaten
    const dev = deviceOf(this.project, y.id);
    if (dev) {
      const acc = this.project.sections.find((x) => x.type === 'access' && x.devices.includes(dev));
      const group = this.group(
        'Zugang',
        this.pair(this.mono('IP-Adresse', dev, 'ip', { id: 'ip' + dev.id, placeholder: '192.168.1.20' }), this.mono('Port / Web', dev, 'web', { id: 'web' + dev.id, placeholder: '443' })),
      );
      this.usersEditor(group, dev);
      group.appendChild(this.note('Steht genauso unter „Zugangsdaten › Geräte-Zugänge“ – Änderungen gelten an beiden Stellen.'));
      const show = htmlToElement(`<button type="button" class="btn sd-link">${icon('right', 's')}In Zugangsdaten zeigen</button>`);
      show.addEventListener('click', () => studio.select({ kind: 'device', id: dev.id, section: acc.id }, { reveal: true, pulse: true }));
      group.appendChild(show);
    }
    if (y.kind === 'radio') {
      const links = s.links.filter((l) => l.from === y.id || l.to.includes(y.id));
      this.group(
        'Richtfunk',
        this.rows(links, {
          empty: 'Gehört zu keiner Strecke.',
          render: (l) => `<span class="t">${escapeHtml(linkTitle(s, l, labels))}</span><small>${escapeHtml(l.band || '')}</small>`,
          onOpen: (l) => studio.select({ kind: 'link', id: l.id, section: s.id }, { reveal: true, pulse: true }),
        }),
      );
    }
    if (info && info.fov) {
      const group = this.group(
        'Erfassungsbereich',
        this.check('Erfassungsbereich zeigen', y.fov, (v) => studio.change('Erfassungsbereich geändert', () => (y.fov = v), { inspector: true })),
      );
      if (y.fov)
        group.append(
          this.slider('Blickrichtung', y, 'dir', { min: 0, max: 359, unit: '°' }),
          this.slider('Öffnungswinkel', y, 'angle', { min: 10, max: 360, unit: '°' }),
          mpp
            ? this.slider('Reichweite', y, 'range', { min: round1(20 * mpp), max: round1(600 * mpp), step: 0.1, scale: mpp, unit: 'm' })
            : this.slider('Reichweite', y, 'range', { min: 20, max: 400, unit: 'pt' }),
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
    this.lookGroup(y, 'sym', info && info.fov && y.fov);
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
          return `${img ? `<img alt="" data-img="${escapeHtml(p.image)}" style="width:34px;height:26px;object-fit:cover;border-radius:3px;flex:none;background:var(--line2)">` : ''}<span class="t">${escapeHtml(tx(p.caption, lang) || 'Ohne Unterschrift')}</span><small>${escapeHtml(p.date || '')}</small>`;
        },
        onOpen: (p) => studio.select({ kind: 'photo', id: p.id, section: s.id }, { reveal: true }),
      }),
    );
    for (const el of list.querySelectorAll('img[data-img]'))
      thumbOf(this.project.images[el.dataset.img]).then((url) => url && el.isConnected && (el.src = url));
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
    this.group(
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
    this.actions(['Suchen und Ersetzen', 'replace', () => studio.replaceDialog()]);
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
        this.seg('Ebene', [[1, 'Kapitel'], [2, 'Unterkapitel'], ...(this.project.design === 'manual' ? [[3, 'Zwischentitel']] : [])], b.level, (v) =>
          studio.change('Ebene geändert', () => (b.level = v), { inspector: true }),
        ),
      );
    } else if (b.type === 'p') {
      group.append(this.bi('Text', b, 'text', { multiline: true }));
      if (this.project.design === 'manual')
        group.append(this.check('Kleine Schrift', !!b.small, (v) => studio.change('Schriftgröße geändert', () => (v ? (b.small = true) : delete b.small))));
    } else if (b.type === 'signs')
      group.append(this.note('Erklärt automatisch die Zeichen, die in dieser Anleitung vorkommen: Vorsicht, Warnung, Hinweis und Positionen im Kreis.'));
    else if (b.type === 'cards') this.cardsForm(group, b);
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
      const manualDesign = this.project.design === 'manual';
      if (b.type === 'figure')
        group.append(
          this.seg('Breite', [['full', 'Ganz'], ['half', 'Halb'], ...(manualDesign ? [['side', 'Seitlich']] : [])], b.width, (v) =>
            studio.change('Breite geändert', () => (b.width = v), { inspector: true }),
          ),
        );
      else group.append(this.bi('Schritte', b, 'text', { multiline: true, hint: 'Ein Schritt je Zeile.' }));
      if (b.type === 'figure' && manualDesign) this.marksForm(b);
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
      if (this.project.design === 'manual') group.append(this.note('Im Text: **fett** und {7} für Position 7 im Kreis.'));
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
    // zweisprachig: unter jeder Zeile die englische Fassung (grau)
    const bi = this.project.lang === 'de+en';
    if (bi) {
      b.en ||= { head: [], rows: [] };
      const en = b.en;
      b.head.forEach((_, c) => {
        const input = cell((en.head || [])[c] || '', (v) => studio.change('Tabelle geändert', () => ((en.head ||= [])[c] = v), { key: `teh:${b.id}:${c}` }), `teh:${b.id}:${c}`, true);
        input.classList.add('en');
        input.placeholder = 'English';
        grid.appendChild(input);
      });
      grid.appendChild(document.createElement('span'));
    }
    b.rows.forEach((row, r) => {
      row.forEach((t, c) =>
        grid.appendChild(cell(t, (v) => studio.change('Tabelle geändert', () => (b.rows[r][c] = v), { key: `td:${b.id}:${r}:${c}` }), `td:${b.id}:${r}:${c}`)),
      );
      const del = htmlToElement(`<button type="button" class="btn ic" title="Zeile löschen"${b.rows.length < 2 ? ' disabled' : ''}>${icon('x', 's')}</button>`);
      del.addEventListener('click', () =>
        studio.change('Zeile gelöscht', () => {
          b.rows.splice(r, 1);
          if (b.en && b.en.rows) b.en.rows.splice(r, 1);
        }, { inspector: true }),
      );
      grid.appendChild(del);
      if (bi) {
        const en = b.en;
        row.forEach((_, c) => {
          const input = cell(((en.rows || [])[r] || [])[c] || '', (v) =>
            studio.change('Tabelle geändert', () => {
              en.rows ||= [];
              en.rows[r] ||= [];
              en.rows[r][c] = v;
            }, { key: `ted:${b.id}:${r}:${c}` }), `ted:${b.id}:${r}:${c}`);
          input.classList.add('en');
          input.placeholder = 'English';
          grid.appendChild(input);
        });
        grid.appendChild(document.createElement('span'));
      }
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

const round1 = (v) => Math.round(v * 10) / 10;

/** „RF 1 ↔ RF 2“ bzw. „RF 1 → 3 Gegenstellen“. */
function linkTitle(s, l, labels) {
  const a = labels.get(l.from) || '';
  if (l.mode === 'ptp') return `${a} ↔ ${labels.get(l.to[0]) || ''}`;
  return `${a} → ${l.to.length} ${l.to.length === 1 ? 'Gegenstelle' : 'Gegenstellen'}`;
}

/** Länge bzw. Umfang und Fläche einer Zeichnung in Metern. */
function shapeMeasure(z, mpp, s) {
  const pts = z.pts.map((q) => toPt(q, siteArea(s)));
  const len = formatLength(pathLength(pts, z.closed) * mpp);
  return z.closed ? `${len} · ${formatArea(polygonArea(pts) * mpp * mpp)}` : len;
}

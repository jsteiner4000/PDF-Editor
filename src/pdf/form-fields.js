/**
 * Formularfelder (AcroForm): auslesen und ausfüllen.
 *
 * Gelesen wird direkt aus den Widget-Anmerkungen einer Seite (nicht über pdf-libs Formular-API,
 * die bei ungewöhnlich aufgebauten Formularen abbricht). Unterstützt werden Textfelder (ein- und
 * mehrzeilig), Kontrollkästchen, Optionsfelder und Auswahllisten; versteckte,
 * Passwort-, Datei- und Unterschriftsfelder sowie Schaltflächen bleiben unverändert (versteckte
 * und Passwortfelder werden gar nicht angezeigt).
 *
 * Schreibgeschützte Felder (z. B. von Formular-Apps nach dem Abschluss gesperrt) werden mit
 * `readOnly: true` geliefert; die Oberfläche lässt sie nur im Bearbeiten-Modus ändern. Das Flag
 * selbst bleibt in der Datei erhalten.
 *
 * Ausfüllen ändert `/V` am Feld und `/AS` an den Widgets; Textfelder und Auswahllisten bekommen
 * ein neues Erscheinungsbild (`/AP`) in Helvetica, damit jedes Programm den Wert zeigt. Passt ein
 * Zeichen nicht in die Standardkodierung (z. B. „ł“), entfällt das Erscheinungsbild und
 * `/NeedAppearances` lässt das anzeigende Programm es selbst erzeugen.
 *
 * Jede Änderung wird als Liste `{ dict, key, before, after }` zurückgegeben (fehlender Eintrag =
 * undefined) – daraus entsteht der Verlaufseintrag für Rückgängig/Wiederholen.
 */
import {
  PDFArray,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
} from 'pdf-lib';
import { readStreamBytes } from './pdf-objects.js';

const N = (name) => PDFName.of(name);
const nameOf = (obj) => (obj instanceof PDFName ? obj.decodeText() : null);
const textOf = (obj) => (obj instanceof PDFString || obj instanceof PDFHexString ? obj.decodeText() : null);
const num = (obj) => (obj instanceof PDFNumber ? obj.asNumber() : 0);

/** Feld-Flags (PDF 32000-1, Tabellen 221, 226, 228, 230). */
const FF = {
  readOnly: 1,
  required: 1 << 1,
  multiline: 1 << 12,
  password: 1 << 13,
  noToggleToOff: 1 << 14,
  radio: 1 << 15,
  pushbutton: 1 << 16,
  combo: 1 << 17,
  fileSelect: 1 << 20,
  multiSelect: 1 << 21,
  doNotSpellCheck: 1 << 22,
  doNotScroll: 1 << 23,
  comb: 1 << 24,
};
/** Anmerkungs-Flags für die Sichtbarkeit. */
const F = { hidden: 2, print: 4, noView: 32 };

/**
 * Standardschriften für Formularfelder (wie in Acrobat), mit den üblichen Ressourcennamen.
 * Sie müssen nicht eingebettet werden; jedes PDF-Programm kennt sie.
 */
export const FIELD_FONTS = [
  { res: 'Helv', label: 'Helvetica', std: StandardFonts.Helvetica, css: 'Helvetica, Arial, sans-serif' },
  {
    res: 'HeBo',
    label: 'Helvetica fett',
    std: StandardFonts.HelveticaBold,
    css: 'Helvetica, Arial, sans-serif',
    weight: 700,
  },
  {
    res: 'HeOb',
    label: 'Helvetica kursiv',
    std: StandardFonts.HelveticaOblique,
    css: 'Helvetica, Arial, sans-serif',
    italic: true,
  },
  {
    res: 'HeBO',
    label: 'Helvetica fett kursiv',
    std: StandardFonts.HelveticaBoldOblique,
    css: 'Helvetica, Arial, sans-serif',
    weight: 700,
    italic: true,
  },
  { res: 'TiRo', label: 'Times', std: StandardFonts.TimesRoman, css: '"Times New Roman", Times, serif' },
  {
    res: 'TiBo',
    label: 'Times fett',
    std: StandardFonts.TimesRomanBold,
    css: '"Times New Roman", Times, serif',
    weight: 700,
  },
  {
    res: 'TiIt',
    label: 'Times kursiv',
    std: StandardFonts.TimesRomanItalic,
    css: '"Times New Roman", Times, serif',
    italic: true,
  },
  {
    res: 'TiBI',
    label: 'Times fett kursiv',
    std: StandardFonts.TimesRomanBoldItalic,
    css: '"Times New Roman", Times, serif',
    weight: 700,
    italic: true,
  },
  { res: 'Cour', label: 'Courier', std: StandardFonts.Courier, css: '"Courier New", Courier, monospace' },
  {
    res: 'CoBo',
    label: 'Courier fett',
    std: StandardFonts.CourierBold,
    css: '"Courier New", Courier, monospace',
    weight: 700,
  },
  {
    res: 'CoOb',
    label: 'Courier kursiv',
    std: StandardFonts.CourierOblique,
    css: '"Courier New", Courier, monospace',
    italic: true,
  },
  {
    res: 'CoBO',
    label: 'Courier fett kursiv',
    std: StandardFonts.CourierBoldOblique,
    css: '"Courier New", Courier, monospace',
    weight: 700,
    italic: true,
  },
];
/** Gebräuchliche andere Namen für dieselben Standardschriften. */
const FONT_ALIASES = {
  Helvetica: 'Helv',
  Arial: 'Helv',
  ArialMT: 'Helv',
  'Helvetica-Bold': 'HeBo',
  'Arial-BoldMT': 'HeBo',
  'Times-Roman': 'TiRo',
  TimesNewRoman: 'TiRo',
  TimesNewRomanPSMT: 'TiRo',
  'Times-Bold': 'TiBo',
  Courier: 'Cour',
  CourierNew: 'Cour',
  'Courier-Bold': 'CoBo',
};
/** Standardschrift zu einem /DA-Schriftnamen (unbekannt → null). */
export const fieldFont = (name) =>
  FIELD_FONTS.find((f) => f.res === (FONT_ALIASES[name] || name) || f.std === name) || null;

/** Innenabstand des Textes wie Acrobat: doppelte Rahmenbreite (abgeschrägt/eingelassen: dreifach). */
export function fieldPadding(look) {
  if (!look || !look.border) return 2;
  return Math.max(2, look.width * (look.style === 'B' || look.style === 'I' ? 3 : 2));
}

/** Wert eines vererbbaren Eintrags (Feld, dann Eltern; DA zuletzt aus dem AcroForm). */
function inherited(ctx, dict, key, acroForm = null) {
  for (let node = dict, depth = 0; node instanceof PDFDict && depth < 32; depth++) {
    const value = node.get(N(key));
    if (value !== undefined) return ctx.lookup(value);
    node = ctx.lookup(node.get(N('Parent')));
  }
  return acroForm ? ctx.lookup(acroForm.get(N(key))) : undefined;
}

/** Vollständiger Feldname („Teil.Teil“). */
function fullName(ctx, field) {
  const parts = [];
  for (let node = field, depth = 0; node instanceof PDFDict && depth < 32; depth++) {
    const part = textOf(ctx.lookup(node.get(N('T'))));
    if (part !== null) parts.unshift(part);
    node = ctx.lookup(node.get(N('Parent')));
  }
  return parts.join('.');
}

/** Das Feld zu einem Widget: das Widget selbst, wenn es einen Namen trägt, sonst sein Elternfeld. */
function fieldOf(ctx, widget) {
  if (widget.has(N('T'))) return widget;
  const parent = ctx.lookup(widget.get(N('Parent')));
  return parent instanceof PDFDict ? parent : widget;
}

/** Alle Widgets eines Felds (das Feld selbst oder seine Kinder mit /Rect). */
function widgetsOf(ctx, field) {
  if (field.has(N('Rect'))) return [field];
  const kids = ctx.lookup(field.get(N('Kids')));
  if (!(kids instanceof PDFArray)) return [];
  const out = [];
  for (let k = 0; k < kids.size(); k++) {
    const kid = ctx.lookup(kids.get(k));
    if (kid instanceof PDFDict && kid.has(N('Rect')) && !kid.has(N('T'))) out.push(kid);
  }
  return out;
}

/** Name des Ein-Zustands eines Kontrollkästchen-/Options-Widgets (Schlüssel in /AP /N außer Off). */
function onStateOf(ctx, widget) {
  const ap = ctx.lookup(widget.get(N('AP')));
  const normal = ap instanceof PDFDict ? ctx.lookup(ap.get(N('N'))) : null;
  if (normal instanceof PDFDict)
    for (const key of normal.keys()) if (key.decodeText() !== 'Off') return key.decodeText();
  return 'Yes';
}

/** Einträge einer Auswahlliste: [{ value, label }]. */
function optionsOf(ctx, field) {
  const opt = inherited(ctx, field, 'Opt');
  if (!(opt instanceof PDFArray)) return [];
  const out = [];
  for (let k = 0; k < opt.size(); k++) {
    const item = ctx.lookup(opt.get(k));
    if (item instanceof PDFArray && item.size() >= 2) {
      const value = textOf(ctx.lookup(item.get(0)));
      const label = textOf(ctx.lookup(item.get(1)));
      if (value !== null) out.push({ value, label: label ?? value });
    } else {
      const value = textOf(item);
      if (value !== null) out.push({ value, label: value });
    }
  }
  return out;
}

/** Schrift, Größe und Farbe aus /DA, z. B. „/Helv 10 Tf 0 0 1 rg“. */
export function parseDA(da) {
  const out = { font: null, size: 0, color: [0, 0, 0] };
  if (!da) return out;
  const tokens = da.match(/\/[^\s/[\]()<>]+|[-+]?\d*\.?\d+|[A-Za-z*']+/g) || [];
  const stack = [];
  for (const token of tokens) {
    if (token === 'Tf') {
      out.size = Number(stack.pop()) || 0;
      const font = stack.pop();
      out.font = font && font.startsWith('/') ? font.slice(1) : null;
    } else if (token === 'g') out.color = [Number(stack.pop()) || 0].flatMap((g) => [g, g, g]);
    else if (token === 'rg') {
      const [r, g, b] = stack.splice(-3).map(Number);
      out.color = [r || 0, g || 0, b || 0];
    } else if (token === 'k') {
      const [c, m, y, k] = stack.splice(-4).map(Number);
      out.color = [c, m, y].map((v) => 1 - Math.min(1, (v || 0) + (k || 0)));
    }
    if (/^[A-Za-z*']+$/.test(token)) stack.length = 0;
    else stack.push(token);
  }
  return out;
}

/**
 * Ausfüllbare Felder einer Seite, je Widget ein Eintrag:
 * `{ id, widget, field, name, type, rect, value, checked, onState, multiline, maxLen, options,
 *    fontSize, color, align }` – `type`: 'text' | 'checkbox' | 'radio' | 'choice'.
 * `rect` = [x1, y1, x2, y2] in PDF-Punkten (Benutzerraum der Seite).
 */
export function readPageFields(doc, pageNode, { all = false } = {}) {
  const ctx = doc.context;
  const acroForm = ctx.lookup(doc.catalog.get(N('AcroForm')));
  if (!(acroForm instanceof PDFDict)) return [];
  const annots = ctx.lookup(pageNode.get(N('Annots')));
  if (!(annots instanceof PDFArray)) return [];
  const out = [];
  for (let k = 0; k < annots.size(); k++) {
    const entry = describeWidget(ctx, acroForm, annots.get(k), k, all);
    if (entry) out.push(entry);
  }
  // Lesereihenfolge (oben nach unten, dann links nach rechts) – ergibt die Tab-Reihenfolge
  out.sort((p, q) => (Math.abs(q.rect[3] - p.rect[3]) > 4 ? q.rect[3] - p.rect[3] : p.rect[0] - q.rect[0]));
  return out;
}

/** Eintrag zu einem Widget (siehe readPageFields) oder null, wenn es kein ausfüllbares Feld ist. */
function describeWidget(ctx, acroForm, ref, k = 0, all = false) {
  const widget = ctx.lookup(ref);
  if (!(widget instanceof PDFDict) || nameOf(widget.get(N('Subtype'))) !== 'Widget') return null;
  const annotFlags = num(ctx.lookup(widget.get(N('F'))));
  if (!all && annotFlags & (F.hidden | F.noView)) return null;
  const rectArr = ctx.lookup(widget.get(N('Rect')));
  if (!(rectArr instanceof PDFArray) || rectArr.size() < 4) return null;
  const [a, b, c, d] = [0, 1, 2, 3].map((i) => num(ctx.lookup(rectArr.get(i))));
  const rect = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
  if (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) return null;
  const field = fieldOf(ctx, widget);
  const ft = nameOf(inherited(ctx, field, 'FT'));
  const flags = num(inherited(ctx, field, 'Ff'));
  const da = parseDA(textOf(inherited(ctx, widget, 'DA', acroForm)) || '');
  const align = num(inherited(ctx, widget, 'Q', acroForm));
  const look = appearanceColors(ctx, widget);
  const base = {
    id: ref instanceof PDFRef ? ref.toString() : 'w' + k,
    widget,
    field,
    name: fullName(ctx, field),
    partialName: textOf(ctx.lookup(field.get(N('T')))) ?? '',
    rect,
    fontSize: da.size,
    color: da.color,
    align,
    readOnly: !!(flags & FF.readOnly),
    required: !!(flags & FF.required),
    look,
    font: da.font,
    tooltip: textOf(ctx.lookup(field.get(N('TU')))) ?? '',
    visibility:
      annotFlags & F.hidden
        ? 'hidden'
        : annotFlags & F.noView
          ? annotFlags & F.print
            ? 'hiddenPrint'
            : 'hidden'
          : annotFlags & F.print
            ? 'visible'
            : 'noPrint',
    rotation: rotationOf(ctx, widget),
  };
  const value = inherited(ctx, field, 'V');
  if (ft === 'Tx') {
    if (flags & FF.fileSelect) return null;
    const maxLen = num(inherited(ctx, field, 'MaxLen'));
    const text = textOf(value) ?? '';
    const lineHeight = (da.size || 10) * 1.15;
    return {
      ...base,
      type: 'text',
      value: text,
      // mehrzeilig laut Flag – oder der Wert enthält Zeilenumbrüche und das Feld hat Platz dafür
      multiline: !!(flags & FF.multiline) || (/[\r\n]/.test(text) && rect[3] - rect[1] > 1.8 * lineHeight),
      maxLen: maxLen > 0 ? maxLen : 0,
      password: !!(flags & FF.password),
      comb: !!(flags & FF.comb) && maxLen > 0,
      doNotScroll: !!(flags & FF.doNotScroll),
      doNotSpellCheck: !!(flags & FF.doNotSpellCheck),
      defaultValue: textOf(inherited(ctx, field, 'DV')) ?? '',
    };
  } else if (ft === 'Btn') {
    if (flags & FF.pushbutton) return null;
    const onState = onStateOf(ctx, widget);
    const state = nameOf(widget.get(N('AS'))) ?? nameOf(value);
    return {
      ...base,
      type: flags & FF.radio ? 'radio' : 'checkbox',
      onState,
      checked: state === onState,
      ownAppearance: onState === 'Yes',
      noToggleToOff: !!(flags & FF.noToggleToOff),
    };
  } else if (ft === 'Ch') {
    if (flags & FF.multiSelect) return null;
    const selected = value instanceof PDFArray ? textOf(ctx.lookup(value.get(0))) : textOf(value);
    return {
      ...base,
      type: 'choice',
      value: selected ?? '',
      options: optionsOf(ctx, field),
      combo: !!(flags & FF.combo),
    };
  }
  return null;
}

/**
 * Setzt einen Feldwert. `entry` stammt aus `readPageFields`; `value` ist Text (text, choice) bzw.
 * true/false (checkbox, radio). Liefert die Änderungen ([] = nichts geändert).
 */
export function applyFieldValue(doc, entry, value, fontCache) {
  const ctx = doc.context;
  const { changes, set } = recorder();
  const field = entry.field;
  repairFieldTree(doc, set, fontCache);
  const widgets = widgetsOf(ctx, field);
  if (!widgets.includes(entry.widget)) widgets.push(entry.widget);

  if (entry.type === 'checkbox' || entry.type === 'radio') {
    const on = entry.type === 'radio' ? true : !!value;
    if (entry.type === 'radio' && !value) return changes;
    const state = on ? entry.onState : 'Off';
    set(field, 'V', N(state));
    for (const widget of widgets) {
      const widgetOn = onStateOf(ctx, widget);
      set(widget, 'AS', N(on && widgetOn === entry.onState ? widgetOn : 'Off'));
    }
    return changes;
  }

  const text = String(value);
  if (text === entry.value) return changes;
  set(field, 'V', PDFHexString.fromText(text));
  for (const widget of widgets) refreshTextAppearance(doc, widget, { ...entry, value: text }, set, fontCache);
  return changes;
}

/** Änderungsprotokoll: `set(dict, key, value)` ändert und merkt sich den vorherigen Wert. */
function recorder() {
  const changes = [];
  const set = (dict, key, after) => {
    const name = N(key);
    const before = dict.get(name);
    if (before === after || same(before, after)) return;
    changes.push({ dict, key: name, before, after });
    if (after === undefined) dict.delete(name);
    else dict.set(name, after);
  };
  return { changes, set };
}

/** Gleicher Wert (neu erzeugte Objekte mit gleichem Inhalt gelten als unverändert)? */
function same(a, b) {
  if (a === undefined || b === undefined || a instanceof PDFStream || b instanceof PDFStream) return false;
  return a.constructor === b.constructor && a.toString() === b.toString();
}

/** Neues Erscheinungsbild eines Text- oder Auswahlfelds (sonst /NeedAppearances). */
function refreshTextAppearance(doc, widget, entry, set, fontCache) {
  const ctx = doc.context;
  const text = entry.value;
  const label = entry.type === 'choice' ? (entry.options.find((o) => o.value === text)?.label ?? text) : text;
  const stream = textAppearance(doc, widget, entry, label, fontCache);
  if (stream) set(widget, 'AP', ctx.obj({ N: ctx.register(stream) }));
  else {
    set(widget, 'AP', undefined);
    const acroForm = ctx.lookup(doc.catalog.get(N('AcroForm')));
    if (acroForm instanceof PDFDict) set(acroForm, 'NeedAppearances', ctx.obj(true));
  }
}

/** Drehung des Felds (/MK /R): 0, 90, 180 oder 270. */
function rotationOf(ctx, widget) {
  const mk = ctx.lookup(widget.get(N('MK')));
  const r = mk instanceof PDFDict ? num(ctx.lookup(mk.get(N('R')))) : 0;
  return (((Math.round(r / 90) * 90) % 360) + 360) % 360;
}

/** Rahmen- und Hintergrundfarbe (/MK /BC, /BG), Rahmenbreite und -stil eines Widgets. */
function appearanceColors(ctx, widget) {
  const mk = ctx.lookup(widget.get(N('MK')));
  const color = (key) => {
    const arr = mk instanceof PDFDict ? ctx.lookup(mk.get(N(key))) : null;
    if (!(arr instanceof PDFArray) || !arr.size()) return null;
    const v = arr.asArray().map((x) => num(ctx.lookup(x)));
    if (v.length === 1) return [v[0], v[0], v[0]];
    if (v.length === 4) return [0, 1, 2].map((i) => 1 - Math.min(1, v[i] + v[3]));
    return v.slice(0, 3);
  };
  // Rahmenbreite: /BS /W, sonst das ältere /Border [h v Breite], sonst 1
  const bs = ctx.lookup(widget.get(N('BS')));
  const border = ctx.lookup(widget.get(N('Border')));
  const w =
    bs instanceof PDFDict && bs.has(N('W'))
      ? num(ctx.lookup(bs.get(N('W'))))
      : border instanceof PDFArray && border.size() >= 3
        ? num(ctx.lookup(border.get(2)))
        : 1;
  const style = (bs instanceof PDFDict && nameOf(ctx.lookup(bs.get(N('S'))))) || 'S';
  return { border: w > 0 ? color('BC') : null, background: color('BG'), width: w, style };
}

const rgb = (c, op) => `${c.map((v) => +v.toFixed(3)).join(' ')} ${op}`;

/**
 * Rahmen und Hintergrund für ein Erscheinungsbild der Größe w × h (wie Acrobat): Linienstil
 * durchgezogen, gestrichelt, unterstrichen, abgeschrägt (hell oben/links) oder eingelassen
 * (dunkel oben/links).
 */
function frameOps(ctx, widget, w, h, look = appearanceColors(ctx, widget)) {
  const { border, background, width, style } = look;
  const ops = [];
  if (background) ops.push(rgb(background, 'rg'), `0 0 ${w} ${h} re f`);
  if (!border) return ops;
  const bs = ctx.lookup(widget.get(N('BS')));
  ops.push('q', rgb(border, 'RG'), `${width} w`);
  if (style === 'D') {
    const dash = bs instanceof PDFDict ? ctx.lookup(bs.get(N('D'))) : null;
    const parts =
      dash instanceof PDFArray && dash.size() ? dash.asArray().map((x) => num(ctx.lookup(x))) : [3];
    ops.push(`[${parts.join(' ')}] 0 d`);
  }
  if (style === 'U') ops.push(`0 ${width / 2} m ${w} ${width / 2} l S`);
  else ops.push(`${width / 2} ${width / 2} ${w - width} ${h - width} re S`);
  if (style === 'B' || style === 'I') {
    // innere Schräge: zwei Winkel in Rahmenbreite
    const light = style === 'B' ? '1 g' : '0.5 g';
    const dark = style === 'B' ? '0.5 g' : '0.75 g';
    const i = width;
    const o = 2 * width;
    ops.push(
      light,
      `${i} ${i} m ${i} ${h - i} l ${w - i} ${h - i} l ${w - o} ${h - o} l ${o} ${h - o} l ${o} ${o} l f`,
    );
    ops.push(
      dark,
      `${w - i} ${h - i} m ${w - i} ${i} l ${i} ${i} l ${o} ${o} l ${w - o} ${o} l ${w - o} ${h - o} l f`,
    );
  }
  ops.push('Q');
  return ops;
}

/**
 * Manche Programme (z. B. der PDF-Export von iOS) schreiben die Felder doppelt: einmal als Widgets
 * der Seiten, einmal als lose Kopien in `/AcroForm /Fields`. Programme, die über `/Fields` lesen,
 * zeigten dann nach dem Ausfüllen die alten Werte. Lose Kopien werden durch das gleichnamige Feld
 * der Seite ersetzt (als Änderung erfasst, also auch rückgängig zu machen).
 */
function repairFieldTree(doc, set, state) {
  const ctx = doc.context;
  const acroForm = ctx.lookup(doc.catalog.get(N('AcroForm')));
  const fields = acroForm instanceof PDFDict ? ctx.lookup(acroForm.get(N('Fields'))) : null;
  // nur einmal je Feldliste prüfen (nach Rückgängig ist es wieder die alte Liste → erneut)
  if (!(fields instanceof PDFArray) || state.checkedFields === fields) return;
  state.checkedFields = fields;
  const pageRoots = new Map(); // Wurzel-Feld (dict) -> Ref
  for (const page of doc.getPages()) {
    const annots = ctx.lookup(page.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (const ref of annots.asArray()) {
      let node = ctx.lookup(ref);
      if (!(node instanceof PDFDict) || nameOf(node.get(N('Subtype'))) !== 'Widget') continue;
      let nodeRef = ref;
      for (let depth = 0; depth < 32; depth++) {
        const parentRef = node.get(N('Parent'));
        const parent = ctx.lookup(parentRef);
        if (!(parent instanceof PDFDict)) break;
        node = parent;
        nodeRef = parentRef;
      }
      if (nodeRef instanceof PDFRef) pageRoots.set(node, nodeRef);
    }
  }
  const listed = new Set(fields.asArray().map((ref) => ctx.lookup(ref)));
  const byName = new Map();
  for (const [root, ref] of pageRoots) if (!listed.has(root)) byName.set(fullName(ctx, root), ref);
  if (!byName.size) return;
  let replaced = false;
  const refs = fields.asArray().map((ref) => {
    const dict = ctx.lookup(ref);
    if (!(dict instanceof PDFDict) || pageRoots.has(dict)) return ref;
    const match = byName.get(fullName(ctx, dict));
    if (!match) return ref;
    byName.delete(fullName(ctx, dict));
    replaced = true;
    return match;
  });
  if (!replaced) return;
  const repaired = ctx.obj(refs);
  set(acroForm, 'Fields', repaired);
  state.checkedFields = repaired;
}

/** Stellt den Zustand vor (`undo`) bzw. nach einer Änderung wieder her. */
export function restoreChanges(changes, direction) {
  const list = direction === 'undo' ? [...changes].reverse() : changes;
  for (const { dict, key, before, after } of list) {
    const value = direction === 'undo' ? before : after;
    if (value === undefined) dict.delete(key);
    else dict.set(key, value);
  }
}

/** Standardschrift `res` (siehe FIELD_FONTS) – je Dokument einmal angelegt, nicht eingebettet. */
function standardFont(doc, fontCache, res) {
  const spec = FIELD_FONTS.find((f) => f.res === res) || FIELD_FONTS[0];
  fontCache.std ||= {};
  fontCache.std[spec.res] ||= doc.embedStandardFont(spec.std);
  return fontCache.std[spec.res];
}

/**
 * Erscheinungsbild eines Textfelds (Form-XObject) oder null, wenn der Text in der gewählten
 * Standardschrift (WinAnsi) nicht darstellbar ist. Berücksichtigt Schrift, Größe (0 = automatisch),
 * Farbe, Ausrichtung, mehrzeilig, Kammfeld, Kennwort und die Drehung des Felds.
 */
function textAppearance(doc, widget, entry, text, fontCache) {
  const ctx = doc.context;
  const rotation = rotationOf(ctx, widget);
  const rectArr = ctx.lookup(widget.get(N('Rect')));
  const [a, b, c, d] = [0, 1, 2, 3].map((i) => num(ctx.lookup(rectArr.get(i))));
  // gedreht: im ungedrehten Feld zeichnen, /Matrix dreht es in das Rechteck
  const turned = rotation === 90 || rotation === 270;
  const W = turned ? Math.abs(d - b) : Math.abs(c - a);
  const H = turned ? Math.abs(c - a) : Math.abs(d - b);
  const spec = fieldFont(entry.font) || FIELD_FONTS[0];
  const font = standardFont(doc, fontCache, spec.res);
  const frameLook = appearanceColors(ctx, widget);
  const pad = fieldPadding(frameLook);
  const shown = entry.password ? '*'.repeat([...text].length) : text;
  const comb = entry.comb && entry.maxLen > 0 && !entry.multiline;
  const lines = [];
  let size = entry.fontSize;
  try {
    const paragraphs = shown.split(/\r\n|\r|\n/);
    if (!entry.multiline) {
      if (!size) size = Math.max(4, Math.min(12, (H - 2 * pad) * 0.72));
      lines.push(paragraphs.join(' '));
    } else {
      if (!size) size = 10;
      const width = Math.max(1, W - 2 * pad);
      for (const paragraph of paragraphs) {
        let line = '';
        for (const word of paragraph.split(/(\s+)/)) {
          const next = line + word;
          if (line && font.widthOfTextAtSize(next.trimEnd(), size) > width && word.trim()) {
            lines.push(line.trimEnd());
            line = word.trimStart();
          } else line = next;
        }
        lines.push(line.trimEnd());
      }
    }
    for (const line of lines) font.encodeText(line);
  } catch {
    return null;
  }
  const [r, g, bl] = entry.color.map((v) => +v.toFixed(3));
  const lead = size * 1.15;
  const ascent = size * 0.718;
  const frame = frameOps(ctx, widget, W, H, frameLook);
  const ops = [...frame];
  // Kammfeld: Trennlinien in Rahmenfarbe zwischen den Zeichenzellen
  const { border, width: borderWidth } = frameLook;
  if (comb && border) {
    const cell = W / entry.maxLen;
    ops.push('q', rgb(border, 'RG'), `${borderWidth} w`);
    for (let n = 1; n < entry.maxLen; n++)
      ops.push(`${+(n * cell).toFixed(2)} 0 m ${+(n * cell).toFixed(2)} ${H} l S`);
    ops.push('Q');
  }
  ops.push(
    '/Tx BMC',
    'q',
    `${pad / 2} ${pad / 2} ${W - pad} ${H - pad} re W n`,
    'BT',
    `/${spec.res} ${+size.toFixed(2)} Tf`,
    `${r} ${g} ${bl} rg`,
  );
  const baseline = (H - ascent) / 2 + size * 0.06;
  const put = (str, x, y) =>
    ops.push(`1 0 0 1 ${+x.toFixed(2)} ${+y.toFixed(2)} Tm`, `${font.encodeText(str).toString()} Tj`);
  if (comb) {
    const cell = W / entry.maxLen;
    [...lines[0]]
      .slice(0, entry.maxLen)
      .forEach((ch, n) => put(ch, n * cell + (cell - font.widthOfTextAtSize(ch, size)) / 2, baseline));
  } else
    lines.forEach((line, k) => {
      const width = font.widthOfTextAtSize(line, size);
      const x = entry.align === 1 ? (W - width) / 2 : entry.align === 2 ? W - pad - width : pad;
      put(line, x, entry.multiline ? H - pad - ascent - k * lead : baseline);
    });
  ops.push('ET', 'Q', 'EMC');
  const matrix = { 0: null, 90: [0, 1, -1, 0, H, 0], 180: [-1, 0, 0, -1, W, H], 270: [0, -1, 1, 0, 0, W] }[
    rotation
  ];
  return ctx.stream(ops.join('\n'), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, W, H],
    ...(matrix ? { Matrix: matrix } : {}),
    Resources: { Font: { [spec.res]: font.ref } },
  });
}

/* ---------- Formularfelder anlegen, ändern, löschen ---------- */

/** Rahmen neuer Felder: dezentes Grau, weißer Hintergrund. */
const NEW_FIELD_MK = { BC: [0.6, 0.6, 0.6], BG: [1, 1, 1] };

/** AcroForm des Dokuments (wird bei Bedarf angelegt, mit Helvetica als Standardschrift). */
function ensureAcroForm(doc, set, fontCache) {
  const ctx = doc.context;
  const font = standardFont(doc, fontCache, 'Helv');
  let acroForm = ctx.lookup(doc.catalog.get(N('AcroForm')));
  if (!(acroForm instanceof PDFDict)) {
    acroForm = ctx.obj({ Fields: [], DA: PDFString.of('/Helv 0 Tf 0 g') });
    acroForm.set(N('DR'), ctx.obj({ Font: { Helv: font.ref } }));
    set(doc.catalog, 'AcroForm', ctx.register(acroForm));
    return acroForm;
  }
  // Standardschrift für Programme, die Erscheinungsbilder selbst erzeugen
  let dr = ctx.lookup(acroForm.get(N('DR')));
  if (!(dr instanceof PDFDict)) set(acroForm, 'DR', ctx.obj({ Font: { Helv: font.ref } }));
  else {
    const fonts = ctx.lookup(dr.get(N('Font')));
    if (!(fonts instanceof PDFDict)) set(dr, 'Font', ctx.obj({ Helv: font.ref }));
    else if (!fonts.has(N('Helv'))) set(fonts, 'Helv', font.ref);
  }
  return acroForm;
}

/** Freier Feldname („Textfeld 1“, „Textfeld 2“ …). */
export function uniqueFieldName(doc, base) {
  const ctx = doc.context;
  const taken = new Set();
  for (const page of doc.getPages()) {
    const annots = ctx.lookup(page.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (const ref of annots.asArray()) {
      const widget = ctx.lookup(ref);
      if (widget instanceof PDFDict) taken.add(fullName(ctx, fieldOf(ctx, widget)));
    }
  }
  for (let n = 1; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
}

/** Erscheinungsbilder eines Kontrollkästchens (an: Haken, aus: leer), jeweils mit Rahmen. */
function checkboxAppearances(ctx, widget, w, h) {
  const frame = frameOps(ctx, widget, w, h);
  const s = Math.min(w, h);
  const x0 = (w - s) / 2;
  const y0 = (h - s) / 2;
  const pt = (fx, fy) => `${+(x0 + fx * s).toFixed(2)} ${+(y0 + fy * s).toFixed(2)}`;
  const check = [
    'q',
    '0.1 0.1 0.12 RG',
    `${+(s * 0.12).toFixed(2)} w`,
    '1 J 1 j',
    `${pt(0.22, 0.52)} m`,
    `${pt(0.42, 0.3)} l`,
    `${pt(0.78, 0.74)} l`,
    'S',
    'Q',
  ];
  const stream = (ops) =>
    ctx.register(ctx.stream(ops.join('\n'), { Type: 'XObject', Subtype: 'Form', BBox: [0, 0, w, h] }));
  return ctx.obj({ N: { Yes: stream([...frame, ...check]), Off: stream(frame) } });
}

/**
 * Legt ein neues Feld auf der Seite an. `type`: 'text' | 'checkbox'; `rect` in PDF-Punkten.
 * Liefert { changes, id } (id = Referenz des neuen Widgets).
 */
export function createField(doc, pageIndex, type, rect, name, fontCache) {
  const ctx = doc.context;
  const { changes, set } = recorder();
  repairFieldTree(doc, set, fontCache);
  const acroForm = ensureAcroForm(doc, set, fontCache);
  const page = doc.getPage(pageIndex);
  const [x1, y1, x2, y2] = rect;
  const w = x2 - x1;
  const h = y2 - y1;
  const common = {
    Type: 'Annot',
    Subtype: 'Widget',
    Rect: [x1, y1, x2, y2],
    F: 4,
    P: page.ref,
    MK: NEW_FIELD_MK,
    BS: { W: 1, S: 'S' },
  };
  let widget;
  if (type === 'checkbox') {
    widget = ctx.obj({ ...common, FT: 'Btn', V: 'Off', AS: 'Off' });
    widget.set(N('DA'), PDFString.of('/ZaDb 0 Tf 0 g'));
  } else {
    widget = ctx.obj({ ...common, FT: 'Tx', Q: 0 });
    widget.set(N('DA'), PDFString.of('/Helv 10 Tf 0 g'));
    widget.set(N('V'), PDFHexString.fromText(''));
  }
  widget.set(N('T'), PDFHexString.fromText(name));
  const ref = ctx.register(widget);
  if (type === 'checkbox') widget.set(N('AP'), checkboxAppearances(ctx, widget, w, h));
  else {
    const stream = textAppearance(
      doc,
      widget,
      { multiline: false, fontSize: 10, color: [0, 0, 0], align: 0 },
      '',
      fontCache,
    );
    if (stream) widget.set(N('AP'), ctx.obj({ N: ctx.register(stream) }));
  }
  const annots = ctx.lookup(page.node.get(N('Annots')));
  set(page.node, 'Annots', ctx.obj([...(annots instanceof PDFArray ? annots.asArray() : []), ref]));
  const fields = ctx.lookup(acroForm.get(N('Fields')));
  set(acroForm, 'Fields', ctx.obj([...(fields instanceof PDFArray ? fields.asArray() : []), ref]));
  return { changes, id: ref.toString() };
}

/** /DA mit geänderter Schrift, Größe oder Farbe (übrige Angaben bleiben). */
function composeDA(da, { font, size, color } = {}) {
  const parsed = parseDA(da);
  const name = font || parsed.font || 'Helv';
  const fontSize = size ?? parsed.size;
  const [r, g, b] = (color || parsed.color).map((v) => +(+v).toFixed(3));
  const colorOps = r === g && g === b ? `${r} g` : `${r} ${g} ${b} rg`;
  return `/${name} ${fontSize} Tf ${colorOps}`;
}

const sameColor = (a, b) => (!a && !b) || (!!a && !!b && a.every((v, i) => Math.abs(v - b[i]) < 0.002));

/**
 * Ändert Lage und Eigenschaften eines Felds (wie der Eigenschaften-Dialog in Acrobat). `props`
 * (alle optional):
 *   Allgemein:  `rect`, `name`, `tooltip`, `visibility` ('visible' | 'hidden' | 'noPrint' |
 *               'hiddenPrint'), `rotation` (0/90/180/270), `readOnly`, `required`
 *   Darstellung: `borderColor` / `fillColor` ([r, g, b] oder null), `borderWidth` (1–3),
 *               `borderStyle` ('S' | 'D' | 'B' | 'I' | 'U'), `font` (FIELD_FONTS.res),
 *               `fontSize` (0 = automatisch), `textColor` ([r, g, b])
 *   Optionen:   `align` (0/1/2), `defaultValue`, `multiline`, `doNotScroll`, `doNotSpellCheck`,
 *               `maxLen` (0 = unbegrenzt), `password`, `comb`
 */
export function updateField(doc, entry, props, fontCache) {
  const ctx = doc.context;
  const { changes, set } = recorder();
  repairFieldTree(doc, set, fontCache);
  const { widget, field } = entry;
  const acroForm = ctx.lookup(doc.catalog.get(N('AcroForm')));
  const look = entry.look || appearanceColors(ctx, widget);
  // nur tatsächliche Änderungen übernehmen (geerbte Standardwerte zählen als gesetzt)
  props = { ...props };
  for (const key of [
    'fontSize',
    'align',
    'tooltip',
    'visibility',
    'rotation',
    'font',
    'maxLen',
    'defaultValue',
  ])
    if (props[key] !== undefined && props[key] === entry[key]) delete props[key];
  if (props.borderColor !== undefined && sameColor(props.borderColor, look.border)) delete props.borderColor;
  if (props.fillColor !== undefined && sameColor(props.fillColor, look.background)) delete props.fillColor;
  if (props.textColor !== undefined && sameColor(props.textColor, entry.color)) delete props.textColor;
  if (props.borderWidth !== undefined && props.borderWidth === look.width) delete props.borderWidth;
  if (props.borderStyle !== undefined && props.borderStyle === look.style) delete props.borderStyle;

  // Allgemein
  const [ox1, oy1, ox2, oy2] = entry.rect;
  const resized =
    !!props.rect &&
    (Math.abs(props.rect[2] - props.rect[0] - (ox2 - ox1)) > 0.01 ||
      Math.abs(props.rect[3] - props.rect[1] - (oy2 - oy1)) > 0.01);
  if (props.rect) set(widget, 'Rect', ctx.obj(props.rect.map((v) => +v.toFixed(2))));
  if (props.name !== undefined && props.name !== entry.partialName)
    set(field, 'T', PDFHexString.fromText(props.name));
  if (props.tooltip !== undefined)
    set(field, 'TU', props.tooltip ? PDFHexString.fromText(props.tooltip) : undefined);
  if (props.visibility !== undefined) {
    const f = num(ctx.lookup(widget.get(N('F')))) & ~(F.hidden | F.print | F.noView);
    const add = { visible: F.print, hidden: F.hidden, noPrint: 0, hiddenPrint: F.noView | F.print }[
      props.visibility
    ];
    set(widget, 'F', ctx.obj(f | (add ?? F.print)));
  }
  const flag = (bit, on) => {
    const ff = num(inherited(ctx, field, 'Ff'));
    const next = on ? ff | bit : ff & ~bit;
    if (next !== ff) set(field, 'Ff', ctx.obj(next));
  };
  if (props.readOnly !== undefined) flag(FF.readOnly, props.readOnly);
  if (props.required !== undefined) flag(FF.required, props.required);
  if (entry.type === 'text') {
    // Kennwort und mehrzeilig schließen sich aus (wie in Acrobat)
    if (props.multiline !== undefined) {
      flag(FF.multiline, props.multiline);
      if (props.multiline) flag(FF.password, false);
    }
    if (props.doNotScroll !== undefined) flag(FF.doNotScroll, props.doNotScroll);
    if (props.doNotSpellCheck !== undefined) flag(FF.doNotSpellCheck, props.doNotSpellCheck);
    if (props.password !== undefined) {
      flag(FF.password, props.password);
      if (props.password) flag(FF.multiline, false);
    }
    if (props.maxLen !== undefined)
      set(field, 'MaxLen', props.maxLen > 0 ? ctx.obj(props.maxLen) : undefined);
    if (props.comb !== undefined) {
      flag(FF.comb, props.comb);
      // Kammfeld: nur einzeilig, ohne Kennwort, mit fester Zeichenzahl (Acrobat-Regel)
      if (props.comb) {
        flag(FF.multiline, false);
        flag(FF.password, false);
        if (!num(inherited(ctx, field, 'MaxLen'))) set(field, 'MaxLen', ctx.obj(10));
      }
    }
    if (props.defaultValue !== undefined) {
      set(field, 'DV', props.defaultValue ? PDFHexString.fromText(props.defaultValue) : undefined);
      // wie Acrobat: ein leeres Feld zeigt den neuen Standardwert sofort
      if (!entry.value && props.defaultValue) set(field, 'V', PDFHexString.fromText(props.defaultValue));
    }
  }

  // Darstellung: /MK (Farben, Drehung), /BS (Linie), /DA (Schrift, Größe, Farbe)
  const mkChange =
    props.borderColor !== undefined || props.fillColor !== undefined || props.rotation !== undefined;
  if (mkChange) {
    const mk = ctx.lookup(widget.get(N('MK')));
    const next = mk instanceof PDFDict ? mk.clone(ctx) : ctx.obj({});
    if (props.borderColor !== undefined) {
      if (props.borderColor) next.set(N('BC'), ctx.obj(props.borderColor));
      else next.delete(N('BC'));
    }
    if (props.fillColor !== undefined) {
      if (props.fillColor) next.set(N('BG'), ctx.obj(props.fillColor));
      else next.delete(N('BG'));
    }
    if (props.rotation !== undefined) {
      if (props.rotation) next.set(N('R'), ctx.obj(props.rotation));
      else next.delete(N('R'));
    }
    set(widget, 'MK', next);
  }
  if (
    props.borderWidth !== undefined ||
    props.borderStyle !== undefined ||
    (props.borderColor && !look.width)
  ) {
    const style = props.borderStyle || look.style || 'S';
    const bs = ctx.obj({ W: props.borderWidth || look.width || 1, S: style });
    if (style === 'D') bs.set(N('D'), ctx.obj([3]));
    set(widget, 'BS', bs);
    set(widget, 'Border', undefined);
  }
  const daChange = { font: props.font, size: props.fontSize, color: props.textColor };
  if (props.font !== undefined || props.fontSize !== undefined || props.textColor !== undefined) {
    const da = textOf(inherited(ctx, widget, 'DA', acroForm)) || '/Helv 0 Tf 0 g';
    set(widget, 'DA', PDFString.of(composeDA(da, daChange)));
    // Programme, die Felder selbst zeichnen, finden die Schrift unter /DR
    if (props.font) {
      const font = standardFont(doc, fontCache, props.font);
      const form = ensureAcroForm(doc, set, fontCache);
      const dr = ctx.lookup(form.get(N('DR')));
      const fonts = dr instanceof PDFDict ? ctx.lookup(dr.get(N('Font'))) : null;
      if (fonts instanceof PDFDict && !fonts.has(N(props.font))) set(fonts, props.font, font.ref);
    }
  }
  if (props.align !== undefined) set(widget, 'Q', ctx.obj(props.align));

  // Erscheinungsbild an Größe und Eigenschaften anpassen; reines Verschieben behält es
  const now = describeWidget(ctx, acroForm, widget, 0, true) || entry;
  const looks = [
    'borderColor',
    'fillColor',
    'borderWidth',
    'borderStyle',
    'rotation',
    'font',
    'fontSize',
    'textColor',
    'align',
    'multiline',
    'password',
    'comb',
    'maxLen',
    'defaultValue',
  ].some((key) => props[key] !== undefined);
  // Eigenschaften des Felds (Wert, Kennwort, Kamm, mehrzeilig, Zeichenzahl) betreffen alle seine
  // Widgets – auch auf anderen Seiten; Rahmen, Schrift und Lage nur das gewählte
  const fieldLevel = ['multiline', 'password', 'comb', 'maxLen', 'defaultValue'].some(
    (key) => props[key] !== undefined,
  );
  const targets = fieldLevel ? [...new Set([widget, ...widgetsOf(ctx, field)])] : [widget];
  for (const target of targets) {
    const current = target === widget ? now : describeWidget(ctx, acroForm, target, 0, true);
    if (!current) continue;
    if (current.type === 'text' || current.type === 'choice') {
      if (resized || looks) refreshTextAppearance(doc, target, current, set, fontCache);
    } else if (current.type === 'checkbox' && (resized || looks) && isOwnCheckbox(ctx, target)) {
      const [x1, y1, x2, y2] = current.rect;
      set(target, 'AP', checkboxAppearances(ctx, target, x2 - x1, y2 - y1));
    }
  }
  return changes;
}

/** Kontrollkästchen mit den Zuständen Yes/Off (wie von PDFix angelegt): Aussehen neu erzeugbar. */
export function isOwnCheckbox(ctx, widget) {
  return onStateOf(ctx, widget) === 'Yes';
}

/** Entfernt ein Widget von der Seite und aus dem Feldbaum (leere Elternfelder ebenso). */
export function deleteField(doc, entry, fontCache) {
  const ctx = doc.context;
  const { changes, set } = recorder();
  repairFieldTree(doc, set, fontCache);
  const acroForm = ctx.lookup(doc.catalog.get(N('AcroForm')));
  for (const page of doc.getPages()) {
    const annots = ctx.lookup(page.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    const rest = annots.asArray().filter((ref) => ctx.lookup(ref) !== entry.widget);
    if (rest.length !== annots.size()) set(page.node, 'Annots', ctx.obj(rest));
  }
  const detach = (node, depth = 0) => {
    const parent = ctx.lookup(node.get(N('Parent')));
    const owner = parent instanceof PDFDict ? parent : acroForm;
    if (!(owner instanceof PDFDict) || depth > 32) return;
    const key = owner === acroForm ? 'Fields' : 'Kids';
    const list = ctx.lookup(owner.get(N(key)));
    if (!(list instanceof PDFArray)) return;
    const rest = list.asArray().filter((ref) => ctx.lookup(ref) !== node);
    set(owner, key, ctx.obj(rest));
    if (owner !== acroForm && !rest.length) detach(owner, depth + 1);
  };
  detach(entry.widget);
  return changes;
}

/* ---------- Gleiche Darstellung in allen Programmen ---------- */

/**
 * `/NeedAppearances true` fordert jedes Programm auf, Formularfelder selbst neu zu zeichnen. Jedes
 * tut das anders: Acrobat nimmt die Schrift aus /DA (z. B. Calibri), Chrome und pdf.js eine
 * Ersatzschrift – das Formular sieht je nach Programm verschieden aus. Passen die gespeicherten
 * Erscheinungsbilder aber zu den Werten, ist das Neuzeichnen unnötig: Dann wird der Schalter
 * entfernt, und alle Programme zeigen dasselbe gespeicherte Bild.
 *
 * Geprüft wird je sichtbarem Feld: Text/Auswahl – ein Erscheinungsbild existiert und enthält
 * genau dann Text, wenn das Feld einen Wert hat; Kästchen – der Zustand /AS hat ein Bild.
 * Bei Zweifeln bleibt der Schalter. Liefert true, wenn er entfernt wurde.
 */
export function settleNeedAppearances(doc) {
  const ctx = doc.context;
  const acroForm = ctx.lookup(doc.catalog.get(N('AcroForm')));
  if (!(acroForm instanceof PDFDict)) return false;
  const flag = ctx.lookup(acroForm.get(N('NeedAppearances')));
  if (!flag || flag.toString() !== 'true') return false;
  for (const page of doc.getPages()) {
    const annots = ctx.lookup(page.node.get(N('Annots')));
    if (!(annots instanceof PDFArray)) continue;
    for (let k = 0; k < annots.size(); k++) {
      const entry = describeWidget(ctx, acroForm, annots.get(k), k);
      if (entry && !appearanceFits(ctx, entry)) return false;
    }
  }
  acroForm.set(N('NeedAppearances'), ctx.obj(false));
  return true;
}

function appearanceFits(ctx, entry) {
  const ap = ctx.lookup(entry.widget.get(N('AP')));
  const normal = ap instanceof PDFDict ? ctx.lookup(ap.get(N('N'))) : null;
  if (entry.type === 'checkbox' || entry.type === 'radio') {
    const state = nameOf(entry.widget.get(N('AS')));
    return !!state && normal instanceof PDFDict && (state === 'Off' || normal.has(N(state)));
  }
  if (!(normal instanceof PDFStream)) return false;
  let content;
  try {
    content = new TextDecoder('latin1').decode(
      readStreamBytes(ctx, normal, 4 * 1024 * 1024) || new Uint8Array(),
    );
  } catch {
    return false;
  }
  // Text im Bild (direkt oder über ein eingebettetes Form-XObject) genau dann, wenn ein Wert da ist
  // (leere Textbefehle wie „() Tj“ zählen nicht)
  const visible = content.replace(/(\(\)|<>)\s*Tj/g, '').replace(/\[\s*\]\s*TJ/g, '');
  const drawsText = /(^|[\s\]>)])(Tj|TJ|'|")(\s|$)/.test(visible) || /\bDo\b/.test(visible);
  return drawsText === (entry.value !== '');
}

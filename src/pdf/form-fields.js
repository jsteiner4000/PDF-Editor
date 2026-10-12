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
  PDFString,
  StandardFonts,
} from 'pdf-lib';

const N = (name) => PDFName.of(name);
const nameOf = (obj) => (obj instanceof PDFName ? obj.decodeText() : null);
const textOf = (obj) => (obj instanceof PDFString || obj instanceof PDFHexString ? obj.decodeText() : null);
const num = (obj) => (obj instanceof PDFNumber ? obj.asNumber() : 0);

/** Feld-Flags (PDF 32000-1, Tabellen 221, 226, 228, 230). */
const FF = {
  readOnly: 1,
  multiline: 1 << 12,
  password: 1 << 13,
  noToggleToOff: 1 << 14,
  radio: 1 << 15,
  pushbutton: 1 << 16,
  combo: 1 << 17,
  fileSelect: 1 << 20,
  multiSelect: 1 << 21,
};
/** Anmerkungs-Flags: versteckt (2) und nicht sichtbar (32). */
const HIDDEN = 2 | 32;

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
export function readPageFields(doc, pageNode) {
  const ctx = doc.context;
  const acroForm = ctx.lookup(doc.catalog.get(N('AcroForm')));
  if (!(acroForm instanceof PDFDict)) return [];
  const annots = ctx.lookup(pageNode.get(N('Annots')));
  if (!(annots instanceof PDFArray)) return [];
  const out = [];
  for (let k = 0; k < annots.size(); k++) {
    const ref = annots.get(k);
    const widget = ctx.lookup(ref);
    if (!(widget instanceof PDFDict) || nameOf(widget.get(N('Subtype'))) !== 'Widget') continue;
    if (num(ctx.lookup(widget.get(N('F')))) & HIDDEN) continue;
    const rectArr = ctx.lookup(widget.get(N('Rect')));
    if (!(rectArr instanceof PDFArray) || rectArr.size() < 4) continue;
    const [a, b, c, d] = [0, 1, 2, 3].map((i) => num(ctx.lookup(rectArr.get(i))));
    const rect = [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
    if (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) continue;
    const field = fieldOf(ctx, widget);
    const ft = nameOf(inherited(ctx, field, 'FT'));
    const flags = num(inherited(ctx, field, 'Ff'));
    const da = parseDA(textOf(inherited(ctx, widget, 'DA', acroForm)) || '');
    const align = num(inherited(ctx, widget, 'Q', acroForm));
    const base = {
      id: ref instanceof PDFRef ? ref.toString() : 'w' + k,
      widget,
      field,
      name: fullName(ctx, field),
      rect,
      fontSize: da.size,
      color: da.color,
      align,
      readOnly: !!(flags & FF.readOnly),
    };
    const value = inherited(ctx, field, 'V');
    if (ft === 'Tx') {
      if (flags & (FF.password | FF.fileSelect)) continue;
      const maxLen = num(inherited(ctx, field, 'MaxLen'));
      const text = textOf(value) ?? '';
      const lineHeight = (da.size || 10) * 1.15;
      out.push({
        ...base,
        type: 'text',
        value: text,
        // mehrzeilig laut Flag – oder der Wert enthält Zeilenumbrüche und das Feld hat Platz dafür
        multiline: !!(flags & FF.multiline) || (/[\r\n]/.test(text) && rect[3] - rect[1] > 1.8 * lineHeight),
        maxLen: maxLen > 0 ? maxLen : 0,
      });
    } else if (ft === 'Btn') {
      if (flags & FF.pushbutton) continue;
      const onState = onStateOf(ctx, widget);
      const state = nameOf(widget.get(N('AS'))) ?? nameOf(value);
      out.push({
        ...base,
        type: flags & FF.radio ? 'radio' : 'checkbox',
        onState,
        checked: state === onState,
        noToggleToOff: !!(flags & FF.noToggleToOff),
      });
    } else if (ft === 'Ch') {
      if (flags & FF.multiSelect) continue;
      const selected = value instanceof PDFArray ? textOf(ctx.lookup(value.get(0))) : textOf(value);
      out.push({
        ...base,
        type: 'choice',
        value: selected ?? '',
        options: optionsOf(ctx, field),
        combo: !!(flags & FF.combo),
      });
    }
  }
  // Lesereihenfolge (oben nach unten, dann links nach rechts) – ergibt die Tab-Reihenfolge
  out.sort((p, q) => (Math.abs(q.rect[3] - p.rect[3]) > 4 ? q.rect[3] - p.rect[3] : p.rect[0] - q.rect[0]));
  return out;
}

/**
 * Setzt einen Feldwert. `entry` stammt aus `readPageFields`; `value` ist Text (text, choice) bzw.
 * true/false (checkbox, radio). Liefert die Änderungen ([] = nichts geändert).
 */
export function applyFieldValue(doc, entry, value, fontCache) {
  const ctx = doc.context;
  const changes = [];
  const set = (dict, key, after) => {
    const name = N(key);
    const before = dict.get(name);
    if (before === after) return;
    changes.push({ dict, key: name, before, after });
    if (after === undefined) dict.delete(name);
    else dict.set(name, after);
  };
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
  const acroForm = ctx.lookup(doc.catalog.get(N('AcroForm')));
  let needAppearances = false;
  for (const widget of widgets) {
    const label =
      entry.type === 'choice' ? (entry.options.find((o) => o.value === text)?.label ?? text) : text;
    const stream = textAppearance(doc, widget, entry, label, fontCache);
    if (stream) set(widget, 'AP', ctx.obj({ N: ctx.register(stream) }));
    else {
      set(widget, 'AP', undefined);
      needAppearances = true;
    }
  }
  if (needAppearances && acroForm instanceof PDFDict) set(acroForm, 'NeedAppearances', ctx.obj(true));
  return changes;
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

/** Helvetica (Standardschrift, nicht eingebettet) – je Dokument einmal angelegt. */
function helvetica(doc, fontCache) {
  if (!fontCache.helvetica) fontCache.helvetica = doc.embedStandardFont(StandardFonts.Helvetica);
  return fontCache.helvetica;
}

/**
 * Erscheinungsbild eines Textfelds (Form-XObject) oder null, wenn der Text nicht in Helvetica
 * (WinAnsi) darstellbar ist oder das Widget gedreht ist.
 */
function textAppearance(doc, widget, entry, text, fontCache) {
  const ctx = doc.context;
  const mk = ctx.lookup(widget.get(N('MK')));
  if (mk instanceof PDFDict && num(ctx.lookup(mk.get(N('R')))) % 360) return null;
  const rectArr = ctx.lookup(widget.get(N('Rect')));
  const [a, b, c, d] = [0, 1, 2, 3].map((i) => num(ctx.lookup(rectArr.get(i))));
  const w = Math.abs(c - a);
  const h = Math.abs(d - b);
  const font = helvetica(doc, fontCache);
  const pad = 2;
  const lines = [];
  let size = entry.fontSize;
  try {
    const paragraphs = text.split(/\r\n|\r|\n/);
    if (!entry.multiline) {
      if (!size) size = Math.max(4, Math.min(12, (h - 2 * pad) * 0.72));
      lines.push(paragraphs.join(' '));
    } else {
      if (!size) size = 10;
      const width = Math.max(1, w - 2 * pad);
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
  const ops = [
    '/Tx BMC',
    'q',
    `${pad / 2} ${pad / 2} ${w - pad} ${h - pad} re W n`,
    'BT',
    `/Helv ${+size.toFixed(2)} Tf`,
    `${r} ${g} ${bl} rg`,
  ];
  lines.forEach((line, k) => {
    const width = font.widthOfTextAtSize(line, size);
    const x = entry.align === 1 ? (w - width) / 2 : entry.align === 2 ? w - pad - width : pad;
    const y = entry.multiline ? h - pad - ascent - k * lead : (h - ascent) / 2 + size * 0.06;
    ops.push(`1 0 0 1 ${+x.toFixed(2)} ${+y.toFixed(2)} Tm`, `${font.encodeText(line).toString()} Tj`);
  });
  ops.push('ET', 'Q', 'EMC');
  return ctx.stream(ops.join('\n'), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, w, h],
    Resources: { Font: { Helv: font.ref } },
  });
}

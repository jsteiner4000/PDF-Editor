/**
 * Anschlussplan: Lage aller Teile berechnen und als Seiten setzen.
 *
 * Seite 1 ist das Blockschaltbild – die Steuerung in der Mitte, Baugruppen links und rechts mit
 * je einer Leitung pro Anschluss (Sammelleitungen als eine), Unterbaugruppen unter ihrer
 * Baugruppe, die Versorgung als breiter Kasten darunter, unten die Legende. Die folgenden Seiten
 * enthalten den Klemmenplan (Tabelle aller Anschlüsse) und die Hinweise zur Verdrahtung.
 *
 * Maße, Schriftgrade und Farben folgen einem bewährten Anschlussplan-Vorbild.
 */
import { C, PAGE, color, line, n, pill, rect, text } from './svg.js';
import { STRINGS, tx } from './model.js';

/** Rahmen des Schaltbilds auf Seite 1. */
export const DIAGRAM = {
  top: 135.89,
  bottom: 709.89,
  hubX: 232,
  hubW: 132,
  leftX: 46,
  rightX: 398,
  boxW: 152,
  bottomX: 46,
  bottomW: 504,
};

const GAP = 20; // Abstand untereinander liegender Baugruppen
const CHILD_GAP = 16; // Abstand Baugruppe → Unterbaugruppe
const PIN_GAP = 14;

/** Farbe einer Leitungsart (Kennung) oder direkt angegebene Farbe. */
export function catColor(section, cat) {
  const found = section.categories.find((c) => c.id === cat);
  return color(found ? found.color : cat, C.navy);
}

/** Farbe der Versorgungs-Kennzeichnung („12 V“). */
export const badgeColor = (section) => color(section.badge && section.badge.color, '#b45309');

/** Baugruppen in Zeichenreihenfolge: jede Unterbaugruppe direkt nach ihrer Baugruppe. */
function ordered(boxes) {
  const ids = new Set(boxes.map((b) => b.id));
  const roots = boxes.filter((b) => !b.parent || !ids.has(b.parent) || b.parent === b.id);
  const out = [];
  const seen = new Set();
  const add = (box) => {
    if (seen.has(box.id)) return;
    seen.add(box.id);
    out.push(box);
    for (const child of boxes) if (child.parent === box.id && !seen.has(child.id)) add(child);
  };
  roots.forEach(add);
  boxes.forEach(add); // Zyklen: trotzdem alle zeichnen
  return out;
}

/** Seite einer Baugruppe (Unterbaugruppen erben sie von ihrer obersten Baugruppe). */
export function sideOf(box, byId) {
  for (let b = box, i = 0; b && i < 20; b = byId.get(b.parent), i++)
    if (!b.parent || !byId.has(b.parent) || b.parent === b.id) return b.side;
  return box.side;
}

/** Beschriftung einer Sammelleitung: „D10-D13“ bzw. „A4 / A5“. */
export function busLabel(pins) {
  const names = pins.map((p) => p.label || p.name);
  if (names.length <= 1) return names[0] || '';
  if (names.length === 2) return names.join(' / ');
  return `${names[0]}-${names[names.length - 1]}`;
}

/** Textzeilen einer Baugruppe: Titel und umbrochene Beschreibung (zweisprachig: Englisch grau, kursiv). */
function boxText(ts, box, width) {
  const lines = [];
  const runs = ts.runs(box.lines);
  const titles = ts.runs(box.title);
  for (const r of runs.filter((x) => !x.sec))
    for (const t of ts.wrap(r.text, 8.2, width)) lines.push({ text: t, sec: false });
  const secTitle = titles.find((x) => x.sec);
  if (secTitle)
    for (const t of ts.wrap(secTitle.text, 8.2, width, 700, true)) lines.push({ text: t, sec: true, bold: true });
  for (const r of runs.filter((x) => x.sec))
    for (const t of ts.wrap(r.text, 8.2, width, 400, true)) lines.push({ text: t, sec: true });
  const title = (titles.find((x) => !x.sec) || { text: '' }).text;
  return { title: ts.wrap(title, 9.5, width, 700)[0] || '', lines };
}

const num = (v) => v != null && v !== '' && Number.isFinite(+v);

/**
 * Berechnet das Schaltbild: Kästen, Leitungen, Steuerung. Ergebnis in Seitenkoordinaten vor der
 * Skalierung; passt es nicht auf die Seite, gibt `scale` (< 1) die Verkleinerung um `origin` an.
 */
export function layoutWiring(section, ts) {
  const D = DIAGRAM;
  const byId = new Map(section.boxes.map((b) => [b.id, b]));
  const pins = section.hub.pins;
  const boxes = [];
  const conns = [];
  const links = [];
  const badgeLabel = (section.badge && section.badge.label) || '';
  const cursor = { left: D.top, right: D.top };
  const placed = new Map();

  const measure = (box, x, w) => {
    const { title, lines } = boxText(ts, box, w - 14);
    const count = lines.length;
    const lastBase = count ? 28.5 + 10 * (count - 1) : 15;
    let natural = lastBase + 15.5;
    let badge = null;
    if (box.badge && badgeLabel) {
      const bw = ts.width(badgeLabel, 7.2, 700) + 10;
      badge = { x: x + w - 21.19 - bw, w: bw, label: badgeLabel };
      // „12 V“ neben der letzten Zeile, wenn sie kurz genug ist – sonst darunter
      const last = lines[count - 1];
      const lastRight = last ? x + 7 + ts.width(last.text, 8.2, last.bold ? 700 : 400, last.sec) : x;
      natural = Math.max(natural, lastBase + (lastRight + 6 <= badge.x ? 19.5 : 24));
    }
    return { title, lines, badge, h: Math.max(natural, num(box.h) ? +box.h : 0) };
  };

  // Baugruppen links und rechts (mit Unterbaugruppen)
  for (const box of ordered(section.boxes)) {
    const side = sideOf(box, byId);
    if (side === 'bottom') continue;
    const x = side === 'right' ? D.rightX : D.leftX;
    const m = measure(box, x, D.boxW);
    const parent = box.parent && placed.get(box.parent);
    let y;
    if (num(box.y)) y = D.top + +box.y;
    else if (parent) y = parent.y + parent.h + CHILD_GAP;
    else y = cursor[side] + (cursor[side] === D.top ? 16 : GAP);
    const c = catColor(section, box.cat);
    const item = { id: box.id, box, side, x, y, w: D.boxW, h: m.h, color: c, title: m.title, lines: m.lines };
    if (m.badge) item.badge = { ...m.badge, y: y + m.h - 20 };
    boxes.push(item);
    placed.set(box.id, item);
    cursor[side] = Math.max(cursor[side], y + m.h);
    if (parent) links.push({ x: x + D.boxW / 2, y1: parent.y + parent.h, y2: y, color: c });

    // Leitungen zur Steuerung
    const own = pins.filter((p) => p.box === box.id);
    if (!own.length) continue;
    const groups = box.bus && own.length > 1 ? [own] : own.map((p) => [p]);
    const gap = num(box.pinGap) ? +box.pinGap : PIN_GAP;
    const first = num(box.pinY) ? y + +box.pinY : y + m.h / 2 - (gap * (groups.length - 1)) / 2;
    groups.forEach((group, i) => {
      conns.push({
        box: box.id,
        pins: group.map((p) => p.id),
        side,
        y: first + i * gap,
        x1: side === 'right' ? D.hubX + D.hubW : x + D.boxW,
        x2: side === 'right' ? x : D.hubX,
        color: c,
        label: group.length > 1 ? busLabel(group) : group[0].label || group[0].name,
      });
    });
  }

  const sideBottom = Math.max(D.top + 16, ...boxes.map((b) => b.y + b.h));
  const lowestPin = Math.max(D.top + 44, ...conns.map((c) => c.y));
  const note = ts
    .runs(section.hub.note)
    .flatMap((r) => r.text.split('\n').map((t) => ({ text: t, sec: r.sec })))
    .filter((l) => l.text);
  const noteSpace = note.length ? 41 + 11 * (note.length - 1) + 14 : 0;

  // Versorgung: breite Kästen unter der Steuerung, von unten nach oben an den Rand gesetzt
  const bottoms = [];
  for (const box of section.boxes) {
    if (sideOf(box, byId) !== 'bottom') continue;
    const m = measure(box, D.bottomX, D.bottomW);
    const c = catColor(section, box.cat);
    bottoms.push({
      id: box.id,
      box,
      side: 'bottom',
      x: D.bottomX,
      w: D.bottomW,
      h: m.h,
      color: c,
      fill: box.fill ? color(box.fillColor, tint(c)) : null,
      title: m.title,
      lines: m.lines,
      badge: m.badge,
    });
  }
  let floor = D.bottom;
  for (let i = bottoms.length - 1; i >= 0; i--) {
    const b = bottoms[i];
    b.y = num(b.box.y) ? D.top + +b.box.y : floor - b.h;
    floor = b.y - 10;
  }
  // würde die Versorgung die Seitenkästen überdecken: nach unten schieben (notfalls verkleinert)
  const minTop = Math.max(sideBottom + 32, lowestPin + 30 + noteSpace);
  if (bottoms.length && bottoms[0].y < minTop) {
    const shift = minTop - bottoms[0].y;
    for (const b of bottoms) b.y += shift;
  }
  for (const b of bottoms) if (b.badge) b.badge.y = b.y + b.h - 20;
  boxes.push(...bottoms);

  const hubBottom = bottoms.length
    ? bottoms[0].y - 16
    : Math.max(sideBottom + 16, lowestPin + 14 + noteSpace, D.top + 120);
  const bottomPins = pins.filter((p) => bottoms.some((b) => b.id === p.box));
  const hub = {
    x: D.hubX,
    y: D.top,
    w: D.hubW,
    h: hubBottom - D.top,
    name: ts.runs(section.hub.name),
    model: ts.runs(section.hub.model),
    note,
    bottomLabel: bottomPins.map((p) => p.label || p.name).join(' / '),
  };
  if (bottoms.length)
    links.push({ x: D.hubX + D.hubW / 2, y1: hubBottom, y2: bottoms[0].y, color: bottoms[0].color });

  const contentBottom = Math.max(hubBottom, ...boxes.map((b) => b.y + b.h));
  const scale = contentBottom > D.bottom ? (D.bottom - D.top) / (contentBottom - D.top) : 1;
  return { boxes, conns, links, hub, scale, origin: [PAGE.w / 2, D.top] };
}

/** Helle Füllung zu einer Linienfarbe (für Versorgungskästen ohne eigene Füllfarbe). */
function tint(hex) {
  const v = hex.length === 4 ? hex.slice(1).replace(/./g, '$&$&') : hex.slice(1);
  const mix = (i) => Math.round(255 - (255 - parseInt(v.slice(i, i + 2), 16)) * 0.07);
  return '#' + [0, 2, 4].map((i) => mix(i).toString(16).padStart(2, '0')).join('');
}

/** Kasten einer Baugruppe als SVG. */
function boxSvg(b) {
  let s = rect(b.x, b.y, b.w, b.h, { fill: b.fill || '#fff', stroke: b.color, width: 1.3 });
  s += text(b.x + 7, b.y + 15, b.title, { size: b.side === 'bottom' ? 11 : 9.5, weight: 700, fill: b.color });
  b.lines.forEach((l, i) => {
    s += text(b.x + 7, b.y + 28.5 + 10 * i, l.text, {
      size: 8.2,
      fill: l.sec ? C.muted : C.body,
      italic: l.sec,
      weight: l.bold ? 700 : 400,
    });
  });
  return s;
}

/** Schaltbild als SVG-Gruppe (Seite 1). */
export function wiringDiagramSvg(L, section, ts) {
  const { hub } = L;
  let s = '';
  // Steuerung
  s += rect(hub.x, hub.y, hub.w, hub.h, { fill: C.hub, stroke: C.navy, width: 2 });
  const cx = hub.x + hub.w / 2;
  let ty = hub.y + 22;
  for (const r of hub.name) {
    s += r.sec
      ? text(cx, ty, r.text, { size: 8.2, weight: 700, italic: true, fill: C.muted, anchor: 'middle' })
      : text(cx, ty, r.text, { size: 11.5, weight: 700, anchor: 'middle' });
    ty += r.sec ? 10 : 12;
  }
  for (const r of hub.model) {
    s += text(cx, ty, r.text, { size: 8.2, fill: r.sec ? C.muted : C.body, italic: r.sec, anchor: 'middle' });
    ty += 10;
  }
  const sepY = Math.max(hub.y + 44, ty);
  s += line(hub.x + 10, sepY, hub.x + hub.w - 10, sepY, C.rule, 0.8);
  // Leitungen, Anschlusspunkte und Pin-Beschriftung
  for (const c of L.conns) {
    s += line(c.x1, c.y, c.x2, c.y, c.color, 1.5);
    const right = c.side === 'right';
    s += `<circle cx="${n(right ? hub.x + hub.w : hub.x)}" cy="${n(c.y)}" r="2.6" fill="${C.dot}"/>`;
    s += right
      ? text(hub.x + hub.w - 4, c.y + 3, c.label, { size: 8.6, weight: 700, anchor: 'end' })
      : text(hub.x + 4, c.y + 3, c.label, { size: 8.6, weight: 700 });
  }
  hub.note.forEach((l, i) => {
    const y = hub.y + hub.h - 41 - 11 * (hub.note.length - 1 - i);
    s += text(cx, y, l.text, { size: 7.8, italic: true, fill: C.muted, anchor: 'middle' });
  });
  if (hub.bottomLabel) s += text(cx, hub.y + hub.h - 9, hub.bottomLabel, { size: 8.2, weight: 700, anchor: 'middle' });
  // Verbindungen Baugruppe → Unterbaugruppe und Steuerung → Versorgung
  for (const l of L.links) s += line(l.x, l.y1, l.x, l.y2, l.color, 2.4);
  // Kästen
  const badgeFill = badgeColor(section);
  for (const b of L.boxes) {
    s += boxSvg(b);
    if (b.badge) s += pill(ts, b.badge.x, b.badge.y, b.badge.label, badgeFill).svg;
  }
  if (L.scale < 1) {
    const [ox, oy] = L.origin;
    return `<g transform="translate(${n(ox)} ${n(oy)}) scale(${L.scale.toFixed(4)}) translate(${n(-ox)} ${n(-oy)})">${s}</g>`;
  }
  return `<g>${s}</g>`;
}

/** Legende unter dem Schaltbild; `seePage`: Seite des Klemmenplans (oder null). */
export function legendSvg(section, ts, L, seePage) {
  const base = 733.89;
  const title = ts.label('legend');
  let s = text(PAGE.left, base, title, { size: 9.5, weight: 700 });
  const used = new Set(L.boxes.map((b) => b.color));
  const x0 = Math.max(100, PAGE.left + ts.width(title, 9.5, 700) + 14);
  let x = x0;
  let y = base;
  for (const cat of section.categories) {
    const c = color(cat.color);
    if (!used.has(c)) continue;
    const label = ts.inline(cat.name);
    const w = ts.width(label, 8.5);
    if (x > x0 && x + 25 + w > PAGE.right) {
      x = x0;
      y += 14;
    }
    s += line(x, y - 3, x + 20, y - 3, c, 2.2);
    s += text(x + 25, y, label, { size: 8.5, fill: C.body });
    x += 25 + w + 24;
  }
  y += 18;
  if (section.badge && section.badge.label && L.boxes.some((b) => b.badge)) {
    const p = pill(ts, x0, y - 8, section.badge.label, badgeColor(section));
    s += p.svg;
    s += text(x0 + p.w + 12.19, y, ts.inline(section.badge.text), { size: 8.5, fill: C.body });
    y += 16;
  }
  if (seePage) s += text(PAGE.left, Math.max(767.89, y), ts.label('seePage', { page: seePage }), { size: 8.5, fill: C.body });
  return s;
}

/* ---------- Klemmenplan und Hinweise ---------- */

const COLS = [48, 94, 212, 358];
const COL_RIGHT = [94, 212, 358, PAGE.right];
const HINT_TEXT_W = 489.28;

/** Zellen einer Tabellenzeile: je Spalte die Zeilen [{ text, sec }]. */
function rowCells(ts, pin) {
  const cell = (value, i, weight = 400, fallback = '') => {
    const width = COL_RIGHT[i] - COLS[i] - 6;
    const runs = ts.runs(value);
    if (!runs.length && fallback) runs.push({ text: fallback, sec: false });
    return runs.flatMap((r) =>
      ts.wrap(r.text, 8.8, width, r.sec ? 400 : weight, r.sec).map((t) => ({ text: t, sec: r.sec })),
    );
  };
  return [cell(pin.name, 0, 700), cell(pin.func, 1), cell(pin.terminal, 2, 400, '-'), cell(pin.note, 3)];
}

function hintLines(ts, hint) {
  return ts
    .runs(hint.text)
    .flatMap((r) => ts.wrap(r.text, 9, HINT_TEXT_W, 400, r.sec).map((t) => ({ text: t, sec: r.sec })));
}

const hintHeight = (lines) => 14 + 16 + 12 * Math.max(0, lines.length - 1) + 9;

/**
 * Setzt Klemmenplan und Hinweise in Seiten: [{ svg, hits }]. Tabellenzeilen laufen auf
 * Folgeseiten weiter (mit wiederholter Kopfzeile), Hinweiskarten werden nicht geteilt.
 */
export function terminalPages(section, ts, { top = 132, bottom = 770 } = {}) {
  const pages = [];
  let svg = '';
  let hits = [];
  let y = top;
  const flush = () => {
    pages.push({ svg, hits });
    svg = '';
    hits = [];
    y = top;
  };
  const heading = (label) => {
    svg += text(PAGE.left, y, label, { size: 12, weight: 700 });
    y += 22;
  };
  const header = () => {
    const h = ts.bi ? 28 : 20;
    svg += rect(PAGE.left, y, 511, h, { fill: C.navy });
    ['pin', 'func', 'connected', 'remark'].forEach((key, i) => {
      svg += text(COLS[i], y + 13, tx(STRINGS[key], ts.lang), { size: 9, weight: 700, fill: '#fff' });
      const en = STRINGS[key].en;
      if (ts.bi && en !== STRINGS[key].de)
        svg += text(COLS[i], y + 23, en, { size: 7.5, italic: true, fill: '#c8d3db' });
    });
    y += h;
  };

  const pins = section.hub.pins;
  if (pins.length) {
    heading(ts.label('pinTableOf', { name: ts.inline(section.hub.short) || ts.inline(section.hub.name) }));
    header();
    pins.forEach((pin, i) => {
      const cells = rowCells(ts, pin);
      const h = 16 + 10.56 * (Math.max(1, ...cells.map((c) => c.length)) - 1);
      if (y + h > bottom) {
        flush();
        header();
      }
      if (i % 2 === 0) svg += rect(PAGE.left, y, 511, h, { fill: C.alt });
      cells.forEach((lines, col) =>
        lines.forEach((l, k) => {
          svg += text(COLS[col], y + 11 + 10.56 * k, l.text, {
            size: 8.8,
            weight: col === 0 && !l.sec ? 700 : 400,
            italic: l.sec,
            fill: l.sec ? C.muted : col === 0 ? C.navy : C.body,
          });
        }),
      );
      svg += line(PAGE.left, y + h, 553, y + h, C.rule, 0.5);
      hits.push({ kind: 'pin', id: pin.id, rect: [PAGE.left, y, 511, h] });
      y += h;
    });
    y += 26;
  }

  const hints = section.hints.filter((h) => ts.runs(h.title).length || ts.runs(h.text).length);
  if (hints.length) {
    // Überschrift nicht allein am Seitenende
    if (y + 10 + hintHeight(hintLines(ts, hints[0])) > bottom && y > top) flush();
    heading(ts.label('hints'));
    y -= 12; // Karte beginnt 10 pt unter der Grundlinie der Überschrift
    for (const hint of hints) {
      let lines = hintLines(ts, hint);
      const c = catColor(section, hint.cat);
      const title = ts.inline(hint.title);
      // passt die Karte nicht mehr auf die Seite: neue Seite; länger als eine Seite: aufteilen
      if (y + hintHeight(lines) > bottom && y > top + 30) flush();
      for (let part = 0; lines.length; part++) {
        const room = Math.floor((bottom - y - 39) / 12) + 1;
        if (room < 2 && y > top) {
          flush();
          continue;
        }
        const chunk = lines.slice(0, Math.max(1, room));
        lines = lines.slice(chunk.length);
        const h = hintHeight(chunk);
        svg += rect(PAGE.left, y, 511.276, h, { fill: C.card }) + rect(PAGE.left, y, 4, h, { fill: c });
        svg += text(56, y + 14, part ? `${title} (${ts.label('continued')})` : title, { size: 9.8, weight: 700, fill: c });
        chunk.forEach((l, i) => {
          svg += text(56, y + 30 + 12 * i, l.text, { size: 9, fill: l.sec ? C.muted : C.body, italic: l.sec });
        });
        hits.push({ kind: 'hint', id: hint.id, rect: [PAGE.left, y, 511.276, h] });
        y += h + 8;
        if (lines.length) flush();
      }
    }
  }
  if (svg) pages.push({ svg, hits });
  return pages;
}

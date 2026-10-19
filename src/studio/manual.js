/**
 * Bedienungsanleitung im Stil des Vorbilds: Deckblatt, Kapitel mit Kapitelkopf („01“), Kopf- und
 * Fußzeile, Deutsch und Englisch nebeneinander (bei einer Sprache volle Breite), Hinweis- und
 * Warnkästen, Abbildungen mit nummerierten Positionen und Legende, Schritte mit Fotos, Störungs-
 * und Lieferumfangstabellen.
 *
 * Alle Maße stammen aus dem Vorbild (mm bzw. pt, umgerechnet in pt). Schrift: Barlow, Überschriften
 * Barlow Semi Condensed. Text kennt zwei Auszeichnungen: **fett** und {7} (Position 7 im Kreis).
 */
import { PAGE, color, esc, n } from './svg.js';
import { textWidth as measure } from './measure.js';

/** Breite mit Unterschneidung (das Vorbild setzt mit Kerning). */
const textWidth = (t, size, style) => measure(t, size, { ...style, kern: true });
import { tx } from './model.js';

export const MM = 72 / 25.4;
const L = 18 * MM;
const R = PAGE.w - 18 * MM;
const CW = R - L;
const TOP = 21 * MM;
const BOT = PAGE.h - 19 * MM;
const GAP = 8 * MM;
const COL = (CW - GAP) / 2;
const NUMW = 8.5 * MM;

export const BODY = '"PDFix Barlow", Barlow, Helvetica, Arial, sans-serif';
const HEAD = '"PDFix Barlow SC", "Barlow Semi Condensed", "PDFix Barlow", Barlow, sans-serif';

const K = {
  ink: '#15191d',
  ink2: '#262c32',
  en: '#5d6772',
  muted: '#8a939c',
  rule: '#c9ced4',
  hair: '#dde1e5',
  tint: '#f3f4f6',
  mark: '#1b2229',
};

/** Hinweiskästen: Farbe, Hintergrund, Zeichen und Signalwort. */
const TONES = {
  danger: { bar: '#f2b705', bg: '#fdf7e1', icon: 'caution', word: ['Vorsicht', 'Caution'] },
  warn: { bar: '#e8710a', bg: '#fdefe3', icon: 'warning', word: ['Warnung', 'Warning'] },
  note: { bar: null, bg: '#eef2f6', icon: 'notice', word: ['Hinweis', 'Notice'] },
  open: { bar: '#8a939c', bg: '#f3f4f6', icon: 'open', word: ['Offen', 'Open'] },
};

/** Grundlinie einer Zeile (Barlow: Oberlänge 1,0 em, Unterlänge 0,2 em). */
const base = (top, size, lh) => top + (lh - 1.2 * size) / 2 + size;

/* ---------- Text mit Auszeichnung ---------- */

/** Text in Stücke: Wörter (fett oder normal), Positionskreise {7}, Zeilenumbrüche. */
function pieces(value) {
  const out = [];
  let bold = false;
  for (const para of String(value || '').split('\n')) {
    if (out.length) out.push({ t: 'br' });
    for (const part of para.split(/(\*\*|\{\d{1,2}\})/)) {
      if (part === '**') bold = !bold;
      else if (/^\{\d{1,2}\}$/.test(part)) out.push({ t: 'ref', n: part.slice(1, -1) });
      else if (part)
        part.split(/( +)/).forEach((w) => {
          if (/^ +$/.test(w)) out.push({ t: 'sp' });
          else if (w) out.push({ t: 'w', text: w, bold });
        });
    }
  }
  return out;
}

const refW = (num, size) => Math.max(3.5 * MM, textWidth(num, size * 0.74, { family: BODY, weight: 600 }) + 1.4 * MM) + 0.6 * MM;

/**
 * Bricht ausgezeichneten Text in Zeilen um: [{ items: [{ kind, x, text?, bold?, n? }], w }].
 * Ein Positionskreis bleibt beim vorangehenden Wort (geschütztes Leerzeichen wie im Vorbild).
 */
export function layoutRich(value, size, width, o = {}) {
  const fam = o.family || BODY;
  const wBold = o.boldWeight || 600;
  const ws = (t, b) => textWidth(t, size, { family: fam, weight: b ? wBold : o.weight || 400 }) + (o.ls || 0) * t.length;
  const space = ws(' ', false);
  const lines = [];
  // o.indent: erste Zeile beginnt weiter rechts (z. B. hinter einem Signalwort)
  let cur = { items: [], w: o.indent || 0 };
  let pendingSpace = false;
  const flush = () => {
    lines.push(cur);
    cur = { items: [], w: 0 };
    pendingSpace = false;
  };
  const ps = pieces(value);
  // Wörter samt folgendem Kreis als untrennbare Gruppe
  const groups = [];
  for (let i = 0; i < ps.length; i++) {
    const p = ps[i];
    if (p.t === 'br' || p.t === 'sp') groups.push(p);
    else {
      const g = { t: 'g', parts: [p] };
      while (i + 2 < ps.length && ps[i + 1].t === 'sp' && ps[i + 2].t === 'ref') {
        g.parts.push({ t: 'nbsp' }, ps[i + 2]);
        i += 2;
      }
      while (i + 1 < ps.length && ps[i + 1].t !== 'sp' && ps[i + 1].t !== 'br') g.parts.push(ps[++i]);
      groups.push(g);
    }
  }
  const partW = (p) => (p.t === 'w' ? ws(p.text, p.bold) : p.t === 'ref' ? refW(p.n, size) : p.t === 'nbsp' ? space : 0);
  for (const g of groups) {
    if (g.t === 'br') {
      flush();
      continue;
    }
    if (g.t === 'sp') {
      pendingSpace = cur.items.length > 0;
      continue;
    }
    const gw = g.parts.reduce((s, p) => s + partW(p), 0);
    const lead = pendingSpace ? space : 0;
    if ((cur.items.length || cur.w) && cur.w + lead + gw > width) flush();
    let x = cur.w + (cur.items.length && pendingSpace ? space : 0);
    for (const p of g.parts) {
      const w = partW(p);
      if (p.t === 'w') cur.items.push({ kind: 'w', x, text: p.text, bold: p.bold, w });
      else if (p.t === 'ref') cur.items.push({ kind: 'ref', x, n: p.n, w });
      x += w;
    }
    cur.w = x;
    pendingSpace = false;
  }
  if (cur.items.length || !lines.length) lines.push(cur);
  return lines;
}

/**
 * Zeichnet umbrochene Zeilen ab (x, y = Oberkante). `o`: size, lh, fill, boldFill, family, weight,
 * ls (Sperrung), upper.
 */
function drawRich(lines, x, y, o) {
  let s = '';
  const fam = o.family || BODY;
  lines.forEach((line, i) => {
    const bl = base(y + i * o.lh, o.size, o.lh);
    // gleiche Auszeichnung hintereinander als ein Textstück
    let run = null;
    const out = () => {
      if (!run) return;
      s += `<text x="${n(x + run.x)}" y="${n(bl)}" font-size="${o.size}" font-family="${esc(fam)}"${run.bold || o.weight ? ` font-weight="${run.bold ? o.boldWeight || 600 : o.weight}"` : ''}${o.ls ? ` letter-spacing="${o.ls}"` : ''} fill="${run.bold ? o.boldFill || o.fill : o.fill}">${esc(run.text.replace(/ {2,}/g, (m) => ' ' + ' '.repeat(m.length - 1)))}</text>`;
      run = null;
    };
    for (const it of line.items) {
      if (it.kind === 'ref') {
        out();
        s += refSvg(x + it.x + 0.3 * MM, bl, it.n, o.size, o.refFill || o.fill, it.w - 0.6 * MM);
        continue;
      }
      if (run && run.bold === it.bold && Math.abs(run.end - it.x) < 6) {
        run.text += ' ' + it.text;
        run.end = it.x + it.w;
      } else {
        out();
        run = { x: it.x, text: it.text, bold: it.bold, end: it.x + it.w };
      }
    }
    out();
  });
  return s;
}

/** Position im Text: Zahl in einem gerundeten Rahmen (3,5 mm hoch). */
function refSvg(x, bl, num, size, fill, w) {
  const h = 3.5 * MM;
  const top = bl - size * 0.72 - 0.15 * MM;
  return (
    `<rect x="${n(x)}" y="${n(top)}" width="${n(w)}" height="${n(h)}" rx="${n(2 * MM)}" fill="none" stroke="${fill}" stroke-width="0.45"/>` +
    `<text x="${n(x + w / 2)}" y="${n(top + h / 2 + 2.2)}" font-size="6.4" font-weight="600" font-family="${esc(BODY)}" fill="${fill}" text-anchor="middle">${esc(num)}</text>`
  );
}

/** Nummer im Kreis (4,4 mm) – Legenden und Abbildungen. */
function numCircle(cx, cy, num, r = 2.2 * MM, size = 7) {
  return (
    `<circle cx="${n(cx)}" cy="${n(cy)}" r="${n(r)}" fill="#fff" stroke="${K.ink}" stroke-width="0.5"/>` +
    `<text x="${n(cx)}" y="${n(cy + size * 0.36)}" font-size="${size}" font-weight="600" font-family="${esc(BODY)}" fill="${K.ink}" text-anchor="middle">${esc(num)}</text>`
  );
}

const rect = (x, y, w, h, fill) => `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${fill}"/>`;
const hline = (x1, x2, y, stroke, w) => `<line x1="${n(x1)}" y1="${n(y)}" x2="${n(x2)}" y2="${n(y)}" stroke="${stroke}" stroke-width="${w}"/>`;
const label = (x, y, value, o) =>
  value
    ? `<text x="${n(x)}" y="${n(y)}" font-size="${o.size}" font-family="${esc(o.family || BODY)}"${o.weight && o.weight !== 400 ? ` font-weight="${o.weight}"` : ''}${o.ls ? ` letter-spacing="${o.ls}"` : ''}${o.anchor ? ` text-anchor="${o.anchor}"` : ''} fill="${o.fill}">${esc(String(value).replace(/^ +| +$| {2,}/g, (m) => '\u00a0'.repeat(m.length)))}</text>`
    : '';
const width = (value, size, family = BODY, weight = 400, ls = 0) => textWidth(value, size, { family, weight }) + ls * String(value).length;

/* ---------- Zeichen ---------- */

const ICONS = {
  caution: (x, y, w) =>
    `<svg x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(w * 0.88)}" viewBox="0 0 100 88"><path d="M50 4 L96 84 H4 Z" fill="#f9c80e" stroke="#111" stroke-width="7" stroke-linejoin="round"/><path d="M50 30 V60" stroke="#111" stroke-width="9" stroke-linecap="round"/><circle cx="50" cy="72" r="5.2" fill="#111"/></svg>`,
  warning: (x, y, w) =>
    `<svg x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(w * 0.88)}" viewBox="0 0 100 88"><path d="M50 4 L96 84 H4 Z" fill="#f08a24" stroke="#111" stroke-width="7" stroke-linejoin="round"/><path d="M50 30 V60" stroke="#111" stroke-width="9" stroke-linecap="round"/><circle cx="50" cy="72" r="5.2" fill="#111"/></svg>`,
  notice: (x, y, w, c) =>
    `<svg x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(w)}" viewBox="0 0 100 100"><rect width="100" height="100" rx="10" fill="${c}"/><circle cx="50" cy="25" r="8.5" fill="#fff"/><rect x="42" y="40" width="16" height="42" fill="#fff"/></svg>`,
  open: (x, y, w) =>
    `<svg x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(w)}" viewBox="0 0 100 100"><circle cx="50" cy="50" r="44" fill="none" stroke="#8a939c" stroke-width="9"/><path d="M50 26 V54 L66 64" fill="none" stroke="#8a939c" stroke-width="9" stroke-linecap="round"/></svg>`,
};

/* ---------- Seitensatz ---------- */

/**
 * Kontext des Satzes: Sprachen, Farben, Text-Helfer. `bi` = Deutsch und Englisch nebeneinander.
 */
function context(project) {
  const langs = project.lang === 'de+en' ? ['de', 'en'] : [project.lang || 'de'];
  const m = project.manual || {};
  return {
    langs,
    bi: langs.length > 1,
    lang: langs[0],
    navy: color(m.accent, '#0c4061'),
    accent2: color(m.accent2, color(m.accent, '#0c4061')),
    /** Text einer Sprache (bei nur Englisch die englische Fassung). */
    t: (v, lang) => (typeof v === 'string' ? v : tx(v, lang)),
  };
}

/** Spalten eines zweisprachigen Rasters: [{ lang, x, w }] (bei einer Sprache volle Breite). */
function cols(cx, x = L, w = CW, gap = GAP) {
  if (!cx.bi) return [{ lang: cx.lang, x, w, main: true }];
  const cw = (w - gap) / 2;
  return [
    { lang: 'de', x, w: cw, main: true },
    { lang: 'en', x: x + cw + gap, w: cw, main: false },
  ];
}

/** Zeilen einer Liste (ein Eintrag je Zeile) in einer Sprache. */
const items = (cx, v, lang) =>
  String(cx.t(v, lang) || '')
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

/** „**Bauteil** Beschreibung“ – ohne Leerzeichen vor Satzzeichen („**Lid**, metal“). */
const named = (name, desc) => {
  const d = String(desc || '').trim();
  if (!name) return d;
  return d ? `**${name}**${/^[,.;:)]/.test(d) ? '' : ' '}${d}` : `**${name}**`;
};

/** Nummern der Positionen: Kennung der Position → Nummer (fortlaufend über das Dokument). */
export function markNumbers(project) {
  const out = new Map();
  let k = 0;
  for (const s of project.sections)
    if (s.type === 'chapters') for (const b of s.blocks) if (b.type === 'figure') for (const m of b.marks || []) out.set(m.id, String(++k));
  return out;
}

/** Nummern der Kapitel (01), Unterkapitel (1.1) und Abbildungen eines Abschnitts. */
function numbers(section, start) {
  const out = new Map();
  let h1 = start.h1;
  let h2 = 0;
  let fig = start.fig;
  for (const b of section.blocks) {
    if (b.type === 'h' && b.level === 1) {
      h1++;
      h2 = 0;
      out.set(b.id, String(h1).padStart(2, '0'));
    } else if (b.type === 'h' && b.level === 2) out.set(b.id, `${h1}.${++h2}`);
    else if (b.type === 'figure' || b.type === 'figsteps') out.set(b.id, String(++fig));
  }
  return { map: out, end: { h1, fig } };
}

/**
 * Bausteine eines Kapitel-Abschnitts als Atome: { h, mt, mb, draw(y) → { svg, hits }, keepNext,
 * pageBreak, chapter }.
 */
function atomsOf(section, project, cx, nums, marks) {
  const atoms = [];
  const add = (a) => atoms.push({ mt: 0, mb: 0, ...a });
  const images = project.images;
  const usage = signsUsed(project);

  for (const b of section.blocks) {
    const id = b.id;
    if (b.type === 'h' && b.level === 1) {
      const num = nums.get(id);
      const tw = CW - NUMW;
      const titles = cx.langs.map((lang, i) => ({ lines: layoutRich(cx.t(b.text, lang), 21, tw, { family: HEAD, weight: 600 }), sec: i > 0 }));
      const lines = titles.flatMap((t) => t.lines.map((l) => ({ ...l, sec: t.sec })));
      const h = Math.max(1.4 + 2.4 * MM + 10, 0.25 + 1.2 * MM + lines.length * 22.5);
      add({
        h,
        mb: 6 * MM,
        pageBreak: true,
        keepNext: true,
        chapter: { num, de: cx.t(b.text, 'de'), en: cx.bi ? cx.t(b.text, 'en') : '', main: cx.t(b.text, cx.lang) },
        block: id,
        draw: (y) => {
          let s = `<line x1="${n(L)}" y1="${n(y + 0.7)}" x2="${n(L + 6.5 * MM)}" y2="${n(y + 0.7)}" stroke="${cx.navy}" stroke-width="1.4"/>`;
          s += label(L, base(y + 1.4 + 2.4 * MM, 10, 10), num, { size: 10, family: HEAD, weight: 600, fill: cx.navy, ls: 0.4 });
          s += hline(L + NUMW, R, y + 0.125, K.rule, 0.25);
          lines.forEach((l, i) => {
            s += drawRich([l], L + NUMW, y + 0.25 + 1.2 * MM + i * 22.5, { size: 21, lh: 22.5, family: HEAD, weight: l.sec ? 400 : 600, boldWeight: 600, fill: l.sec ? K.muted : K.ink });
          });
          return s;
        },
      });
    } else if (b.type === 'h' && b.level === 2) {
      const num = nums.get(id);
      const cs = cols(cx);
      const parts = cs.map((c) => ({ c, lines: layoutRich(cx.t(b.text, c.lang), 10.4, c.w - NUMW, { family: HEAD, weight: c.main ? 600 : 500 }) }));
      const h = 1.6 * MM + Math.max(...parts.map((p) => p.lines.length)) * 12.4;
      add({
        h,
        mt: 4.2 * MM,
        mb: 1.5 * MM,
        keepNext: true,
        block: id,
        draw: (y) => {
          let s = hline(L, R, y + 0.125, K.hair, 0.25);
          for (const { c, lines } of parts) {
            s += label(c.x, base(y + 1.6 * MM, 10.4, 12.4), num, { size: 10.4, family: HEAD, weight: 500, fill: c.main ? cx.navy : K.muted });
            s += drawRich(lines, c.x + NUMW, y + 1.6 * MM, { size: 10.4, lh: 12.4, family: HEAD, weight: c.main ? 600 : 500, boldWeight: 600, fill: c.main ? K.ink : K.en });
          }
          return s;
        },
      });
    } else if (b.type === 'h') {
      const cs = cols(cx);
      const parts = cs.map((c) => ({ c, lines: layoutRich(cx.t(b.text, c.lang), 9.4, c.w, { family: HEAD, weight: c.main ? 600 : 500 }) }));
      add({
        h: Math.max(...parts.map((p) => p.lines.length)) * 11,
        mt: 3.4 * MM,
        mb: 1.2 * MM,
        keepNext: true,
        block: id,
        draw: (y) => parts.map(({ c, lines }) => drawRich(lines, c.x, y, { size: 9.4, lh: 11, family: HEAD, weight: c.main ? 600 : 500, fill: c.main ? K.ink : K.en })).join(''),
      });
    } else if (b.type === 'p') {
      const size = b.small ? 7.9 : 8.7;
      const lh = b.small ? 11 : 12.4;
      const parts = cols(cx).map((c) => ({ c, lines: layoutRich(cx.t(b.text, c.lang), size, c.w) }));
      const rows = Math.max(...parts.map((p) => p.lines.length));
      // lange Absätze laufen zeilenweise über die Seite
      for (let from = 0; from < rows; from += 8) {
        const to = Math.min(rows, from + 8);
        add({
          h: (to - from) * lh,
          mt: from === 0 ? (b.small ? 1.6 * MM : 0) : 0,
          mb: to === rows ? 4.2 : 0,
          block: id,
          draw: (y) =>
            parts.map(({ c, lines }) => drawRich(lines.slice(from, to), c.x, y, { size, lh, fill: c.main ? K.ink2 : K.en, boldFill: c.main ? K.ink : K.en, refFill: c.main ? K.ink : K.en })).join(''),
        });
      }
    } else if (b.type === 'ul' || b.type === 'steps') {
      const steps = b.type === 'steps';
      const cs = cols(cx);
      const lists = cs.map((c) => items(cx, b.text, c.lang));
      const count = Math.max(...lists.map((l) => l.length));
      for (let k = 0; k < count; k++) {
        const indent = steps ? NUMW : 4 * MM;
        const parts = cs.map((c, i) => ({ c, lines: layoutRich(lists[i][k] || '', 8.7, c.w - indent), has: !!lists[i][k] }));
        const pad = steps ? [1.3 * MM, 1.2 * MM] : [1.2 * MM, 1.1 * MM];
        const h = pad[0] + Math.max(...parts.map((p) => p.lines.length)) * 12.4 + pad[1];
        const last = k === count - 1;
        add({
          h,
          block: id,
          draw: (y) => {
            let s = last ? '' : hline(L, R, y + h - 0.125, K.hair, 0.25);
            for (const { c, lines, has } of parts) {
              if (!has) continue;
              const fill = c.main ? K.ink2 : K.en;
              if (steps) s += label(c.x, base(y + pad[0], 11, 12.4), String(k + 1), { size: 11, family: HEAD, weight: 600, fill: c.main ? cx.navy : K.muted });
              else s += rect(c.x, y + pad[0] + 2.05 * MM, 2.1 * MM, 0.5, fill);
              s += drawRich(lines, c.x + indent, y + pad[0], { size: 8.7, lh: 12.4, fill, boldFill: c.main ? K.ink : K.en });
            }
            return s;
          },
        });
      }
    } else if (b.type === 'callout') atomsCallout(add, b, cx);
    else if (b.type === 'signs') atomsSigns(add, b, cx, usage);
    else if (b.type === 'figure') atomsFigure(add, b, cx, nums, marks, images);
    else if (b.type === 'figsteps') atomsFigsteps(add, b, cx, nums, images);
    else if (b.type === 'cards') atomsCards(add, b, cx, images);
    else if (b.type === 'table') atomsTable(add, b, cx);
    else if (b.type === 'code' || b.type === 'formula') {
      const lines = layoutRich(b.text || '', 8.2, CW - 6 * MM);
      add({
        h: lines.length * 11 + 4 * MM,
        mt: 2.6 * MM,
        mb: 2 * MM,
        block: id,
        draw: (y) => rect(L, y, CW, lines.length * 11 + 4 * MM, K.tint) + drawRich(lines, L + 3 * MM, y + 2 * MM, { size: 8.2, lh: 11, fill: K.ink }),
      });
    }
  }
  return atoms;
}

/** Welche Zeichen das Dokument verwendet (für die Zeichenerklärung 1.1). */
function signsUsed(project) {
  const used = { danger: false, warn: false, note: false, refs: false };
  for (const s of project.sections) {
    if (s.type !== 'chapters') continue;
    for (const b of s.blocks) {
      if (b.type === 'callout' && b.tone in used) used[b.tone] = true;
      if (b.type === 'figure' && (b.marks || []).length) used.refs = true;
      if (/\{\d{1,2}\}/.test(JSON.stringify(b))) used.refs = true;
    }
  }
  return used;
}

const SIGN_TEXT = {
  danger: [
    'kennzeichnet eine gefährliche Situation, die zu leichten oder mittelschweren Verletzungen führen kann, wenn sie nicht vermieden wird.',
    'indicates a hazardous situation which, if not avoided, could result in minor or moderate injury.',
  ],
  warn: [
    'kennzeichnet eine gefährliche Situation, die zum Tod oder zu schweren Verletzungen führen kann, wenn sie nicht vermieden wird.',
    'indicates a hazardous situation which, if not avoided, could result in death or serious injury.',
  ],
  note: [
    'kennzeichnet mögliche Sachschäden sowie Informationen, die für die richtige Bedienung wichtig sind.',
    'indicates possible damage to property and information that is important for correct operation.',
  ],
  refs: ['Zahlen in Kreisen verweisen auf die Positionen in den Abbildungen.', 'Circled numbers refer to the items in the figures.'],
};

/** Zeichenerklärung: je verwendetem Zeichen eine Zeile (ohne Verwendung: Vorsicht und Hinweis). */
function atomsSigns(add, b, cx, used) {
  let keys = ['warn', 'danger', 'note', 'refs'].filter((k) => used[k]);
  if (!keys.length) keys = ['danger', 'note'];
  keys.forEach((key, i) => {
    const tone = TONES[key];
    // Signalwort in gesperrten Versalien (Barlow Semi Condensed), danach der Text
    const words = [];
    const rows = legendCols(cx).map((c) => {
      const li = c.lang === 'en' ? 1 : 0;
      const word = key === 'refs' ? '' : tone.word[li].toUpperCase();
      const ww = word ? width(word, 8, HEAD, 600, 0.64) + width(' ', 8.7) : 0;
      words.push({ c, word });
      return { c, lines: layoutRich(SIGN_TEXT[key][li], 8.7, c.w, { indent: ww }) };
    });
    legendRow(add, b.id, cx, rows, i, keys.length, (y) => {
      let w = '';
      for (const { c, word } of words) w += label(c.x, base(y + 1.05 * MM, 8.7, 12.4), word, { size: 8, family: HEAD, weight: 600, ls: 0.64, fill: c.main ? K.ink : K.en });
      if (key === 'refs') return refSvg(L, base(y + 1.05 * MM, 8.7, 12.4), '7', 8.7, K.ink, 3.5 * MM);
      return w + (() => {
        const iw = key === 'note' ? 4.2 * MM : 4.8 * MM;
        return ICONS[tone.icon](L, y + 1.05 * MM + 0.4 * MM, iw, cx.navy);
      })();
    }, { sig: true });
  });
}

/** Spalten einer Legende: 8,5 mm Nummer | 74,5 mm Deutsch | Englisch (mit 8 mm Einzug). */
function legendCols(cx, narrow = false, x = L, w = CW) {
  if (!cx.bi) return [{ lang: cx.lang, x: x + NUMW, w: w - NUMW, main: true }];
  if (narrow) {
    const cw = (w - NUMW) / 2;
    return [
      { lang: 'de', x: x + NUMW, w: cw - 2 * MM, main: true },
      { lang: 'en', x: x + NUMW + cw + 4 * MM, w: cw - 4 * MM, main: false },
    ];
  }
  return [
    { lang: 'de', x: x + NUMW, w: 74.5 * MM - 2 * MM, main: true },
    { lang: 'en', x: x + NUMW + 74.5 * MM + 8 * MM, w: w - NUMW - 74.5 * MM - 8 * MM, main: false },
  ];
}

/** Zeile einer Legende mit Linien (erste oben, letzte unten kräftiger). */
function legendRow(add, block, cx, rows, i, count, lead, o = {}) {
  // Zeichenerklärung: das Signalwort in der schmalen Schrift streckt die erste Zeile (wie im Vorbild)
  const extra = o.sig ? 2.4 : 0;
  const h = 1.05 * MM + extra + Math.max(...rows.map((r) => r.lines.length)) * 12.4 + 1 * MM;
  add({
    h,
    block,
    draw: (y) => {
      let s = '';
      if (i === 0) s += hline(o.x ?? L, (o.x ?? L) + (o.w ?? CW), y + 0.125, K.rule, 0.25);
      s += hline(o.x ?? L, (o.x ?? L) + (o.w ?? CW), y + h - 0.125, i === count - 1 ? K.rule : K.hair, 0.25);
      s += lead(y + extra);
      for (const { c, lines } of rows)
        s += drawRich(lines, c.x, y + 1.05 * MM + extra, {
          size: 8.7,
          lh: 12.4,
          fill: c.main ? (o.sig || o.ink ? K.ink : K.ink2) : K.en,
          boldFill: c.main ? K.ink : K.en,
          refFill: c.main ? K.ink : K.en,
          ...(o.sig ? { boldWeight: 600 } : {}),
        });
      return s;
    },
  });
  return h;
}

/** Hinweis- und Warnkasten: Balken links, Zeichen, Signalwort, Text (zweisprachig nebeneinander). */
function atomsCallout(add, b, cx) {
  const tone = TONES[b.tone] || TONES.note;
  const bar = tone.bar || cx.navy;
  const x0 = L + 1.1 * MM + 7.4 * MM;
  const inner = R - 3 * MM - x0;
  const own = cx.langs.map((l) => cx.t(b.title, l));
  const words = cx.langs.map((l, i) => (own[i] || tone.word[l === 'en' ? 1 : 0]).toUpperCase());
  const parts = cx.bi
    ? [
        { lang: 'de', x: x0, w: 74.5 * MM, main: true },
        { lang: 'en', x: x0 + 74.5 * MM + GAP, w: inner - 74.5 * MM - GAP, main: false },
      ]
    : [{ lang: cx.lang, x: x0, w: inner, main: true }];
  const texts = parts.map((c) => ({ c, lines: layoutRich(cx.t(b.text, c.lang), 8.7, c.w) }));
  const body = Math.max(...texts.map((t) => t.lines.length)) * 12.4;
  const h = 2.3 * MM + 9 + 1.1 * MM + body + 2 * MM;
  add({
    h,
    mt: 2.6 * MM,
    mb: 2.6 * MM,
    block: b.id,
    draw: (y) => {
      let s = rect(L, y, CW, h, tone.bg) + rect(L, y, 1.1 * MM, h, bar);
      const iw = tone.icon === 'caution' || tone.icon === 'warning' ? 5.6 * MM : 4.2 * MM;
      s += ICONS[tone.icon](L + 1.1 * MM + (7.4 * MM - iw) / 2, y + 2.3 * MM + 0.3 * MM, iw, cx.navy);
      const wb = base(y + 2.3 * MM, 8, 9);
      s += label(x0, wb, words[0], { size: 8, family: HEAD, weight: 600, ls: 0.96, fill: K.ink });
      if (cx.bi) s += label(x0 + width(words[0], 8, HEAD, 600, 0.96) + 2.4 * MM, wb, words[1], { size: 8, family: HEAD, weight: 500, ls: 0.96, fill: K.en });
      const ty = y + 2.3 * MM + 9 + 1.1 * MM;
      for (const { c, lines } of texts) s += drawRich(lines, c.x, ty, { size: 8.7, lh: 12.4, fill: c.main ? K.ink : K.en, boldFill: c.main ? K.ink : K.en });
      return s;
    },
  });
}

/** Bild in einen Rahmen einpassen: { w, h } (ohne Bild: Platzhalter 4 : 3). */
function fitImage(img, maxW, maxH) {
  if (!img || !img.w || !img.h) return { w: maxW, h: Math.min(maxH, maxW * 0.75) };
  const s = Math.min(maxW / img.w, maxH / img.h);
  return { w: img.w * s, h: img.h * s };
}

const imageSvg = (img, x, y, w, h) =>
  img && img.data
    ? `<image href="${esc(img.data)}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"/>`
    : `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" fill="${K.tint}" stroke="${K.rule}" stroke-width="0.6" stroke-dasharray="4 3"/>` +
      label(x + w / 2, y + h / 2 + 3, 'Bild wählen', { size: 8.5, fill: K.muted, anchor: 'middle' });

/**
 * Positionen einer Abbildung zeichnen: Punkt mit Hinweislinie zum Kreis links bzw. rechts neben
 * dem Bild. Kreise einer Seite rücken auseinander, wenn sie sich überdecken würden.
 */
function marksLayout(b, ix, iy, iw, ih, left, right) {
  const placed = (b.marks || []).map((m) => {
    const px = ix + m.x * iw;
    const py = iy + m.y * ih;
    const side = m.side === 'l' || (m.side === 'auto' && m.x < 0.5) ? 'l' : 'r';
    const ly = typeof m.ly === 'number' ? iy + m.ly * ih : py;
    return { m, px, py, side, cy: ly, cx: side === 'l' ? left : right };
  });
  for (const side of ['l', 'r']) {
    const list = placed.filter((p) => p.side === side).sort((a, b) => a.cy - b.cy);
    for (let i = 1; i < list.length; i++) if (list[i].cy - list[i - 1].cy < 5.6 * MM) list[i].cy = list[i - 1].cy + 5.6 * MM;
  }
  return placed;
}

function marksSvg(placed, numsOf) {
  let s = '';
  for (const p of placed) {
    const r = 2.2 * MM;
    const ex = p.side === 'l' ? p.cx + r : p.cx - r;
    const d = `M${n(p.px)},${n(p.py)} L${n(ex)},${n(p.cy)}`;
    s += `<path d="${d}" stroke="#fff" stroke-width="${n(0.56 * MM)}" fill="none" stroke-linecap="round"/><path d="${d}" stroke="${K.mark}" stroke-width="${n(0.2 * MM)}" fill="none"/>`;
    s += `<circle cx="${n(p.px)}" cy="${n(p.py)}" r="${n(0.62 * MM)}" fill="${K.mark}" stroke="#fff" stroke-width="${n(0.28 * MM)}"/>`;
    s += `<circle cx="${n(p.cx)}" cy="${n(p.cy)}" r="${n(r)}" fill="#fff" stroke="${K.mark}" stroke-width="${n(0.2 * MM)}"/>`;
    s += label(p.cx, p.cy + 2.75 * MM * 0.36 + 0.4, numsOf(p.m.id), { size: n(2.75 * MM), weight: 600, fill: K.mark, anchor: 'middle' });
  }
  return s;
}

/**
 * Bildunterschrift „Abb. 1 …“: zweisprachig nebeneinander (ganze Breite) oder in einer Zeile
 * „Abb. 2 Bedienfeld   Fig. 2 Control panel“ (schmale Abbildungen; Englisch grau). Rückgabe
 * { h, draw(y) }.
 */
function caption(b, cx, num, inline, x = L, w = CW) {
  const word = { de: 'Abb.', en: 'Fig.' };
  const text = (lang) => `**${word[lang] || 'Abb.'} ${num}** ${cx.t(b.caption, lang) || ''}`.trim();
  const o = (main) => ({ size: 7.2, lh: 9.6, fill: main ? K.ink : K.en, boldFill: main ? K.ink : K.en });
  if (!cx.bi || !inline) {
    const parts = cols(cx, x, w).map((c) => ({ c, lines: layoutRich(text(c.lang), 7.2, c.w) }));
    return {
      h: Math.max(...parts.map((p) => p.lines.length)) * 9.6,
      draw: (y) => parts.map(({ c, lines }) => drawRich(lines, c.x, y, o(c.main))).join(''),
    };
  }
  const de = layoutRich(text('de'), 7.2, w);
  const en = layoutRich(text('en'), 7.2, w);
  const one = de.length === 1 && en.length === 1 && de[0].w + 3 * MM + en[0].w <= w;
  return {
    h: one ? 9.6 : (de.length + en.length) * 9.6,
    draw: (y) =>
      one
        ? drawRich(de, x, y, o(true)) + drawRich(en, x + de[0].w + 3 * MM, y, o(false))
        : drawRich(de, x, y, o(true)) + drawRich(en, x, y + de.length * 9.6, o(false)),
  };
}

/** Abbildung mit Positionen und Legende – ganze Breite, halbe Breite oder Legende daneben. */
function atomsFigure(add, b, cx, nums, marks, images) {
  const img = b.image && images[b.image];
  const num = nums.get(b.id);
  const hasMarks = (b.marks || []).length > 0;
  const numsOf = (id) => marks.get(id) || '?';
  const side = b.width === 'side';
  if (side) {
    // Abbildung links (60 mm), Legende und Text rechts
    const fw = 60 * MM;
    const margin = hasMarks ? 13 * MM : 0;
    const { w: iw, h: ih } = fitImage(img, fw - 2 * margin, 72 * MM);
    const cap = caption(b, cx, num, true, L, fw);
    const capH = 1.8 * MM + cap.h;
    const rx = L + fw + 6 * MM;
    const rw = R - rx;
    const lcols = legendCols(cx, true, rx, rw);
    const rows = (b.legend ? b.marks : []).map((m) => lcols.map((c) => ({ c, lines: layoutRich(named(cx.t(m.name, c.lang), cx.t(m.desc, c.lang)), 8.7, c.w) })));
    const rowH = rows.map((r) => 1.05 * MM + Math.max(...r.map((p) => p.lines.length)) * 12.4 + 1 * MM);
    const asideT = cols(cx, rx + NUMW, rw - NUMW, 4 * MM).map((c) => ({ c, lines: layoutRich(cx.t(b.aside && b.aside.title, c.lang), 9.4, c.w, { family: HEAD, weight: 600 }) }));
    const asideP = cols(cx, rx + NUMW, rw - NUMW, 4 * MM).map((c) => ({ c, lines: layoutRich(cx.t(b.aside && b.aside.text, c.lang), 8.7, c.w) }));
    const hasAside = asideT.some((p) => p.lines.some((l) => l.items.length)) || asideP.some((p) => p.lines.some((l) => l.items.length));
    const asideH = hasAside ? 3.4 * MM + Math.max(...asideT.map((p) => p.lines.length)) * 11 + 1.2 * MM + Math.max(...asideP.map((p) => p.lines.length)) * 12.4 : 0;
    const right = rowH.reduce((a, v) => a + v, 0) + asideH;
    const left = ih + capH;
    const h = Math.max(left, right);
    add({
      h,
      mt: 0.4 * MM,
      mb: 2.6 * MM,
      block: b.id,
      draw: (y) => {
        const ix = L + (fw - iw) / 2;
        let s = imageSvg(img, ix, y, iw, ih);
        const placed = marksLayout(b, ix, y, iw, ih, L + 2.2 * MM + 1, L + fw - 2.2 * MM - 1);
        s += marksSvg(placed, numsOf);
        s += cap.draw(y + ih + 1.8 * MM);
        let yy = y;
        rows.forEach((r, i) => {
          if (i === 0) s += hline(rx, R, yy + 0.125, K.rule, 0.25);
          s += hline(rx, R, yy + rowH[i] - 0.125, i === rows.length - 1 ? K.rule : K.hair, 0.25);
          s += numCircle(rx + 2.2 * MM, yy + 1.05 * MM + 6.2 - 0.2 * MM, numsOf(b.marks[i].id));
          for (const { c, lines } of r) s += drawRich(lines, c.x, yy + 1.05 * MM, { size: 8.7, lh: 12.4, fill: c.main ? K.ink2 : K.en, boldFill: c.main ? K.ink : K.en, refFill: c.main ? K.ink : K.en });
          yy += rowH[i];
        });
        if (hasAside) {
          yy += 3.4 * MM;
          for (const { c, lines } of asideT) s += drawRich(lines, c.x, yy, { size: 9.4, lh: 11, family: HEAD, weight: c.main ? 600 : 500, fill: c.main ? K.ink : K.en });
          yy += Math.max(...asideT.map((p) => p.lines.length)) * 11 + 1.2 * MM;
          for (const { c, lines } of asideP) s += drawRich(lines, c.x, yy, { size: 8.7, lh: 12.4, fill: c.main ? K.ink2 : K.en, boldFill: c.main ? K.ink : K.en, refFill: c.main ? K.ink : K.en });
        }
        return { svg: s, hits: figureHits(b, ix, y, iw, ih, placed) };
      },
    });
    return;
  }
  // ganze bzw. halbe Breite: Abbildung mittig, Positionen links und rechts, Legende darunter
  const margin = hasMarks ? 20 * MM : 0;
  const maxW = (b.width === 'half' ? CW / 2 : CW) - 2 * margin;
  const { w: iw, h: ih } = fitImage(img, maxW, 125 * MM);
  const cap = caption(b, cx, num, false);
  const capH = 1.8 * MM + cap.h;
  add({
    h: 2 * MM + ih + 2 * MM + capH,
    mt: 2 * MM,
    mb: 2.4 * MM,
    block: b.id,
    keepNext: hasMarks && b.legend,
    draw: (y) => {
      const fx = L + (CW - (iw + 2 * margin)) / 2;
      const ix = fx + margin;
      const iy = y + 2 * MM;
      let s = imageSvg(img, ix, iy, iw, ih);
      const placed = marksLayout(b, ix, iy, iw, ih, fx + 8 * MM, fx + iw + 2 * margin - 8 * MM);
      s += marksSvg(placed, numsOf);
      s += cap.draw(iy + ih + 2 * MM + 1.8 * MM);
      return { svg: s, hits: figureHits(b, ix, iy, iw, ih, placed) };
    },
  });
  if (hasMarks && b.legend) {
    const lcols = legendCols(cx);
    b.marks.forEach((m, i) => {
      const rows = lcols.map((c) => ({ c, lines: layoutRich(named(cx.t(m.name, c.lang), cx.t(m.desc, c.lang)), 8.7, c.w) }));
      legendRow(add, b.id, cx, rows, i, b.marks.length, (y) => numCircle(L + 2.2 * MM, y + 1.05 * MM + 6.2 - 0.2 * MM, numsOf(m.id)));
    });
  }
}

/** Anklickbare Flächen einer Abbildung: Bild (Positionen setzen), Punkte und Kreise (ziehen). */
function figureHits(b, ix, iy, iw, ih, placed) {
  const hits = [{ kind: 'figimg', id: b.id, block: b.id, rect: [ix, iy, iw, ih], img: [ix, iy, iw, ih] }];
  for (const p of placed) {
    hits.push({ kind: 'mark', id: p.m.id, block: b.id, part: 'pt', rect: [p.px - 4, p.py - 4, 8, 8], img: [ix, iy, iw, ih] });
    hits.push({ kind: 'mark', id: p.m.id, block: b.id, part: 'lbl', rect: [p.cx - 7, p.cy - 7, 14, 14], img: [ix, iy, iw, ih] });
  }
  return hits;
}

/** Abbildung mit Schritten: Bild links (78 mm, hinterlegt), Schritte rechts untereinander. */
function atomsFigsteps(add, b, cx, nums, images) {
  const img = b.image && images[b.image];
  const fw = 78 * MM;
  const { w: iw, h: ih } = fitImage(img, fw - 4 * MM, 60 * MM);
  const boxH = ih + 6 * MM;
  const cap = caption(b, cx, nums.get(b.id), true, L, fw);
  const left = boxH + 1.8 * MM + cap.h;
  const rx = L + fw + 6 * MM;
  const rw = R - rx - NUMW;
  const lists = cx.langs.map((l) => items(cx, b.text, l));
  const count = Math.max(...lists.map((l) => l.length), 0);
  const steps = Array.from({ length: count }, (_, k) => cx.langs.map((l, i) => ({ main: i === 0, lines: layoutRich(lists[i][k] || '', 8.7, rw) })));
  const stepH = steps.map((st) => 1.3 * MM + st.reduce((a, p) => a + p.lines.length * 12.4, 0) + (st.length > 1 ? 0.5 * MM : 0) + 1.2 * MM);
  const right = stepH.reduce((a, v) => a + v, 0);
  add({
    h: Math.max(left, right),
    mt: 0.6 * MM,
    mb: 2.6 * MM,
    block: b.id,
    draw: (y) => {
      let s = rect(L, y, fw, boxH, K.tint);
      s += imageSvg(img, L + (fw - iw) / 2, y + 3 * MM, iw, ih);
      s += cap.draw(y + boxH + 1.8 * MM);
      let yy = y;
      steps.forEach((st, k) => {
        if (k < steps.length - 1) s += hline(rx, R, yy + stepH[k] - 0.125, K.hair, 0.25);
        s += label(rx, base(yy + 1.3 * MM, 11, 12.4), String(k + 1), { size: 11, family: HEAD, weight: 600, fill: cx.navy });
        let ty = yy + 1.3 * MM;
        for (const p of st) {
          s += drawRich(p.lines, rx + NUMW, ty, { size: 8.7, lh: 12.4, fill: p.main ? K.ink2 : K.en, boldFill: p.main ? K.ink : K.en, refFill: p.main ? K.ink : K.en });
          ty += p.lines.length * 12.4 + 0.5 * MM;
        }
        yy += stepH[k];
      });
      return { svg: s, hits: [{ kind: 'figimg', id: b.id, block: b.id, rect: [L, y, fw, boxH], img: null }] };
    },
  });
}

/** Schritte mit Fotos: Karten in zwei Spalten (Foto 44 mm hoch, große Nummer, Titel, Text). */
function atomsCards(add, b, cx, images) {
  const cw = (CW - GAP) / 2;
  const tw = cw - NUMW;
  const list = b.items || [];
  for (let r = 0; r < list.length; r += 2) {
    const pair = list.slice(r, r + 2).map((c, k) => {
      const titles = cx.langs.map((l, i) => ({ main: i === 0, lines: layoutRich(cx.t(c.title, l), 10.4, tw, { family: HEAD, weight: i === 0 ? 600 : 500 }) }));
      const texts = cx.langs.map((l, i) => ({ main: i === 0, lines: layoutRich(cx.t(c.text, l), 8.7, tw) }));
      const headH = Math.max(22, titles.reduce((a, t) => a + t.lines.length * 12.4 + 0.8 * MM, 0));
      const bodyH = texts.reduce((a, t) => a + (t.lines.some((l) => l.items.length) ? t.lines.length * 12.4 + 1.6 * MM : 0), 0);
      return { c, k: r + k, titles, texts, headH, h: 44 * MM + 2.6 * MM + headH + 1.6 * MM + bodyH };
    });
    const h = Math.max(...pair.map((p) => p.h));
    add({
      h,
      mt: r === 0 ? 3.5 * MM : 4.5 * MM,
      mb: 0,
      block: b.id,
      draw: (y) => {
        let s = '';
        const hits = [];
        pair.forEach((p, i) => {
          const x = L + i * (cw + GAP);
          const img = p.c.image && images[p.c.image];
          s += rect(x, y, cw, 44 * MM, K.tint);
          if (img && img.data) {
            if (p.c.fill) {
              // Foto füllt die Fläche (beschnitten)
              const sc = Math.max(cw / img.w, (44 * MM) / img.h);
              s += `<svg x="${n(x)}" y="${n(y)}" width="${n(cw)}" height="${n(44 * MM)}" overflow="hidden"><image href="${esc(img.data)}" x="${n((cw - img.w * sc) / 2)}" y="${n((44 * MM - img.h * sc) / 2)}" width="${n(img.w * sc)}" height="${n(img.h * sc)}" preserveAspectRatio="none"/></svg>`;
            } else {
              const f = fitImage(img, cw - 4 * MM, 41 * MM);
              s += imageSvg(img, x + (cw - f.w) / 2, y + (44 * MM - f.h) / 2, f.w, f.h);
            }
          } else s += label(x + cw / 2, y + 22 * MM + 3, 'Foto wählen', { size: 8.5, fill: K.muted, anchor: 'middle' });
          hits.push({ kind: 'card', id: p.c.id, block: b.id, rect: [x, y, cw, p.h] });
          const by = y + 44 * MM + 2.6 * MM;
          s += label(x, base(by, 22, 22), String(p.k + 1), { size: 22, family: HEAD, weight: 600, fill: cx.navy });
          let ty = by;
          for (const t of p.titles) {
            s += drawRich(t.lines, x + NUMW, ty, { size: 10.4, lh: 12.4, family: HEAD, weight: t.main ? 600 : 500, fill: t.main ? K.ink : K.en });
            ty += t.lines.length * 12.4 + 0.8 * MM;
          }
          ty = by + p.headH + 1.6 * MM;
          for (const t of p.texts) {
            if (!t.lines.some((l) => l.items.length)) continue;
            s += drawRich(t.lines, x + NUMW, ty, { size: 8.7, lh: 12.4, fill: t.main ? K.ink2 : K.en, boldFill: t.main ? K.ink : K.en, refFill: t.main ? K.ink : K.en });
            ty += t.lines.length * 12.4 + 1.6 * MM;
          }
        });
        return { svg: s, hits };
      },
    });
  }
}

/** Tabellen: Störungen (drei Spalten), Lieferumfang und Positionsliste (Legende), allgemeine Tabelle. */
function atomsTable(add, b, cx) {
  const en = b.en || { head: [], rows: [] };
  const cell = (r, c, lang) => (lang === 'en' ? (en.rows[r] || [])[c] || '' : b.rows[r][c] || '');
  if (b.preset === 'scope' || b.preset === 'parts') {
    const lcols = legendCols(cx);
    b.rows.forEach((row, r) => {
      const rows = lcols.map((c) => ({ c, lines: layoutRich(cell(r, 1, c.lang), 8.7, c.w) }));
      legendRow(
        add,
        b.id,
        cx,
        rows,
        r,
        b.rows.length,
        (y) =>
          b.preset === 'parts' && /^\d{1,2}$/.test(row[0].trim())
            ? numCircle(L + 2.2 * MM, y + 1.05 * MM + 6.2 - 0.2 * MM, row[0].trim())
            : label(L, base(y + 1.05 * MM, 8.7, 12.4), row[0], { size: 8.7, weight: 600, fill: K.ink }),
        { ink: true },
      );
    });
    return;
  }
  // Störungstabelle und allgemeine Tabelle: Kopf in Versalien, Zellen Deutsch mit Englisch darunter
  const weights = b.preset === 'faults' ? [30, 33.3, 33.3] : b.weights;
  const total = weights.reduce((a, v) => a + v, 0);
  let x = L;
  const cs = weights.map((w) => {
    const c = { x, w: (CW * w) / total };
    x += c.w;
    return c;
  });
  const headParts = b.head.map((t, i) => {
    const main = layoutRich(t.toUpperCase(), 8, cs[i].w - 3 * MM, { family: HEAD, weight: 600, ls: 0.8 });
    const sec = cx.bi && (en.head[i] || '') ? layoutRich(en.head[i].toUpperCase(), 8, cs[i].w - 3 * MM, { family: HEAD, weight: 500, ls: 0.8 }) : [];
    return { main, sec };
  });
  const headH = 1.4 * MM + Math.max(...headParts.map((p) => (p.main.length + p.sec.length) * 9.6)) + 1.4 * MM;
  const head = {
    h: headH,
    draw: (y) => {
      let s = hline(L, R, y + 0.125, K.rule, 0.25) + hline(L, R, y + headH - 0.2, K.ink, 0.4);
      headParts.forEach((p, i) => {
        s += drawRich(p.main, cs[i].x, y + 1.4 * MM, { size: 8, lh: 9.6, family: HEAD, weight: 600, ls: 0.8, fill: K.ink });
        s += drawRich(p.sec, cs[i].x, y + 1.4 * MM + p.main.length * 9.6, { size: 8, lh: 9.6, family: HEAD, weight: 500, ls: 0.8, fill: K.en });
      });
      return s;
    },
  };
  const rows = b.rows.map((row, r) => {
    const parts = row.map((_, c) => {
      const de = layoutRich(cell(r, c, cx.lang), 8.2, cs[c].w - 3.5 * MM);
      const sec = cx.bi && cell(r, c, 'en') ? layoutRich(cell(r, c, 'en'), 8.2, cs[c].w - 3.5 * MM) : [];
      return { de, sec };
    });
    const h = 1.5 * MM + Math.max(...parts.map((p) => (p.de.length + p.sec.length) * 11)) + 1.5 * MM;
    return {
      h,
      draw: (y, last) => {
        let s = hline(L, R, y + h - 0.125, last ? K.rule : K.hair, 0.25);
        parts.forEach((p, c) => {
          s += drawRich(p.de, cs[c].x, y + 1.5 * MM, { size: 8.2, lh: 11, fill: K.ink, boldFill: K.ink });
          s += drawRich(p.sec, cs[c].x, y + 1.5 * MM + p.de.length * 11, { size: 8.2, lh: 11, fill: K.en, boldFill: K.en });
        });
        return s;
      },
    };
  });
  // Kopf und erste Zeile bleiben zusammen; jede Zeile ein Atom (Kopf wiederholt sich nicht – wie im Vorbild)
  add({ h: headH, mt: 0.6 * MM, keepNext: true, block: b.id, draw: head.draw });
  rows.forEach((row, i) => add({ h: row.h, block: b.id, draw: (y) => row.draw(y, i === rows.length - 1) }));
  add({ h: 0, mb: 2.6 * MM, block: b.id, draw: () => '' });
}

/* ---------- Seiten ---------- */

/**
 * Setzt die Kapitel-Abschnitte in Seiten: [{ svg, hits, chapter, heads }]. `state` zählt Kapitel
 * und Abbildungen über mehrere Abschnitte weiter.
 */
export function manualPages(section, project, state = { h1: 0, fig: 0 }) {
  const cx = context(project);
  const { map: nums, end } = numbers(section, state);
  Object.assign(state, end);
  const marks = markNumbers(project);
  const atoms = atomsOf(section, project, cx, nums, marks);
  const pages = [];
  let cur = null;
  let y = TOP;
  let prevMb = 0;
  let chapter = state.chapter || null;
  const open = () => {
    cur = { svg: '', hits: [], chapter, heads: [] };
    pages.push(cur);
    y = TOP;
    prevMb = 0;
  };
  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.chapter) chapter = a.chapter;
    // Kapitel beginnen auf einer neuen Seite
    if (!cur || (a.pageBreak && (cur.svg || cur.hits.length))) open();
    if (a.chapter) {
      cur.chapter = chapter;
      cur.heads.push({ title: [a.chapter.num, a.chapter.main].join('  '), level: 1 });
    }
    let gap = y === TOP ? 0 : Math.max(prevMb, a.mt);
    // „bleibt beim Nächsten“: Überschrift nicht allein am Seitenende
    let need = a.h;
    if (a.keepNext && atoms[i + 1]) need += Math.max(a.mb, atoms[i + 1].mt) + atoms[i + 1].h;
    if (y + gap + need > BOT && y > TOP) {
      open();
      gap = 0;
    }
    const top = y + gap;
    const out = a.draw(top);
    if (typeof out === 'string') cur.svg += out;
    else {
      cur.svg += out.svg;
      cur.hits.push(...(out.hits || []));
    }
    if (a.block && a.h > 0) cur.hits.unshift({ kind: 'block', id: a.block, rect: [L, top, CW, Math.max(8, a.h)] });
    y = top + a.h;
    prevMb = a.mb;
  }
  if (!pages.length) open();
  state.chapter = chapter;
  return pages;
}

/** Kopf- und Fußzeile einer Inhaltsseite (Kapitel links oben, Titel und Seitenzahl unten). */
export function manualFrame(project, chapter, num, total) {
  const cx = context(project);
  let s = '';
  const hb = 33.6;
  if (chapter) {
    const left = `${chapter.num} · ${chapter.main}`;
    s += label(L, hb, left, { size: 6.9, fill: K.ink, ls: 0.14 });
    if (cx.bi && chapter.en) s += label(L + width(left + ' ', 6.9, BODY, 400, 0.14), hb, chapter.en, { size: 6.9, fill: K.muted, ls: 0.14 });
  }
  s += hline(L, R, 14.2 * MM, K.rule, 0.25);
  const fy = PAGE.h - 9 * MM - 8 - 1.8 * MM;
  s += hline(L, R, fy, K.rule, 0.25);
  const fb = base(fy + 1.8 * MM, 6.9, 8);
  const title = String(cx.t(project.title, cx.lang) || '').replace(/\s*\n\s*/g, ' ');
  const m = project.manual || {};
  const kick = cx.langs.map((l) => cx.t(m.kicker, l));
  let x = L;
  s += label(x, fb, title, { size: 6.9, weight: 600, fill: K.ink });
  x += width(title, 6.9, BODY, 600);
  const mid = ` · ${kick[0] || ''} `;
  s += label(x, fb, mid, { size: 6.9, fill: K.muted });
  x += width(mid, 6.9);
  if (cx.bi && kick[1]) s += label(x, fb, kick[1], { size: 6.9, fill: K.muted });
  const tail = ` / ${total}`;
  const tw = width(tail, 6.9);
  s += label(R - tw, fb, tail, { size: 6.9, fill: K.muted });
  s += label(R - tw, fb, String(num), { size: 8, weight: 600, fill: K.ink, anchor: 'end' });
  return s;
}

/** Deckblatt: Logo, Sprachen, Dokumentart, Titel, Untertitel, Produktfoto, Ausführung. */
export function manualCover(project) {
  const cx = context(project);
  const m = project.manual || {};
  const images = project.images;
  let s = '';
  const hits = [];
  // Logo oben links (56 mm breit)
  const logo = project.company.logo && images[project.company.logo];
  if (logo && logo.data && logo.w) {
    const w = Math.min(56 * MM, (logo.w / logo.h) * 24 * MM);
    const h = (logo.h / logo.w) * w;
    s += `<image href="${esc(logo.data)}" x="${n(L)}" y="${n(18 * MM)}" width="${n(w)}" height="${n(h)}" preserveAspectRatio="none"/>`;
  } else if (project.company.name) s += label(L, 18 * MM + 16, project.company.name, { size: 18, family: HEAD, weight: 600, fill: K.ink });
  // Sprachen oben rechts
  const names = { de: 'Deutsch', en: 'English', fr: 'Français' };
  cx.langs.forEach((l, i) => {
    s += label(R, base(18 * MM + 1 * MM + i * 10.5, 8, 10.5), (names[l] || l).toUpperCase(), { size: 8, family: HEAD, weight: i ? 500 : 600, ls: 1.12, fill: i ? K.muted : K.ink, anchor: 'end' });
  });
  // Dokumentart mit Linie, Titel, Untertitel (ab 58 mm)
  const ty = 58 * MM;
  const kick = cx.langs.map((l) => (cx.t(m.kicker, l) || '').toUpperCase());
  const kw = width(kick[0], 8.6, HEAD, 600, 1.376);
  const kw2 = cx.bi && kick[1] ? 2 * MM + width(kick[1], 8.6, HEAD, 500, 1.376) : 0;
  s += `<line x1="${n(L)}" y1="${n(ty + 0.7)}" x2="${n(L + kw + kw2 + 2 * MM)}" y2="${n(ty + 0.7)}" stroke="${cx.accent2}" stroke-width="1.4"/>`;
  const kb = base(ty + 1.4 + 2.4 * MM, 8.6, 10.3);
  s += label(L, kb, kick[0], { size: 8.6, family: HEAD, weight: 600, ls: 1.376, fill: cx.accent2 });
  if (kw2) s += label(L + kw + 2 * MM, kb, kick[1], { size: 8.6, family: HEAD, weight: 500, ls: 1.376, fill: K.muted });
  let y = ty + 1.4 + 2.4 * MM + 10.3 + 4 * MM;
  const titleLines = layoutRich(cx.t(project.title, cx.lang), 38, CW, { family: HEAD, weight: 500 });
  s += drawRich(titleLines, L - 0.6 * MM, y, { size: 38, lh: 39, family: HEAD, weight: 500, fill: K.ink });
  y += titleLines.length * 39 + 3.5 * MM;
  const sub = cx.bi ? cx.t(project.title, 'en') : cx.t(m.subtitle, cx.lang);
  const subLines = layoutRich(String(sub || '').replace(/\s*\n\s*/g, ' '), 11.5, 120 * MM);
  s += drawRich(subLines, L, y, { size: 11.5, lh: 15, fill: cx.bi ? K.muted : K.ink });
  y += subLines.length * 15;
  hits.push({ kind: 'project', rect: [L, ty - 4, CW, y - ty + 8] });
  // Ausführung und Hinweis unten
  const metaRows = [
    [m.modelLabel, m.model],
    [{ de: 'Version', en: 'Version' }, m.version],
    [{ de: 'Stand', en: 'Date' }, m.date],
  ].filter(([, v]) => v);
  const metaH = 2.4 * MM + 9 + 12;
  const my = PAGE.h - 14 * MM - metaH;
  s += hline(L, R, my, K.rule, 0.25);
  let mx = L;
  for (const [k, v] of metaRows) {
    const kd = (cx.t(k, cx.lang) || '').toUpperCase();
    const ke = cx.bi ? (cx.t(k, 'en') || '').toUpperCase() : '';
    s += label(mx, base(my + 2.4 * MM, 6.8, 9), kd, { size: 6.8, family: HEAD, weight: 600, ls: 0.816, fill: K.ink });
    if (ke && ke !== kd) s += label(mx + width(kd, 6.8, HEAD, 600, 0.816) + 1 * MM, base(my + 2.4 * MM, 6.8, 9), ke, { size: 6.8, family: HEAD, weight: 500, ls: 0.816, fill: K.muted });
    s += label(mx, base(my + 2.4 * MM + 9, 8.8, 12), v, { size: 8.8, fill: K.ink });
    mx += Math.max(36 * MM, width(v, 8.8) + 8 * MM);
  }
  const notes = cx.langs.map((l) => cx.t(m.note, l)).filter(Boolean);
  notes.forEach((v, i) => {
    s += label(R, base(PAGE.h - 14 * MM - notes.length * 10 + i * 10, 7.2, 10), v, { size: 7.2, fill: i ? K.muted : K.ink, anchor: 'end' });
  });
  hits.push({ kind: 'project', rect: [L, my, CW, metaH] });
  // Produktfoto: rechtsbündig ab 112 mm, höchstens 116 mm breit, bis kurz vor die Angaben unten
  const cover = m.cover && images[m.cover];
  const maxH = my - 6 * MM - 112 * MM;
  if (cover && cover.data) {
    const f = fitImage(cover, 116 * MM, maxH);
    s += imageSvg(cover, R - f.w, 112 * MM, f.w, f.h);
    hits.push({ kind: 'cover', rect: [R - f.w, 112 * MM, f.w, f.h] });
  } else {
    s += `<rect x="${n(R - 116 * MM)}" y="${n(112 * MM)}" width="${n(116 * MM)}" height="${n(maxH)}" fill="${K.tint}" stroke="${K.rule}" stroke-width="0.6" stroke-dasharray="4 3"/>`;
    s += label(R - 58 * MM, 112 * MM + maxH / 2, 'Produktfoto wählen', { size: 9, fill: K.muted, anchor: 'middle' });
    hits.push({ kind: 'cover', rect: [R - 116 * MM, 112 * MM, 116 * MM, maxH] });
  }
  return { svg: s, hits };
}

/** Inhaltsverzeichnis im Stil der Anleitung: Kapitel mit Nummer und Seite. */
export function manualToc(project, entries) {
  const cx = context(project);
  let s = '';
  let y = TOP;
  s += label(L, base(y, 21, 22.5), cx.bi ? 'Inhalt' : cx.lang === 'en' ? 'Contents' : 'Inhalt', { size: 21, family: HEAD, weight: 600, fill: K.ink });
  if (cx.bi) s += label(L, base(y + 22.5, 21, 22.5), 'Contents', { size: 21, family: HEAD, weight: 400, fill: K.muted });
  y += (cx.bi ? 45 : 22.5) + 6 * MM;
  s += hline(L, R, y, K.rule, 0.25);
  for (const e of entries) {
    if (e.sub) continue;
    y += 3.2 * MM;
    const [num, ...rest] = e.title.split('  ');
    s += label(L, y + 8.4, rest.length ? num : '', { size: 8.4, family: HEAD, weight: 600, fill: cx.navy });
    s += label(L + 9 * MM, y + 8.4, rest.length ? rest.join(' ') : e.title, { size: 8.4, fill: K.ink });
    s += label(R, y + 8.4, String(e.page), { size: 8.4, weight: 600, fill: K.ink, anchor: 'end' });
    y += 11;
  }
  return { svg: s, hits: [] };
}

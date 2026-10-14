/**
 * Bausteine für den Seitensatz: Seitenmaße, Farben des Vorbilds und kleine SVG-Helfer.
 *
 * Alle Maße in pt, Ursprung oben links (y nach unten) – eine A4-Seite ist 595.276 × 841.89 pt.
 */
import { textWidth, wrap } from './measure.js';
import { FONTS, langsOf, str, tx } from './model.js';

export const PAGE = { w: 595.276, h: 841.89, left: 42, right: 553.276 };

/** Farben des Anschlussplan-Vorbilds (exakt übernommen). */
export const C = {
  navy: '#1f3b4d',
  body: '#4a5568',
  muted: '#6b7280',
  rule: '#d5dde3',
  hub: '#f4f7f9',
  card: '#eef2f5',
  alt: '#f5f8f9',
  dot: '#2e6e8e',
};

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ESC[c]);

/** Zahl für SVG-Attribute (höchstens zwei Nachkommastellen). */
export const n = (v) => Math.round(v * 100) / 100;

/** Nur Farben der Form #rgb/#rrggbb gelangen in die Seite. */
export const color = (v, fallback = C.navy) => (/^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v || '') ? v : fallback);

/**
 * Satz-Kontext eines Projekts: Schrift, Sprachen, Messen und Umbrechen, zweisprachige Texte.
 * `runs(value)` liefert die Textfassungen in Darstellungsreihenfolge – bei „Deutsch und Englisch“
 * folgt die englische Fassung als zweite (`sec`), wenn sie vorhanden ist und abweicht.
 */
export function typesetter(project) {
  const font = FONTS.find((f) => f.id === project.font) || FONTS[0];
  const langs = langsOf(project);
  const lang = langs[0];
  const bi = langs.length > 1;
  const style = (weight = 400, italic = false) => ({ family: font.css, weight, italic });
  return {
    font,
    langs,
    lang,
    bi,
    width: (text, size, weight, italic) => textWidth(text, size, style(weight, italic)),
    wrap: (text, size, maxWidth, weight, italic) => wrap(text, size, style(weight, italic), maxWidth),
    /** Fassungen eines Texts: [{ text, sec }]. */
    runs(value) {
      const first = tx(value, lang);
      if (!bi) return first ? [{ text: first, sec: false }] : [];
      const de = tx(value, 'de');
      const en = typeof value === 'string' ? '' : (value && value.en) || '';
      const out = de ? [{ text: de, sec: false }] : [];
      if (en && en !== de) out.push({ text: en, sec: true });
      return out;
    },
    /** Einzeilig: „Deutsch / English“ bzw. nur die eine Sprache. */
    inline(value) {
      return this.runs(value)
        .map((r) => r.text)
        .join(' / ');
    },
    /** Feste Beschriftung (STRINGS) – zweisprachig mit „ / “. */
    label(key, vars) {
      const de = str(key, lang, vars);
      if (!bi) return de;
      const en = str(key, 'en', vars);
      return en && en !== de ? `${de} / ${en}` : de;
    },
    tx: (value) => tx(value, lang),
  };
}

/** Festbreitenschrift für IP-Adressen, MAC-Adressen und Passwörter (l/1, O/0 gut unterscheidbar). */
export const MONO = 'Consolas, "Liberation Mono", "Courier New", monospace';

/** SVG-Text. `o`: size, weight, italic, fill, anchor ('start' | 'middle' | 'end'), family. */
export function text(x, y, value, o = {}) {
  if (value == null || value === '') return '';
  const attrs = [
    `x="${n(x)}"`,
    `y="${n(y)}"`,
    `font-size="${o.size || 10}"`,
    o.weight && o.weight !== 400 ? `font-weight="${o.weight}"` : '',
    o.italic ? 'font-style="italic"' : '',
    `fill="${o.fill || C.navy}"`,
    o.anchor && o.anchor !== 'start' ? `text-anchor="${o.anchor}"` : '',
    o.family ? `font-family="${esc(o.family)}"` : '',
  ];
  // mehrere Leerzeichen bleiben stehen (SVG fasst sie sonst zusammen): ab dem zweiten geschützt
  const spaced = String(value).replace(/ {2,}/g, (m) => ' ' + '\u00a0'.repeat(m.length - 1));
  return `<text ${attrs.filter(Boolean).join(' ')}>${esc(spaced)}</text>`;
}

export const line = (x1, y1, x2, y2, stroke, width) =>
  `<line x1="${n(x1)}" y1="${n(y1)}" x2="${n(x2)}" y2="${n(y2)}" stroke="${stroke}" stroke-width="${width}"/>`;

export const rect = (x, y, w, h, o = {}) =>
  `<rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"${o.rx ? ` rx="${o.rx}"` : ''} fill="${o.fill || 'none'}"${o.stroke ? ` stroke="${o.stroke}" stroke-width="${o.width || 1}"` : ''}/>`;

/** Pille mit Text (z. B. „12 V“) – Maße wie im Vorbild. Rückgabe: { svg, w }. */
export function pill(ts, x, y, label, fill) {
  const w = ts.width(label, 7.2, 700) + 10;
  return {
    w,
    svg: rect(x, y, w, 12, { rx: 3, fill }) + text(x + 5, y + 8.6, label, { size: 7.2, weight: 700, fill: '#fff' }),
  };
}

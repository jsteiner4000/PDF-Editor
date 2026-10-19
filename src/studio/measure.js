/**
 * Textmaße für den Seitensatz der Dokumente.
 *
 * Gemessen wird mit einem Canvas in derselben Schrift, in der die Seite später erscheint
 * (Vorschau und PDF nutzen dieselbe Chromium-Schriftdarstellung). Ohne Unterschneidung
 * (Kerning) – wie der Satz des Vorbilds –, bei 100 px gemessen und linear skaliert, damit kleine
 * Schriftgrade nicht durch Hinting verfälscht werden.
 */

const REF = 100;
const ctxs = {};
const cache = new Map();

/** Messkontext ohne bzw. mit Unterschneidung (Bedienungsanleitung: wie das Vorbild mit). */
function context(kern = false) {
  const k = kern ? 'normal' : 'none';
  if (!ctxs[k]) {
    ctxs[k] = document.createElement('canvas').getContext('2d');
    if ('fontKerning' in ctxs[k]) ctxs[k].fontKerning = k;
  }
  return ctxs[k];
}

/**
 * Breite von `text` in pt bei Schriftgrad `size` (pt); `style` = { family, weight, italic, kern }.
 */
export function textWidth(text, size, style) {
  if (!text) return 0;
  const font = `${style.italic ? 'italic ' : ''}${style.weight || 400} ${REF}px ${style.family}`;
  const key = (style.kern ? 'k' : '') + font + '\u0000' + text;
  let w = cache.get(key);
  if (w === undefined) {
    const c = context(style.kern);
    if (c.font !== font) c.font = font;
    w = c.measureText(text).width;
    if (cache.size > 20000) cache.clear();
    cache.set(key, w);
  }
  return (w * size) / REF;
}

/** Nach dem Laden einer Schrift: gemessene Breiten verwerfen (sie galten der Ersatzschrift). */
export function resetMeasure() {
  cache.clear();
}

/**
 * Bricht `text` in Zeilen von höchstens `maxWidth` pt um. Zeilenumbrüche im Text bleiben erhalten;
 * ein Wort, das allein zu breit ist, wird zeichenweise getrennt.
 */
export function wrap(text, size, style, maxWidth) {
  const fits = (s) => textWidth(s, size, style) <= maxWidth;
  const out = [];
  for (const para of String(text ?? '').split('\n')) {
    let line = '';
    for (const word of para.split(/ +/)) {
      const next = line ? line + ' ' + word : word;
      if (line && !fits(next)) {
        out.push(line);
        line = word;
      } else line = next;
      if (!fits(line)) {
        let part = '';
        for (const ch of line) {
          if (part && !fits(part + ch)) {
            out.push(part);
            part = ch;
          } else part += ch;
        }
        line = part;
      }
    }
    out.push(line);
  }
  return out;
}

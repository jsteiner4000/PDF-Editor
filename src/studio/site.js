/**
 * Lageplan: Planfläche mit Hintergrundbild (Foto, Karte, Grundriss), darauf Symbole mit
 * Nummerierung und – bei Kameras und Meldern – dem Erfassungsbereich als Sektor. Darunter die
 * Legende der verwendeten Symbole; auf Folgeseiten die Geräteliste.
 *
 * Positionen der Symbole sind Anteile der Planfläche (0–1) – sie bleiben an ihrer Stelle, wenn das
 * Hintergrundbild getauscht wird.
 */
import { C, PAGE, color, esc, line, n, rect, text } from './svg.js';
import { STRINGS, symbolInfo, symbolLabels, tx } from './model.js';
import { wrap } from './measure.js';

export const SITE_TOP = 116;
const BOTTOM = 770;
const LEGEND_ROW = 16;
/** Feste Legendenhöhe (4 Zeilen): die Planfläche bleibt immer gleich groß, Symbole behalten ihre Stelle. */
const LEGEND_ROWS = 4;
const LEGEND_H = 24 + LEGEND_ROWS * LEGEND_ROW;

/** Bildzeichen (24 × 24, weiße Linien auf der Farbfläche). */
const GLYPHS = {
  camera: '<rect x="4" y="8" width="11" height="8" rx="1.5"/><path d="M15 11.2l5-2.7v7l-5-2.7"/>',
  motion: '<path d="M5 14.5a10 10 0 0 1 14 0M8 17.2a6 6 0 0 1 8 0"/><circle cx="12" cy="20" r=".9" fill="#fff"/>',
  smoke: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="3"/>',
  contact: '<rect x="3.5" y="9" width="7.5" height="6" rx="1"/><rect x="13" y="9" width="7.5" height="6" rx="1"/>',
  glass: '<path d="M12 4l-2 6.5 4 1.5-3 8"/><path d="M5 7h4M15 17.5h4"/>',
  barrier: '<path d="M5 5v14M19 5v14M8.5 12h2M12.5 12h2M16 12h.5"/>',
  siren: '<path d="M5 14V10l5.5-2.8v9.6z"/><path d="M14 9.2a4 4 0 0 1 0 5.6M16.8 6.8a7.5 7.5 0 0 1 0 10.4"/>',
  keypad:
    '<circle cx="8.5" cy="8" r="1.1" fill="#fff"/><circle cx="12" cy="8" r="1.1" fill="#fff"/><circle cx="15.5" cy="8" r="1.1" fill="#fff"/><circle cx="8.5" cy="12" r="1.1" fill="#fff"/><circle cx="12" cy="12" r="1.1" fill="#fff"/><circle cx="15.5" cy="12" r="1.1" fill="#fff"/><circle cx="12" cy="16" r="1.1" fill="#fff"/>',
  panel: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M8.5 10h7M8.5 14h4"/>',
  keyswitch: '<circle cx="8" cy="15" r="3.2"/><path d="M10.5 12.7 18 5.5M15.5 8l2.2 2.2M13.4 10.1l1.6 1.6"/>',
  access: '<path d="M7 6.5a7.5 7.5 0 0 1 10 0M9.2 9.2a4 4 0 0 1 5.6 0"/><rect x="8" y="12.5" width="8" height="7" rx="1.5"/>',
  opener: '<path d="M7 4.5h8v15H7z"/><path d="M15 12h3.5M12.5 12h.1"/>',
  intercom: '<circle cx="12" cy="9" r="3.2"/><path d="M6 19.5a6 6 0 0 1 12 0z"/>',
  router: '<rect x="4" y="13.5" width="16" height="5.5" rx="1.5"/><path d="M8 16.2h.1M11.5 16.2h.1M7 10.5a7 7 0 0 1 10 0M9.5 8a3.5 3.5 0 0 1 5 0"/>',
  recorder: '<rect x="4" y="7" width="16" height="10" rx="1.5"/><circle cx="15.5" cy="12" r="2"/><path d="M7 12h4"/>',
};

/** Symbol (Kreis mit Bildzeichen bzw. eigenes Bild) mit Mittelpunkt (x, y) und Radius r. */
export function symbolSvg(info, x, y, r, images) {
  if (info.image) {
    const img = images[info.image];
    if (!img || !img.data) return '';
    const s = Math.min((2 * r) / img.w, (2 * r) / img.h);
    const w = img.w * s;
    const h = img.h * s;
    return `<image href="${esc(img.data)}" x="${n(x - w / 2)}" y="${n(y - h / 2)}" width="${n(w)}" height="${n(h)}"/>`;
  }
  const c = color(info.color);
  const k = (2 * r * 0.7) / 24;
  return (
    `<circle cx="${n(x)}" cy="${n(y)}" r="${n(r)}" fill="${c}" stroke="#fff" stroke-width="1.2"/>` +
    `<g transform="translate(${n(x - 12 * k)} ${n(y - 12 * k)}) scale(${k.toFixed(4)})" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[info.glyph] || ''}</g>`
  );
}

/** Kleines Symbol als SVG-Text (für Auswahlfelder der Oberfläche). */
export function symbolIconSvg(info, images, size = 26) {
  return `<svg viewBox="0 0 20 20" width="${size}" height="${size}" aria-hidden="true">${symbolSvg(info, 10, 10, 9, images)}</svg>`;
}

/** Erfassungsbereich als Sektor; `dir` = Blickrichtung in Grad (0 = nach oben, im Uhrzeigersinn). */
function fovSvg(c, x, y, dir, angle, range) {
  const col = color(c);
  const style = `fill="${col}" fill-opacity="0.16" stroke="${col}" stroke-opacity="0.75" stroke-width="0.8"`;
  if (angle >= 359.5) return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(range)}" ${style}/>`;
  const rad = (a) => (a * Math.PI) / 180;
  const p = (a) => [x + range * Math.sin(rad(a)), y - range * Math.cos(rad(a))];
  const [x0, y0] = p(dir - angle / 2);
  const [x1, y1] = p(dir + angle / 2);
  return `<path d="M${n(x)} ${n(y)}L${n(x0)} ${n(y0)}A${n(range)} ${n(range)} 0 ${angle > 180 ? 1 : 0} 1 ${n(x1)} ${n(y1)}Z" ${style} stroke-linejoin="round"/>`;
}

/** Symbole mit weißem Rand um die Schrift (bleibt auf Karten und Fotos lesbar). */
function label(x, y, value, anchor) {
  const common = `x="${n(x)}" y="${n(y)}" font-size="7.5" font-weight="700"${anchor === 'end' ? ' text-anchor="end"' : ''}`;
  return `<text ${common} fill="#fff" stroke="#fff" stroke-width="2.8" stroke-linejoin="round">${esc(value)}</text><text ${common} fill="${C.navy}">${esc(value)}</text>`;
}

/** Hintergrundbild eingepasst (drehbar, einpassen oder füllen), auf die Fläche beschnitten. */
function backgroundSvg(bg, images, area) {
  const img = bg.image && images[bg.image];
  if (!img || !img.data) return '';
  const turned = bg.rotate === 90 || bg.rotate === 270;
  const w = turned ? img.h : img.w;
  const h = turned ? img.w : img.h;
  const s = (bg.fit === 'cover' ? Math.max : Math.min)(area.w / w, area.h / h);
  const cx = area.w / 2;
  const cy = area.h / 2;
  const fade = bg.fade > 0 ? `<rect width="${n(area.w)}" height="${n(area.h)}" fill="#fff" fill-opacity="${bg.fade}"/>` : '';
  return (
    `<svg x="${n(area.x)}" y="${n(area.y)}" width="${n(area.w)}" height="${n(area.h)}" viewBox="0 0 ${n(area.w)} ${n(area.h)}" overflow="hidden">` +
    `<image href="${esc(img.data)}" width="${img.w}" height="${img.h}" transform="translate(${n(cx)} ${n(cy)}) rotate(${bg.rotate}) scale(${s.toFixed(5)}) translate(${n(-img.w / 2)} ${n(-img.h / 2)})"/>` +
    fade +
    `</svg>`
  );
}

/** Text auf `room` pt kürzen („…“). */
function ellipsize(ts, value, size, room, weight = 400) {
  if (ts.width(value, size, weight) <= room) return value;
  let v = value;
  while (v.length > 1 && ts.width(v + '…', size, weight) > room) v = v.slice(0, -1);
  return v.trimEnd() + '…';
}

/** Verwendete Symbolarten für die Legende: [{ info, count }] in Reihenfolge des ersten Auftretens. */
function usedKinds(site) {
  const map = new Map();
  for (const sym of site.symbols) {
    const info = symbolInfo(site, sym.kind);
    if (!info) continue;
    const entry = map.get(sym.kind) || { info, count: 0 };
    entry.count++;
    map.set(sym.kind, entry);
  }
  return [...map.values()];
}

/**
 * Seiten des Lageplans: [{ kind: 'plan' | 'list', svg, hits, site? }]. `site` (nur Plan) liefert dem
 * Editor Planfläche und Lage der Symbole in Seitenkoordinaten.
 */
export function sitePages(section, ts, images) {
  const kinds = usedKinds(section);
  const area = { x: PAGE.left, y: SITE_TOP, w: PAGE.right - PAGE.left, h: BOTTOM - SITE_TOP - LEGEND_H - 8 };
  const labels = symbolLabels(section);

  let svg = rect(area.x, area.y, area.w, area.h, { fill: '#fff' }) + backgroundSvg(section.bg, images, area);
  svg += rect(area.x, area.y, area.w, area.h, { stroke: C.rule, width: 0.7 });
  const hits = [{ kind: 'plan', rect: [area.x, area.y, area.w, area.h] }];
  const marks = [];
  let cones = '';
  let dots = '';
  let names = '';
  for (const sym of section.symbols) {
    const info = symbolInfo(section, sym.kind);
    if (!info) continue;
    const r = 8 * sym.scale;
    const x = area.x + sym.x * area.w;
    const y = area.y + sym.y * area.h;
    let tip = null;
    if (info.fov && sym.fov) {
      cones += fovSvg(info.color, x, y, sym.dir, sym.angle, sym.range);
      const rad = (sym.dir * Math.PI) / 180;
      tip = [x + sym.range * Math.sin(rad), y - sym.range * Math.cos(rad)];
    }
    dots += symbolSvg(info, x, y, r, images);
    if (section.showNumbers) {
      const text_ = labels.get(sym.id);
      const w = ts.width(text_, 7.5, 700);
      const left = x + r + 2 + w > area.x + area.w;
      names += label(left ? x - r - 2 : x + r + 2, y + 2.6, text_, left ? 'end' : 'start');
    }
    hits.push({ kind: 'sym', id: sym.id, rect: [x - r - 2, y - r - 2, 2 * r + 4, 2 * r + 4] });
    marks.push({ id: sym.id, x, y, r, tip, fov: !!tip });
  }
  // Erfassungsbereiche enden am Planrand
  if (cones)
    svg += `<svg x="${n(area.x)}" y="${n(area.y)}" width="${n(area.w)}" height="${n(area.h)}" viewBox="${n(area.x)} ${n(area.y)} ${n(area.w)} ${n(area.h)}" overflow="hidden">${cones}</svg>`;
  svg += dots + names;

  // Legende der verwendeten Symbole
  if (kinds.length) {
    const cols = Math.min(6, Math.max(3, Math.ceil(kinds.length / LEGEND_ROWS)));
    const colW = (area.w + 10) / cols;
    const shown = kinds.slice(0, cols * LEGEND_ROWS);
    const top = area.y + area.h + 8 + 12;
    svg += text(PAGE.left, top, ts.label('legend'), { size: 9.5, weight: 700 });
    shown.forEach(({ info, count }, i) => {
      const x = PAGE.left + (i % cols) * colW;
      const y = top + 16 + Math.floor(i / cols) * LEGEND_ROW;
      const tail = `  (${count})`;
      const head = ellipsize(ts, `${info.code}  ${ts.inline(info.name)}`, 8.5, colW - 17 - 8 - ts.width(tail, 8.5, 400));
      svg += symbolSvg(info, x + 6, y - 3, 6, images);
      svg += text(x + 17, y, head + tail, { size: 8.5, fill: C.body });
    });
    if (shown.length < kinds.length)
      svg += text(PAGE.right, top, `+ ${kinds.length - shown.length}`, { size: 8.5, fill: C.muted, anchor: 'end' });
  }
  const pages = [{ kind: 'plan', svg, hits, site: { area, symbols: marks } }];

  // Geräteliste
  if (section.showList && section.symbols.length) pages.push(...listPages(section, ts, labels));
  return pages;
}

const COLS = [
  { x: 48, w: 44, key: 'nr', label: 'nr', bold: true },
  { x: 92, w: 120, key: 'type', label: 'type' },
  { x: 212, w: 150, key: 'name', label: 'name' },
  { x: 362, w: 191, key: 'note', label: 'remark' },
];

function listPages(section, ts, labels) {
  const pages = [];
  let svg = '';
  let hits = [];
  let y = 132;
  const bi = ts.bi;
  const head = () => {
    const h = bi ? 28 : 20;
    svg += rect(PAGE.left, y, 511.276, h, { fill: C.navy });
    for (const c of COLS) {
      const l = STRINGS[c.label];
      svg += text(c.x, y + 13, tx(l, ts.lang), { size: 9, weight: 700, fill: '#fff' });
      if (bi && l.en !== l.de) svg += text(c.x, y + 23, l.en, { size: 7.5, italic: true, fill: '#c8d3db' });
    }
    y += h;
  };
  const flush = () => {
    pages.push({ kind: 'list', svg, hits });
    svg = '';
    hits = [];
    y = 132;
  };
  svg += text(PAGE.left, y, ts.label('deviceList'), { size: 12, weight: 700 });
  y += 22;
  head();
  section.symbols.forEach((sym, i) => {
    const info = symbolInfo(section, sym.kind);
    if (!info) return;
    const cell = (value, w, weight = 400) =>
      ts.runs(value).flatMap((r) => wrap(r.text, 8.8, { family: ts.font.css, weight: r.sec ? 400 : weight, italic: r.sec }, w - 8).map((t) => ({ text: t, sec: r.sec })));
    const cells = {
      nr: [{ text: labels.get(sym.id), sec: false }],
      type: cell(info.name, COLS[1].w),
      name: cell(sym.name, COLS[2].w, 700),
      note: cell(sym.note, COLS[3].w),
    };
    const h = 16 + 10.56 * (Math.max(1, ...Object.values(cells).map((l) => l.length)) - 1);
    if (y + h > BOTTOM) {
      flush();
      head();
    }
    if (i % 2 === 0) svg += rect(PAGE.left, y, 511.276, h, { fill: C.alt });
    for (const c of COLS)
      cells[c.key].forEach((l, k) => {
        svg += text(c.x, y + 11 + 10.56 * k, l.text, {
          size: 8.8,
          weight: c.bold && !l.sec ? 700 : 400,
          italic: l.sec,
          fill: l.sec ? C.muted : c.bold ? C.navy : C.body,
        });
      });
    svg += line(PAGE.left, y + h, PAGE.right, y + h, C.rule, 0.5);
    hits.push({ kind: 'sym', id: sym.id, rect: [PAGE.left, y, 511.276, h] });
    y += h;
  });
  pages.push({ kind: 'list', svg, hits });
  return pages;
}


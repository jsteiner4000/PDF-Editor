/**
 * Lageplan: Planfläche mit Hintergrundbild (Foto, Karte, Grundriss), darauf Zeichnungen (Linien,
 * Zäune, Zonen), Richtfunkstrecken und Symbole mit Nummerierung und – bei Kameras und Meldern – dem
 * Erfassungsbereich als Sektor. Mit Maßstab stehen Längen und Flächen in Metern im Plan. Darunter
 * die Legende; auf Folgeseiten die Geräteliste.
 *
 * Positionen der Symbole sind Anteile der Planfläche (0–1) – sie bleiben an ihrer Stelle, wenn das
 * Hintergrundbild getauscht wird.
 */
import { C, PAGE, color, esc, line, n, rect, text } from './svg.js';
import { STRINGS, deviceOf, isBusKind, isHeightKind, projectSymbols, str, symbolInfo, symbolLabels, symbolsInOrder, tx } from './model.js';
import { wrap } from './measure.js';
import {
  LEGEND_ROW,
  LEGEND_ROWS,
  siteArea,
  centroid,
  formatArea,
  formatLength,
  metersPerPt,
  midpoint,
  pathLength,
  polygonArea,
  ratio,
  scaleBar,
  toPt,
} from './geo.js';

/** Bildzeichen (24 × 24, weiße Linien auf der Farbfläche). */
const GLYPHS = {
  camera: '<rect x="4" y="8" width="11" height="8" rx="1.5"/><path d="M15 11.2l5-2.7v7l-5-2.7"/>',
  photo: '<rect x="4" y="8.5" width="16" height="10" rx="2"/><circle cx="12" cy="13.5" r="2.8"/><path d="M9 8.5l1.3-2h3.4l1.3 2"/>',
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
  // Meldegruppenmodul: Modul mit Klemmen
  mgm: '<rect x="5" y="6" width="14" height="12" rx="1.5"/><path d="M8 18v2.5M12 18v2.5M16 18v2.5M8.5 10.5h7M8.5 13.5h4"/>',
  mast: '<path d="M12 3.5V20.5M8 20.5h8M12 7l-4 3M12 7l4 3"/><circle cx="12" cy="5" r="1.4" fill="#fff"/>',
  cabinet: '<rect x="6" y="4" width="12" height="16" rx="1.5"/><path d="M12.8 7.5 10.2 12.2h3.6l-2.6 4.6"/>',
  junction: '<rect x="6.5" y="6.5" width="11" height="11" rx="2"/><path d="M3.5 12h3M17.5 12h3M12 3.5v3M12 17.5v3"/>',
  rack: '<rect x="6" y="3.5" width="12" height="17" rx="1.5"/><path d="M8.5 8h7M8.5 12h7M8.5 16h7"/>',
  radio: '<path d="M6.5 6.5a8 8 0 0 0 11 11z"/><path d="M12 12l4.5-4.5"/><path d="M15.5 4.5a4 4 0 0 1 4 4"/><path d="M9 20h6"/>',
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
function fovSvg(c, x, y, dir, angle, range, outline = false) {
  const col = color(c);
  const style = outline
    ? `fill="none" stroke="${col}" stroke-opacity="0.8" stroke-width="0.9" stroke-dasharray="3 2"`
    : `fill="${col}" fill-opacity="0.16" stroke="${col}" stroke-opacity="0.75" stroke-width="0.8"`;
  if (angle >= 359.5) return `<circle cx="${n(x)}" cy="${n(y)}" r="${n(range)}" ${style}/>`;
  const rad = (a) => (a * Math.PI) / 180;
  const p = (a) => [x + range * Math.sin(rad(a)), y - range * Math.cos(rad(a))];
  const [x0, y0] = p(dir - angle / 2);
  const [x1, y1] = p(dir + angle / 2);
  return `<path d="M${n(x)} ${n(y)}L${n(x0)} ${n(y0)}A${n(range)} ${n(range)} 0 ${angle > 180 ? 1 : 0} 1 ${n(x1)} ${n(y1)}Z" ${style} stroke-linejoin="round"/>`;
}

/** Beschriftung mit weißem Rand um die Schrift (bleibt auf Karten und Fotos lesbar). */
function label(x, y, value, anchor, { weight = 700, fill = C.navy } = {}) {
  const common = `x="${n(x)}" y="${n(y)}" font-size="7.5" font-weight="${weight}"${anchor && anchor !== 'start' ? ` text-anchor="${anchor}"` : ''}`;
  return `<text ${common} fill="#fff" stroke="#fff" stroke-width="2.8" stroke-linejoin="round">${esc(value)}</text><text ${common} fill="${fill}">${esc(value)}</text>`;
}

const RADIO = '#0891b2';
/** Beschriftung der Funkstrecke: dunkler als die Linie (5,3 : 1 auf Weiß, 7,5 pt). */
const RADIO_TEXT = '#0e7490';

/** Kontrast einer Farbe auf Weiß (WCAG). */
function contrastOnWhite(hex) {
  const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 1.05 / (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2] + 0.05);
}

/** Schriftfarbe für einen Namen in Zeichnungsfarbe: zu helle Farben werden dunkel geschrieben. */
const nameColor = (c) => (/^#[0-9a-f]{6}$/i.test(c) && contrastOnWhite(c) >= 4.5 ? c : C.navy);
const polyPts = (pts) => pts.map(([x, y]) => `${n(x)},${n(y)}`).join(' ');

/** Zaunpfosten entlang eines Linienzugs (alle ~12 pt). */
function posts(pts, closed, col) {
  const ring = closed ? [...pts, pts[0]] : pts;
  const len = pathLength(ring);
  const count = Math.max(2, Math.round(len / 12));
  let out = '';
  for (let k = 0; k <= count; k++) {
    if (closed && k === count) break;
    let want = (len * k) / count;
    for (let i = 1; i < ring.length; i++) {
      const [x0, y0] = ring[i - 1];
      const [x1, y1] = ring[i];
      const d = Math.hypot(x1 - x0, y1 - y0);
      if (want <= d || i === ring.length - 1) {
        const t = d ? Math.min(1, want / d) : 0;
        out += `<circle cx="${n(x0 + (x1 - x0) * t)}" cy="${n(y0 + (y1 - y0) * t)}" r="1.7"/>`;
        break;
      }
      want -= d;
    }
  }
  return `<g fill="#fff" stroke="${col}" stroke-width="1">${out}</g>`;
}

/** Maßlinie: Strecke mit Pfeilen und Begrenzungsstrichen, Länge (mit Maßstab) darüber. */
function dimSvg(z, [a, b], mpp, ts) {
  const col = color(z.color, C.navy);
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
  const ux = (b[0] - a[0]) / len;
  const uy = (b[1] - a[1]) / len;
  const [nx, ny] = [-uy, ux];
  const tick = (p) => `<line x1="${n(p[0] + nx * 5)}" y1="${n(p[1] + ny * 5)}" x2="${n(p[0] - nx * 5)}" y2="${n(p[1] - ny * 5)}"/>`;
  const head = (p, d) =>
    `<path d="M${n(p[0])} ${n(p[1])}L${n(p[0] + d * ux * 6 + nx * 2.2)} ${n(p[1] + d * uy * 6 + ny * 2.2)}L${n(p[0] + d * ux * 6 - nx * 2.2)} ${n(p[1] + d * uy * 6 - ny * 2.2)}Z" fill="${col}" stroke="none"/>`;
  let out = `<g stroke="${col}" stroke-width="1" stroke-linecap="round"><line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}"/>${tick(a)}${tick(b)}</g>${head(a, 1)}${head(b, -1)}`;
  const lang = ts.lang === 'en' ? 'en' : 'de';
  const value = [ts.inline(z.name), mpp ? formatLength(len * mpp, lang) : ''].filter(Boolean).join(' · ');
  if (value) {
    // Text liegt parallel zur Linie und steht nie auf dem Kopf
    let ang = (Math.atan2(uy, ux) * 180) / Math.PI;
    if (ang > 90) ang -= 180;
    if (ang < -90) ang += 180;
    const mx = (a[0] + b[0]) / 2;
    const my = (a[1] + b[1]) / 2;
    out += `<g transform="translate(${n(mx)} ${n(my)}) rotate(${n(ang)})">${label(0, -3.5, value, 'middle', { fill: nameColor(col) })}</g>`;
  }
  return out;
}

/** Zeichnung (Linie, Freihand, Zaun, Zone, Maßlinie) als SVG; `fills` = nur die Fläche einer Zone. */
function shapeSvg(z, pts, fills, mpp, ts) {
  const col = color(z.color);
  if (z.type === 'dim') return fills ? '' : dimSvg(z, pts, mpp, ts);
  if (fills) return z.closed ? `<polygon points="${polyPts(pts)}" fill="${col}" fill-opacity="0.1"/>` : '';
  const tag = z.closed ? 'polygon' : 'polyline';
  const width = z.type === 'fence' ? 1.5 : 1.6;
  let out = `<${tag} points="${polyPts(pts)}" fill="none" stroke="${col}" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;
  if (z.type === 'fence') out += posts(pts, z.closed, col);
  return out;
}

/** Beschriftungen einer Zeichnung: Name, Länge bzw. Fläche (mit Maßstab). */
function shapeLabel(z, pts, mpp, ts) {
  if (z.type === 'dim') return '';
  const lang = ts.lang === 'en' ? 'en' : 'de';
  const name = ts.inline(z.name);
  if (z.closed) {
    const [cx, cy] = centroid(pts);
    const size = mpp && z.showLen ? formatArea(polygonArea(pts) * mpp * mpp, lang) : '';
    if (!name && !size) return '';
    return (name ? label(cx, cy + (size ? -1.5 : 2.6), name, 'middle', { fill: nameColor(color(z.color)) }) : '') + (size ? label(cx, cy + (name ? 8 : 2.6), size, 'middle', { weight: 400 }) : '');
  }
  const len = mpp && z.showLen ? formatLength(pathLength(pts) * mpp, lang) : '';
  const value = [name, len].filter(Boolean).join(' · ');
  if (!value) return '';
  const m = midpoint(pts);
  return label(m.x, m.y - 4, value, 'middle');
}

/** Maßstabsleiste unten links in der Planfläche. */
function scaleBarSvg(area, mpp, ts) {
  const lang = ts.lang === 'en' ? 'en' : 'de';
  const bar = scaleBar(mpp);
  const x = area.x + 8;
  const y = area.y + area.h - 10;
  const half = bar.pt / 2;
  const caption = `1 : ${ratio(mpp).toLocaleString(lang === 'en' ? 'en-GB' : 'de-DE')}`;
  return (
    `<rect x="${n(x - 5)}" y="${n(y - 15)}" width="${n(bar.pt + 10 + 6 + ts.width(caption, 7, 400) + 8)}" height="22" rx="3" fill="#fff" fill-opacity="0.88"/>` +
    `<rect x="${n(x)}" y="${n(y)}" width="${n(half)}" height="3" fill="${C.navy}"/>` +
    `<rect x="${n(x + half)}" y="${n(y)}" width="${n(half)}" height="3" fill="#fff" stroke="${C.navy}" stroke-width="0.6"/>` +
    text(x, y - 3.5, '0', { size: 7, fill: C.body }) +
    text(x + bar.pt, y - 3.5, formatLength(bar.m, lang), { size: 7, fill: C.body, anchor: 'middle' }) +
    text(x + bar.pt + 10, y + 3, caption, { size: 7, fill: C.muted })
  );
}

/** Funkstrecke (gestrichelt) zwischen zwei Stationen mit Band und Länge. */
function linkSvg(a, b, l, mpp, ts) {
  const lang = ts.lang === 'en' ? 'en' : 'de';
  let out = `<line x1="${n(a[0])}" y1="${n(a[1])}" x2="${n(b[0])}" y2="${n(b[1])}" stroke="${RADIO}" stroke-width="1.5" stroke-dasharray="5 3" stroke-linecap="round"/>`;
  const value = [l.band, mpp ? formatLength(Math.hypot(b[0] - a[0], b[1] - a[1]) * mpp, lang) : ''].filter(Boolean).join(' · ');
  if (value) out += label((a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 4, value, 'middle', { fill: RADIO_TEXT });
  return out;
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
 * Zeichenreihenfolge des Lageplans (unten → oben): [{ kind: 'shape' | 'link' | 'sym', obj }].
 * Ohne eigene Ebene: Zonen, dann Linien und Zäune, dann Richtfunk, dann Symbole – je in der
 * Reihenfolge der Liste. `layer` (gesetzt über „Nach vorne/hinten“) bestimmt die Lage.
 */
export function siteOrder(section) {
  const items = [];
  section.shapes.forEach((z, i) => items.push({ kind: 'shape', obj: z, key: (z.closed ? -30000 : -20000) + i }));
  section.links.forEach((l, i) => items.push({ kind: 'link', obj: l, key: -10000 + i }));
  section.symbols.forEach((y, i) => items.push({ kind: 'sym', obj: y, key: i }));
  for (const it of items) if (typeof it.obj.layer === 'number') it.key = it.obj.layer;
  return items.sort((a, b) => a.key - b.key);
}

/** Art eines Objekts für „Plan ausdünnen“ (Symbolart, 'link' oder Zeichnungsart). */
export const thinKind = (it) => (it.kind === 'sym' ? it.obj.kind : it.kind === 'link' ? 'link' : it.obj.closed ? 'zone' : it.obj.type);

/** Deckkraft eines Objekts: eigenes Aufhellen und „Plan ausdünnen“ der Art (blass bzw. aus). */
export function opacityOf(section, it) {
  const look = (section.thin || {})[thinKind(it)];
  if (look === 'hidden') return 0;
  const own = 1 - (it.obj.fade || 0);
  return Math.round(own * (look === 'faded' ? 0.35 : 1) * 100) / 100;
}

/**
 * Seiten des Lageplans: [{ kind: 'plan' | 'list', svg, hits, site? }]. `site` (nur Plan) liefert dem
 * Editor Planfläche und Lage der Symbole in Seitenkoordinaten.
 */
/**
 * `pdf` (nur für die fertige PDF): { noPhotoSpots, photoOf: Symbol → Foto-Kennung } – Fotostandorte
 * weglassen bzw. Symbole mit Foto anklickbar machen (Sprung zum Foto).
 */
export function sitePages(section, ts, images, project = null, pdf = null) {
  const kinds = usedKinds(section);
  const area = siteArea(section);
  const labels = symbolLabels(section, project);
  const mpp = metersPerPt(section);
  const clip = (inner) =>
    inner
      ? `<svg x="${n(area.x)}" y="${n(area.y)}" width="${n(area.w)}" height="${n(area.h)}" viewBox="${n(area.x)} ${n(area.y)} ${n(area.w)} ${n(area.h)}" overflow="hidden">${inner}</svg>`
      : '';

  let svg = rect(area.x, area.y, area.w, area.h, { fill: '#fff' }) + backgroundSvg(section.bg, images, area);
  svg += rect(area.x, area.y, area.w, area.h, { stroke: C.rule, width: 0.7 });
  const hits = [{ kind: 'plan', rect: [area.x, area.y, area.w, area.h] }];
  const marks = [];
  const pos = new Map();
  for (const sym of section.symbols) pos.set(sym.id, toPt([sym.x, sym.y], area));
  const bbox = (pts) => {
    const xs = pts.map((p) => p[0]);
    const ys = pts.map((p) => p[1]);
    return [Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)];
  };
  // Zeichnungen, Strecken und Erfassungsbereiche enden am Planrand
  const faded = (inner, op) => (inner && op < 1 ? `<g opacity="${op}">${inner}</g>` : inner);
  // (verschachtelte Fläche statt clipPath: keine IDs, die in Miniaturen doppelt vorkämen)
  const clipped = (inner, op) =>
    inner
      ? `<svg x="${n(area.x)}" y="${n(area.y)}" width="${n(area.w)}" height="${n(area.h)}" viewBox="${n(area.x)} ${n(area.y)} ${n(area.w)} ${n(area.h)}" overflow="hidden">${faded(inner, op)}</svg>`
      : '';

  // Reihenfolge (Ebenen): erst Flächen, Linien, Strecken und Erfassungsbereiche, darüber die Symbole
  const order = siteOrder(section);
  const shapes = [];
  const links = [];
  const pdfLinks = []; // nur PDF: Sprünge zum Foto
  const dots = [];
  const ghosts = [];
  for (const it of order) {
    const op = pdf && pdf.noPhotoSpots && it.kind === 'sym' && it.obj.kind === 'photo' ? 0 : opacityOf(section, it);
    if (op <= 0) {
      // ausgeblendet: Lage trotzdem merken („Im Lageplan zeigen“ findet es)
      if (it.kind === 'sym') {
        const [x, y] = pos.get(it.obj.id);
        ghosts.push({ id: it.obj.id, x, y, r: 8 * it.obj.scale });
      }
      continue;
    }
    if (it.kind === 'shape') {
      const z = it.obj;
      const pts = z.pts.map((q) => toPt(q, area));
      svg += clipped(shapeSvg(z, pts, true) + shapeSvg(z, pts, false, mpp, ts) + shapeLabel(z, pts, mpp, ts), op);
      hits.push({ kind: 'shape', id: z.id, rect: bbox(pts), pts, closed: z.closed });
      shapes.push({ id: z.id, type: z.type, pts, closed: z.closed });
    } else if (it.kind === 'link') {
      const l = it.obj;
      const a = pos.get(l.from);
      if (!a) continue;
      const segs = l.to.map((t) => pos.get(t)).filter(Boolean).map((b) => [a, b]);
      if (!segs.length) continue;
      svg += clipped(segs.map(([p, q]) => linkSvg(p, q, l, mpp, ts)).join(''), op);
      hits.push({ kind: 'link', id: l.id, rect: bbox(segs.flat()), segs });
      links.push({ id: l.id, segs });
    } else {
      const sym = it.obj;
      const info = symbolInfo(section, sym.kind);
      if (!info) continue;
      const [x, y] = pos.get(sym.id);
      let tip = null;
      if (info.fov && sym.fov) {
        svg += clipped(fovSvg(info.color, x, y, sym.dir, sym.angle, sym.range, sym.cone === 'outline'), op);
        const rad = (sym.dir * Math.PI) / 180;
        tip = [x + sym.range * Math.sin(rad), y - sym.range * Math.cos(rad)];
      }
      dots.push({ sym, info, x, y, tip, op });
    }
  }
  for (const { sym, info, x, y, tip, op } of dots) {
    const r = 8 * sym.scale;
    let out = symbolSvg(info, x, y, r, images);
    const where = section.showNumbers ? sym.labelPos || 'auto' : 'none';
    if (where !== 'none') {
      // auf Wunsch Bus/Adresse an der Nummer („BM 3 · 1/12“)
      const bus = section.showBus && isBusKind(sym.kind) && (sym.bus || sym.addr) ? ` · ${[sym.bus, sym.addr].filter(Boolean).join('/')}` : '';
      const text_ = labels.get(sym.id) + bus;
      const w = ts.width(text_, 7.5, 700);
      const side = where === 'auto' ? (x + r + 2 + w > area.x + area.w ? 'left' : 'right') : where;
      if (side === 'right') out += label(x + r + 2, y + 2.6, text_, 'start');
      else if (side === 'left') out += label(x - r - 2, y + 2.6, text_, 'end');
      else if (side === 'top') out += label(x, y - r - 3, text_, 'middle');
      else out += label(x, y + r + 8.5, text_, 'middle');
    }
    svg += faded(out, op);
    hits.push({ kind: 'sym', id: sym.id, rect: [x - r - 2, y - r - 2, 2 * r + 4, 2 * r + 4] });
    const photo = pdf && pdf.photoOf.get(sym.id);
    if (photo) pdfLinks.push({ to: 'ph-' + photo, rect: [x - r - 2, y - r - 2, 2 * r + 4, 2 * r + 4] });
    marks.push({ id: sym.id, x, y, r, tip, fov: !!tip });
  }
  // Sprungziele der PDF: jedes Symbol (auch ausgeblendete, z. B. aus der Fotodokumentation)
  const anchors = pdf ? [...pos].map(([id, [x, y]]) => ({ id: 'sy-' + id, x: x - 40, y: y - 60 })) : [];
  if (mpp && section.scaleBar) svg += scaleBarSvg(area, mpp, ts);

  // Legende: Symbole, dann Zaun und Richtfunk
  // ausgeblendete Fotostandorte: auch nicht in der Legende (der Plan bleibt ruhig)
  const shownKinds = (section.thin || {}).photo === 'hidden' || (pdf && pdf.noPhotoSpots) ? kinds.filter(({ info }) => info.id !== 'photo') : kinds;
  const entries = shownKinds.map(({ info, count }) => ({
    head: `${info.code}  ${ts.inline(info.name)}`,
    tail: `  (${count})`,
    draw: (x, y) => symbolSvg(info, x + 6, y - 3, 6, images),
  }));
  const fences = section.shapes.filter((z) => z.type === 'fence');
  if (fences.length) {
    const col = color(fences[0].color);
    entries.push({
      head: ts.label('fence'),
      tail: mpp ? `  (${formatLength(fences.reduce((sum, z) => sum + pathLength(z.pts.map((q) => toPt(q, area)), z.closed), 0) * mpp, ts.lang === 'en' ? 'en' : 'de')})` : '',
      draw: (x, y) => `<line x1="${n(x)}" y1="${n(y - 3)}" x2="${n(x + 12)}" y2="${n(y - 3)}" stroke="${col}" stroke-width="1.5"/>` + posts([[x, y - 3], [x + 12, y - 3]], false, col),
    });
  }
  if (links.length)
    entries.push({
      head: ts.label('radioLink'),
      tail: `  (${links.length})`,
      draw: (x, y) => `<line x1="${n(x)}" y1="${n(y - 3)}" x2="${n(x + 12)}" y2="${n(y - 3)}" stroke="${RADIO}" stroke-width="1.5" stroke-dasharray="3 2"/>`,
    });
  if (entries.length) {
    const cols = Math.min(6, Math.max(3, Math.ceil(entries.length / LEGEND_ROWS)));
    const colW = (area.w + 10) / cols;
    const shown = entries.slice(0, cols * LEGEND_ROWS);
    const top = area.y + area.h + 8 + 12;
    svg += text(PAGE.left, top, ts.label('legend'), { size: 9.5, weight: 700 });
    shown.forEach(({ head, tail, draw }, i) => {
      const x = PAGE.left + (i % cols) * colW;
      const y = top + 16 + Math.floor(i / cols) * LEGEND_ROW;
      const cut = ellipsize(ts, head, 8.5, colW - 17 - 8 - ts.width(tail, 8.5, 400));
      svg += draw(x, y);
      svg += text(x + 17, y, cut + tail, { size: 8.5, fill: C.body });
    });
    if (shown.length < entries.length)
      svg += text(PAGE.right, top, `+ ${entries.length - shown.length}`, { size: 8.5, fill: C.muted, anchor: 'end' });
  }
  const pages = [
    {
      kind: 'plan',
      svg,
      hits,
      links: pdfLinks,
      anchors,
      site: { area, symbols: marks, ghosts, shapes, links, mpp },
    },
  ];

  // Geräteliste
  if (section.showList && symbolsInOrder(section).length) pages.push(...listPages(section, ts, labels, project));
  return pages;
}

/** Bemerkung einer Station mit Richtfunk-Angaben und IP (zweisprachig). */
function stationNote(section, sym, labels, project) {
  const parts = { de: [], en: [] };
  const nameOf = (ids) => ids.map((i) => labels.get(i)).filter(Boolean).join(', ');
  for (const l of section.links) {
    let key = null;
    let to = '';
    if (l.from === sym.id) {
      key = l.mode === 'ptmp' ? 'radioBase' : 'radioTo';
      to = nameOf(l.to);
    } else if (l.to.includes(sym.id)) {
      key = 'radioTo';
      to = nameOf([l.from]);
    }
    if (!key) continue;
    const extra = [l.band, l.ssid && `SSID ${l.ssid}`].filter(Boolean).join(', ');
    for (const lang of ['de', 'en']) parts[lang].push(str(key, lang, { to }) + (extra ? ` (${extra})` : ''));
  }
  // IP aus den Zugangsdaten (dieselben Daten, an einer Stelle gepflegt)
  const ip = (project && deviceOf(project, sym.id)?.ip) || sym.ip;
  if (ip) for (const lang of ['de', 'en']) parts[lang].push(`IP ${ip}`);
  // Montage und Anschluss: Bus/Adresse, Meldegruppe, Bereich, Rekorder-Kanal, Montagehöhe
  const add = (de, en) => (parts.de.push(de), parts.en.push(en));
  const busKind = isBusKind(sym.kind);
  if (busKind && (sym.bus || sym.addr)) {
    const bus = [sym.bus && `Bus ${sym.bus}`, sym.addr && `Adr. ${sym.addr}`].filter(Boolean).join(' / ');
    add(bus, bus.replace('Adr.', 'Addr.'));
  }
  if (busKind && sym.group) add(`MG ${sym.group}`, `Zone ${sym.group}`);
  if (busKind && sym.area) add(`Bereich ${sym.area}`, `Area ${sym.area}`);
  if (sym.kind === 'camera' && (sym.nvr || sym.channel)) {
    const nvr = sym.nvr && project ? (projectSymbols(project).find((x) => x.id === sym.nvr) || {}).label : '';
    add([nvr, sym.channel && `Kanal ${sym.channel}`].filter(Boolean).join(' / '), [nvr, sym.channel && `channel ${sym.channel}`].filter(Boolean).join(' / '));
  }
  if (isHeightKind(sym.kind) && sym.height) add(`Höhe ${sym.height}`, `Height ${sym.height}`);
  if (!parts.de.length) return sym.note;
  const join = (lang) => [...parts[lang], tx(sym.note, lang)].filter(Boolean).join(' · ');
  return { de: join('de'), en: join('en') };
}

/** Spalten der Geräteliste; die Bemerkung nimmt die übrige Breite (im Querformat mehr). */
const listCols = () => [
  { x: 48, w: 44, key: 'nr', label: 'nr', bold: true },
  { x: 92, w: 120, key: 'type', label: 'type' },
  { x: 212, w: 150, key: 'name', label: 'name' },
  { x: 362, w: PAGE.right - 362, key: 'note', label: 'remark' },
];

function listPages(section, ts, labels, project) {
  const COLS = listCols();
  const BOTTOM = PAGE.bottom;
  const WIDTH = PAGE.right - PAGE.left;
  const pages = [];
  let svg = '';
  let hits = [];
  let y = 132;
  const bi = ts.bi;
  const head = () => {
    const h = bi ? 28 : 20;
    svg += rect(PAGE.left, y, WIDTH, h, { fill: C.navy });
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
  symbolsInOrder(section).forEach((sym, i) => {
    const info = symbolInfo(section, sym.kind);
    if (!info) return;
    const cell = (value, w, weight = 400) =>
      ts.runs(value).flatMap((r) => wrap(r.text, 8.8, { family: ts.font.css, weight: r.sec ? 400 : weight, italic: r.sec }, w - 8).map((t) => ({ text: t, sec: r.sec })));
    const cells = {
      nr: [{ text: labels.get(sym.id), sec: false }],
      type: cell(info.name, COLS[1].w),
      name: cell(sym.name, COLS[2].w, 700),
      note: cell(stationNote(section, sym, labels, project), COLS[3].w),
    };
    const h = 16 + 10.56 * (Math.max(1, ...Object.values(cells).map((l) => l.length)) - 1);
    if (y + h > BOTTOM) {
      flush();
      head();
    }
    if (i % 2 === 0) svg += rect(PAGE.left, y, WIDTH, h, { fill: C.alt });
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
    hits.push({ kind: 'sym', id: sym.id, rect: [PAGE.left, y, WIDTH, h] });
    y += h;
  });
  pages.push({ kind: 'list', svg, hits });
  return pages;
}


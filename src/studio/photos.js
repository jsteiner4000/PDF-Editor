/**
 * Fotodokumentation: 1, 2, 4 oder 6 Fotos je Seite mit laufender Nummer, Bildunterschrift,
 * Aufnahmedatum und – falls verknüpft – dem Gerät aus dem Lageplan (z. B. „K 2 Kamera Einfahrt“).
 */
import { C, PAGE, esc, n, rect, text } from './svg.js';
import { projectSymbols } from './model.js';

const TOP = 124;
const BOTTOM = 770;
const GAP = 14;
const GRID = { 1: [1, 1], 2: [1, 2], 4: [2, 2], 6: [2, 3] };

/** Seiten der Fotodokumentation: [{ svg, hits }]. */
export function photoPages(section, ts, project) {
  const [cols, rows] = GRID[section.perPage] || GRID[4];
  const perPage = cols * rows;
  const links = new Map(projectSymbols(project, ts.lang).map((s) => [s.id, s]));
  const cellW = (PAGE.right - PAGE.left - GAP * (cols - 1)) / cols;
  const cellH = (BOTTOM - TOP - GAP * (rows - 1)) / rows;
  const pages = [];
  for (let start = 0; start < section.items.length || !pages.length; start += perPage) {
    let svg = '';
    const hits = [];
    section.items.slice(start, start + perPage).forEach((photo, i) => {
      const x = PAGE.left + (i % cols) * (cellW + GAP);
      const y = TOP + Math.floor(i / cols) * (cellH + GAP);
      const image = project.images[photo.image];
      const number = start + i + 1;

      // Beschriftung: Titelzeile, Bildunterschrift (höchstens 3 Zeilen), Datum und Verknüpfung
      const title = `${ts.label('photo')} ${number}`;
      const caption = ts
        .runs(photo.caption)
        .flatMap((r) => ts.wrap(r.text, 8.8, cellW - 4, r.sec ? 400 : 400, r.sec).map((t) => ({ text: t, sec: r.sec })))
        .slice(0, 4);
      if (caption.length > 3) {
        caption.length = 3;
        caption[2] = { ...caption[2], text: caption[2].text.replace(/\s*\S?$/, '') + '…' };
      }
      const link = photo.link && links.get(photo.link);
      const meta = [section.showDate && photo.date ? formatDate(photo.date, ts.lang) : '', link ? `${link.label} ${link.name}` : '']
        .filter(Boolean)
        .join('  ·  ');
      const captionH = 15 + caption.length * 10.6 + (meta ? 11 : 0) + 4;
      const boxH = cellH - captionH;

      svg += rect(x, y, cellW, boxH, { fill: C.alt, stroke: C.rule, width: 0.6 });
      if (image && image.data) {
        const s = Math.min((cellW - 2) / image.w, (boxH - 2) / image.h);
        const w = image.w * s;
        const h = image.h * s;
        svg += `<image href="${esc(image.data)}" x="${n(x + (cellW - w) / 2)}" y="${n(y + (boxH - h) / 2)}" width="${n(w)}" height="${n(h)}"/>`;
      }
      let ty = y + boxH + 12;
      svg += text(x, ty, title, { size: 9.5, weight: 700 });
      for (const l of caption) {
        ty += 10.6;
        svg += text(x, ty, l.text, { size: 8.8, fill: l.sec ? C.muted : C.body, italic: l.sec });
      }
      if (meta) svg += text(x, ty + 11, meta, { size: 8, fill: C.muted });
      hits.push({ kind: 'photo', id: photo.id, rect: [x, y, cellW, cellH] });
    });
    pages.push({ svg, hits });
  }
  return pages;
}

function formatDate(iso, lang) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return iso || '';
  return lang === 'en' ? `${m[1]}-${m[2]}-${m[3]}` : `${m[3]}.${m[2]}.${m[1]}`;
}

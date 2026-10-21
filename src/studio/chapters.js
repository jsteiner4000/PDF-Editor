/**
 * Anleitung / Technische Beschreibung: Bausteine (Überschrift, Absatz, Aufzählung,
 * Handlungsschritte, Hinweiskästen, Abbildungen, Tabellen, Code, Formel) werden fortlaufend auf
 * A4-Seiten gesetzt. Absätze, Listen, Kästen, Code und Tabellen laufen über Seitenumbrüche weiter
 * (keine einzelne Zeile am Seitenanfang oder -ende, Überschriften bleiben beim Text, Tabellen
 * wiederholen ihre Kopfzeile).
 *
 * Nummerierung (1, 1.1, Abbildung 3, Tabelle 2) und Querverweise ({ref:Kennung}) entstehen
 * automatisch.
 */
import { C, MONO, PAGE, esc, line, n, rect, text } from './svg.js';
import { STRINGS, TONES, tx } from './model.js';
import { wrap } from './measure.js';

const TOP = 124;
// Unterkante und Satzbreite: je nach Seitenformat, beim Setzen eines Abschnitts übernommen
let BOTTOM = PAGE.bottom;
let W = PAGE.right - PAGE.left;
const LEAD = 13.5;
const SIZE = 9.5;

const REF_RE = /\{ref:([A-Za-z0-9_-]+)\}/g;

/** Nummern der Überschriften, Abbildungen und Tabellen: Kennung → { label, kind }. */
export function chapterLabels(section) {
  const out = new Map();
  let h1 = 0;
  let h2 = 0;
  let fig = 0;
  let tab = 0;
  for (const b of section.blocks) {
    if (b.type === 'h') {
      if (b.level === 2) h2++;
      else {
        h1++;
        h2 = 0;
      }
      out.set(b.id, { kind: 'h', label: b.level === 2 ? `${h1}.${h2}` : String(h1) });
    } else if (b.type === 'figure' || b.type === 'figsteps') out.set(b.id, { kind: 'figure', label: String(++fig) });
    else if (b.type === 'table' && tx(b.caption)) out.set(b.id, { kind: 'table', label: String(++tab) });
  }
  return out;
}

/** Ziele für „Verweis einfügen“: [{ id, text }]. */
export function referenceTargets(section, lang = 'de') {
  const labels = chapterLabels(section);
  const out = [];
  for (const b of section.blocks) {
    const l = labels.get(b.id);
    if (!l) continue;
    const word = l.kind === 'h' ? tx(STRINGS.section, lang) : tx(STRINGS[l.kind], lang);
    const name = b.type === 'h' ? tx(b.text, lang) : tx(b.caption, lang);
    out.push({ id: b.id, text: `${word} ${l.label}${name ? ' – ' + name.slice(0, 40) : ''}` });
  }
  return out;
}

/**
 * Setzt die Bausteine in Seiten: [{ svg, hits, heads }]. `heads` = Überschriften der Ebene 1 auf der
 * Seite (für das Inhaltsverzeichnis).
 */
export function chapterPages(section, ts, project) {
  BOTTOM = PAGE.bottom;
  W = PAGE.right - PAGE.left;
  const labels = chapterLabels(section);
  const images = project.images;
  const numbered = section.numbering;

  /** Verweise {ref:…} in der Sprache des Textes auflösen. */
  const resolve = (value, lang) =>
    value.replace(REF_RE, (_, id) => {
      const l = labels.get(id);
      if (!l) return tx(STRINGS.refMissing, lang);
      if (l.kind === 'h') {
        const b = section.blocks.find((x) => x.id === id);
        return numbered ? `${tx(STRINGS.section, lang)} ${l.label}` : `„${tx(b.text, lang)}“`;
      }
      return `${tx(STRINGS[l.kind], lang)} ${l.label}`;
    });
  const runs = (value) => ts.runs(value).map((r) => ({ ...r, text: resolve(r.text, r.sec ? 'en' : ts.lang) }));
  const style = (weight = 400, italic = false, mono = false) => ({ family: mono ? MONO : ts.font.css, weight, italic });
  const wrapText = (value, size, width, o = {}) => wrap(value, size, style(o.weight, o.italic, o.mono), width);

  // ---- Bausteine → Atome --------------------------------------------------------------------
  const atoms = [];
  const add = (a) => atoms.push(a);

  const textLines = (value, width, opts = {}) =>
    runs(value).flatMap((r) =>
      wrapText(r.text, SIZE, width, { italic: r.sec }).map((t, i) => ({ text: t, sec: r.sec, first: i === 0, ...opts })),
    );

  /** Zeilenweise teilbarer Baustein. `lines`: [{ text, sec, mark?, indent? }]. */
  const linesAtom = (b, lines, o = {}) =>
    lines.length &&
    add({
      kind: 'lines',
      block: b.id,
      before: o.before ?? 8,
      lines,
      lineH: o.lineH ?? LEAD,
      pad: o.pad || [0, 0],
      minLines: o.minLines ?? 2,
      draw: o.draw,
      bg: o.bg,
    });

  for (const b of section.blocks) {
    if (b.type === 'h') {
      const label = numbered ? labels.get(b.id).label : '';
      const indent = numbered ? (b.level === 2 ? 30 : 24) : 0;
      const size = b.level === 2 ? 11 : 14;
      const rs = runs(b.text);
      const main = rs.find((r) => !r.sec);
      const sec = rs.find((r) => r.sec);
      const mainLines = main ? wrapText(main.text, size, W - indent, { weight: 700 }) : [];
      const secLines = sec ? wrapText(sec.text, size - 3, W - indent, { italic: true }) : [];
      if (!mainLines.length && !secLines.length) continue;
      const lh = size + 5;
      const h = mainLines.length * lh + secLines.length * 11 + (b.level === 2 ? 3 : 7);
      add({
        kind: 'box',
        block: b.id,
        before: b.level === 2 ? 12 : 20,
        h,
        keepNext: true,
        heading: b.level === 1 ? `${label ? label + '  ' : ''}${main ? main.text : sec.text}` : null,
        draw: (y) => {
          let s = '';
          if (label) s += text(PAGE.left, y + size + 1, label, { size, weight: 700, fill: C.navy });
          mainLines.forEach((l, i) => (s += text(PAGE.left + indent, y + size + 1 + i * lh, l, { size, weight: 700 })));
          secLines.forEach((l, i) => {
            s += text(PAGE.left + indent, y + mainLines.length * lh + 9 + i * 11, l, { size: size - 3, italic: true, fill: C.muted });
          });
          if (b.level !== 2) s += line(PAGE.left, y + h - 2, PAGE.right, y + h - 2, C.rule, 0.7);
          return s;
        },
      });
    } else if (b.type === 'p') {
      linesAtom(b, textLines(b.text, W), { before: 7 });
    } else if (b.type === 'ul' || b.type === 'steps') {
      const lines = [];
      for (const r of runs(b.text)) {
        const items = r.text.split('\n').map((t) => t.trim()).filter(Boolean);
        items.forEach((item, k) => {
          const mark = b.type === 'steps' ? `${k + 1}.` : '•';
          wrapText(item, SIZE, W - 18, { italic: r.sec }).forEach((t, i) => lines.push({ text: t, sec: r.sec, mark: i === 0 ? mark : null, steps: b.type === 'steps' }));
        });
      }
      linesAtom(b, lines, { before: 7, lineH: 13.5, minLines: 2 });
    } else if (b.type === 'callout') {
      const tone = TONES.find((t) => t.id === b.tone) || TONES[0];
      const title = runs(b.title).length ? runs(b.title).map((r) => r.text).join(' / ') : ts.inline(STRINGS.tone[b.tone] || STRINGS.tone.note);
      const lines = [{ text: title, title: true }, ...runs(b.text).flatMap((r) => wrapText(r.text, 9, W - 30, { italic: r.sec }).map((t) => ({ text: t, sec: r.sec })))];
      atomsPush(add, b, lines, tone.color, tone.id === 'open', ts.label('continued'));
    } else if (b.type === 'code') {
      const lines = (b.text || '')
        .split('\n')
        .flatMap((l) => (l === '' ? [''] : wrapText(l, 8.4, W - 20, { mono: true })))
        .map((t) => ({ text: t, mono: true }));
      linesAtom(b, lines, { before: 8, lineH: 11, pad: [8, 8], minLines: 3, bg: true });
    } else if (b.type === 'formula') {
      const lines = wrapText(b.text || '', 11, W - 40, { italic: true });
      if (!lines.length) continue;
      const h = lines.length * 15 + 18;
      add({
        kind: 'box',
        block: b.id,
        before: 8,
        h,
        draw: (y) =>
          rect(PAGE.left, y, W, h, { fill: C.hub, stroke: C.rule, width: 0.6 }) +
          lines.map((l, i) => text(PAGE.left + W / 2, y + 17 + i * 15, l, { size: 11, italic: true, anchor: 'middle' })).join(''),
      });
    } else if (b.type === 'figure' || b.type === 'figsteps') {
      figureAtom(add, b, labels, runs, wrapText, images, ts);
    } else if (b.type === 'table') {
      tableAtoms(add, b, labels, runs, wrapText, ts);
    }
  }

  // ---- Atome → Seiten ----------------------------------------------------------------------
  const pages = [];
  let cur = { svg: '', hits: [], heads: [] };
  let y = TOP;
  const flush = () => {
    if (cur.svg) pages.push(cur);
    cur = { svg: '', hits: [], heads: [] };
    y = TOP;
  };
  const hit = (a, y0, y1) => a.block && cur.hits.push({ kind: 'block', id: a.block, rect: [PAGE.left, y0, W, Math.max(8, y1 - y0)] });
  /** Mindesthöhe, die ein Atom am Seitenende braucht (für „Überschrift bleibt beim Text“). */
  const minHeight = (a) => {
    if (!a) return 0;
    if (a.kind === 'box') return a.before + a.h;
    if (a.kind === 'lines') {
      // zu kurz zum Teilen (weniger als zweimal die Mindestzeilen): braucht den ganzen Baustein
      const n = a.lines.length < 2 * a.minLines ? a.lines.length : a.minLines;
      return a.before + a.pad[0] + a.pad[1] + n * a.lineH;
    }
    if (a.kind === 'rows') return a.before + a.head.h + a.rows[0].h;
    return 0;
  };

  for (let i = 0; i < atoms.length; i++) {
    const a = atoms[i];
    if (a.kind === 'box') {
      let before = y === TOP ? 0 : a.before;
      const follow = a.keepNext ? minHeight(atoms[i + 1]) : 0;
      if (y + before + a.h + follow > BOTTOM && y > TOP) {
        flush();
        before = 0;
      }
      const y0 = y + before;
      cur.svg += a.draw(y0);
      if (a.heading) cur.heads.push({ title: a.heading, level: 1 });
      hit(a, y0, y0 + a.h);
      y = y0 + a.h;
    } else if (a.kind === 'lines') {
      let from = 0;
      const total = a.lines.length;
      while (from < total) {
        let before = y === TOP ? 0 : from === 0 ? a.before : 0;
        const room = Math.floor((BOTTOM - y - before - a.pad[0] - a.pad[1]) / a.lineH);
        const left = total - from;
        let take;
        const split = Math.min(room, left - a.minLines); // am Ende bleiben mindestens `minLines` Zeilen
        if (room >= left) take = left;
        else if (split >= a.minLines) take = split;
        else if (y > TOP) {
          flush();
          continue;
        } else take = Math.max(1, Math.min(room, left));
        const y0 = y + before;
        const h = a.pad[0] + take * a.lineH + a.pad[1];
        cur.svg += drawLines(a, y0, from, from + take, h);
        hit(a, y0, y0 + h);
        y = y0 + h;
        from += take;
        if (from < total) flush();
      }
    } else if (a.kind === 'rows') {
      let from = 0;
      while (from < a.rows.length) {
        let before = y === TOP ? 0 : from === 0 ? a.before : 0;
        if (y + before + a.head.h + a.rows[from].h > BOTTOM && y > TOP) {
          flush();
          continue;
        }
        const y0 = y + before;
        let yy = y0;
        cur.svg += a.head.draw(yy);
        yy += a.head.h;
        let k = from;
        while (k < a.rows.length && yy + a.rows[k].h <= BOTTOM) {
          cur.svg += a.rows[k].draw(yy, k);
          yy += a.rows[k].h;
          k++;
        }
        if (k === from) {
          cur.svg += a.rows[k].draw(yy, k);
          yy += a.rows[k].h;
          k++;
        }
        hit(a, y0, yy);
        y = yy;
        from = k;
        if (from < a.rows.length) flush();
      }
    }
  }
  flush();
  if (!pages.length) pages.push({ svg: '', hits: [], heads: [] });
  return pages;
}

/** Kasten (Hinweis/Warnung/Offen) als teilbarer Zeilenbaustein. */
function atomsPush(add, b, lines, color, dashed, cont) {
  add({
    kind: 'lines',
    block: b.id,
    before: 9,
    lines,
    lineH: 12,
    pad: [10, 9],
    minLines: 3,
    callout: { color, dashed, cont },
  });
}

/** Zeichnet die Zeilen [from, to) eines Zeilenbausteins ab `y0` (Höhe `h`). */
function drawLines(a, y0, from, to, h) {
  let s = '';
  if (a.callout) {
    const c = a.callout.color;
    s += rect(PAGE.left, y0, W, h, { fill: C.card });
    s += rect(PAGE.left, y0, 4, h, { fill: c });
    if (a.callout.dashed) s += rect(PAGE.left + 0.5, y0 + 0.5, W - 1, h - 1, { stroke: c, width: 0.6 }).replace('fill="none"', 'fill="none" stroke-dasharray="3 3"');
  } else if (a.bg) s += rect(PAGE.left, y0, W, h, { fill: C.hub, stroke: C.rule, width: 0.6 });
  const x0 = a.callout ? PAGE.left + 14 : a.bg ? PAGE.left + 10 : PAGE.left;
  for (let i = from; i < to; i++) {
    const l = a.lines[i];
    const base = y0 + a.pad[0] + (i - from) * a.lineH + a.lineH * 0.76;
    if (l.title) {
      const first = i === 0;
      s += text(x0, base + 1, first ? l.text : `${l.text} (${a.callout.cont})`, { size: 9.8, weight: 700, fill: a.callout.color });
    } else if (l.mark !== undefined && l.mark !== null) {
      s += text(x0, base, l.mark, { size: SIZE, weight: 700, fill: l.sec ? C.muted : C.navy });
      s += text(x0 + 18, base, l.text, { size: SIZE, fill: l.sec ? C.muted : C.body, italic: l.sec });
    } else if (l.mark === null && (l.steps !== undefined)) {
      s += text(x0 + 18, base, l.text, { size: SIZE, fill: l.sec ? C.muted : C.body, italic: l.sec });
    } else if (l.mono) s += text(x0, base, l.text, { size: 8.4, family: MONO, fill: C.body });
    else s += text(x0, base, l.text, { size: a.callout ? 9 : SIZE, fill: l.sec ? C.muted : C.body, italic: l.sec });
  }
  return s;
}

/** Abbildung (mit Platzhalter, wenn noch kein Bild gewählt ist) und Abbildung mit Schritten. */
function figureAtom(add, b, labels, runs, wrapText, images, ts) {
  const img = b.image && images[b.image];
  const side = b.type === 'figsteps';
  const num = labels.get(b.id).label;
  const capRuns = runs(b.caption);
  const capText = `${ts.label('figure')} ${num}${capRuns.length ? ' – ' + capRuns.map((r) => r.text).join(' / ') : ''}`;
  const boxW = side ? 215 : b.width === 'half' ? W / 2 : W;
  const maxH = side ? 230 : b.width === 'half' ? 220 : 300;
  let w = boxW;
  let h = Math.round(boxW * 0.62);
  if (img && img.w && img.h) {
    const s = Math.min(boxW / img.w, maxH / img.h);
    w = img.w * s;
    h = img.h * s;
  } else h = Math.min(h, maxH);
  const capLines = wrapText(capText, 8.5, side ? boxW : W, { italic: true });
  const stepLines = [];
  if (side)
    for (const r of runs(b.text)) {
      r.text
        .split('\n')
        .map((t) => t.trim())
        .filter(Boolean)
        .forEach((item, k) =>
          wrapText(item, SIZE, W - boxW - 16 - 18, { italic: r.sec }).forEach((t, i) => stepLines.push({ text: t, mark: i === 0 ? `${k + 1}.` : null, sec: r.sec })),
        );
    }
  const left = h + 6 + capLines.length * 10.5;
  const right = stepLines.length * LEAD;
  add({
    kind: 'box',
    block: b.id,
    before: 10,
    h: Math.max(left, right),
    draw: (y) => {
      const x = side ? PAGE.left : PAGE.left + (W - w) / 2;
      let s = '';
      if (img && img.data) s += `<image href="${esc(img.data)}" x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"/>` + rect(x, y, w, h, { stroke: C.rule, width: 0.5 });
      else
        s +=
          rect(x, y, w, h, { fill: C.alt, stroke: C.rule, width: 0.8 }).replace('fill="#f5f8f9"', 'fill="#f5f8f9" stroke-dasharray="4 3"') +
          text(x + w / 2, y + h / 2 + 3, tx(STRINGS.figurePending, ts.lang), { size: 9, fill: C.muted, anchor: 'middle' });
      capLines.forEach((l, i) => {
        s += text(side ? x : PAGE.left + W / 2, y + h + 14 + i * 10.5 - 3, l, { size: 8.5, italic: true, fill: C.muted, anchor: side ? 'start' : 'middle' });
      });
      stepLines.forEach((l, i) => {
        const yy = y + 10 + i * LEAD;
        if (l.mark) s += text(PAGE.left + boxW + 16, yy, l.mark, { size: SIZE, weight: 700, fill: l.sec ? C.muted : C.navy });
        s += text(PAGE.left + boxW + 16 + 18, yy, l.text, { size: SIZE, fill: l.sec ? C.muted : C.body, italic: l.sec });
      });
      return s;
    },
  });
}

/** Tabelle: Beschriftung, Kopfzeile (wiederholt sich), Zeilen im Wechsel hinterlegt. */
function tableAtoms(add, b, labels, runs, wrapText, ts) {
  const total = b.weights.reduce((s, v) => s + v, 0);
  let x = PAGE.left;
  const col = b.weights.map((wt) => {
    const w = (W * wt) / total;
    const c = { x, w };
    x += w;
    return c;
  });
  const cap = labels.get(b.id);
  if (cap) {
    const t = `${ts.label('table')} ${cap.label} – ${runs(b.caption).map((r) => r.text).join(' / ')}`;
    const lines = wrapText(t, 8.5, W, { weight: 700 });
    add({
      kind: 'box',
      block: b.id,
      before: 10,
      h: lines.length * 10.5 + 4,
      keepNext: true,
      draw: (y) => lines.map((l, i) => text(PAGE.left, y + 9 + i * 10.5, l, { size: 8.5, weight: 700, fill: C.muted })).join(''),
    });
  }
  const head = {
    h: 20,
    draw: (y) => rect(PAGE.left, y, W, 20, { fill: C.navy }) + b.head.map((t, i) => text(col[i].x + 6, y + 13, t, { size: 9, weight: 700, fill: '#fff' })).join(''),
  };
  const rows = b.rows.map((row) => {
    const cells = row.map((t, i) => wrapText(resolveCell(t, labels, ts), 8.8, col[i].w - 12));
    const h = 16 + 10.56 * (Math.max(1, ...cells.map((c) => c.length)) - 1);
    return {
      h,
      draw: (y, k) => {
        let s = k % 2 === 0 ? rect(PAGE.left, y, W, h, { fill: C.alt }) : '';
        cells.forEach((lines, i) =>
          lines.forEach((l, j) => (s += text(col[i].x + 6, y + 11 + 10.56 * j, l, { size: 8.8, weight: i === 0 && b.preset !== 'table' ? 700 : 400, fill: i === 0 && b.preset !== 'table' ? C.navy : C.body }))),
        );
        return s + line(PAGE.left, y + h, PAGE.right, y + h, C.rule, 0.5);
      },
    };
  });
  if (!rows.length) return;
  add({ kind: 'rows', block: b.id, before: cap ? 0 : 10, head, rows });
}

/** Zellen einer Tabelle: Verweise in der Hauptsprache auflösen. */
function resolveCell(value, labels, ts) {
  return String(value || '').replace(REF_RE, (_, id) => {
    const l = labels.get(id);
    return l ? `${l.kind === 'h' ? tx(STRINGS.section, ts.lang) : tx(STRINGS[l.kind], ts.lang)} ${l.label}` : tx(STRINGS.refMissing, ts.lang);
  });
}

/**
 * Erkennung von Seitenzahlen und Kopf-/Fußzeilen sowie deren Aktualisierung.
 */
import { blockToEditLines } from './session.js';

const PAGE_NUMBER_RE = /^(?:(Seite|Page|S\.|p\.)\s*)?(\d{1,4})(?:\s*(\/|von|of|\|)\s*(\d{1,4}))?$/i;

const approxEqual = (a, b, tolerance = 2) => Math.abs(a - b) <= tolerance;

export function detectPageStructure(session) {
  const numPages = session.numPages;
  const pages = [];
  for (let k = 0; k < numPages; k++) {
    const model = session.model(k);
    const info = session.pageInfo(k);
    const inMargin = (box) => box[1] > info.y + info.h * 0.88 || box[3] < info.y + info.h * 0.12;
    pages.push({
      i: k,
      m: model,
      info,
      blocks: model.blocks.filter((block) => block.editable && inMargin(block.bbox)),
      objects: model.objects.filter((obj) => obj.selectable && obj.type === 'path' && inMargin(obj.vis)),
    });
  }
  const candidates = [];
  for (const page of pages)
    for (const block of page.blocks) {
      const match = block.text.trim().replace(/\s+/g, ' ').match(PAGE_NUMBER_RE);
      if (match)
        candidates.push({
          page: page.i,
          block,
          num: +match[2],
          total: match[4] ? +match[4] : null,
          prefix: match[1] || '',
          sep: match[3] || '',
        });
    }
  let best = null;
  const groups = new Map();
  for (const cand of candidates) {
    const offset = cand.num - (cand.page + 1);
    const totalDelta = cand.total != null ? cand.total - numPages : null;
    const key = offset + '|' + (totalDelta ?? '-') + '|' + cand.prefix + '|' + cand.sep;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(cand);
  }
  for (const [, items] of groups) {
    const yVotes = new Map();
    items.forEach((m) => {
      const lineY = Math.round(m.block.lines[0].y);
      yVotes.set(lineY, (yVotes.get(lineY) || 0) + 1);
    });
    const [y] = [...yVotes.entries()].sort((m, b) => b[1] - m[1])[0];
    const aligned = items.filter((m) => approxEqual(m.block.lines[0].y, y, 2));
    const perPage = new Map();
    aligned.forEach((m) => {
      if (!perPage.has(m.page)) perPage.set(m.page, m);
    });
    if (perPage.size < 2) continue;
    const first = aligned[0];
    const info = pages[first.page].info;
    const marginRatio =
      Math.min(first.block.bbox[1] - info.y, info.y + info.h - first.block.bbox[3]) / info.h;
    const score =
      perPage.size * 10 +
      (first.total != null ? 8 : 0) +
      (1 - marginRatio * 8) * 4 -
      (/^0\d/.test(first.block.text.trim()) ? 12 : 0);
    if (!best || score > best.score) best = { items: [...perPage.values()], score };
  }
  let pageNumbers = null;
  if (best && best.items.length >= Math.min(2, numPages)) {
    const items = best.items;
    const first = items[0];
    const lefts = items.map((p) => p.block.bbox[0]);
    const rights = items.map((p) => p.block.bbox[2]);
    const spread = (values) => Math.max(...values) - Math.min(...values);
    const align =
      spread(rights) < 1.5 && spread(lefts) >= spread(rights)
        ? 'right'
        : spread(lefts) < 1.5
          ? 'left'
          : 'center';
    pageNumbers = {
      offset: first.num - (first.page + 1),
      withTotal: first.total != null,
      totalDelta: first.total != null ? first.total - numPages : 0,
      prefix: first.prefix,
      sep: first.sep,
      align,
      y: first.block.lines[0].y,
      anchor:
        align === 'right'
          ? first.block.bbox[2]
          : align === 'left'
            ? first.block.bbox[0]
            : (first.block.bbox[0] + first.block.bbox[2]) / 2,
      sample: first,
      pagesFound: items.length,
    };
  }
  const running = [];
  const minPages = Math.max(2, Math.ceil(numPages * 0.5));
  const blockRuns = new Map();
  for (const page of pages)
    for (const block of page.blocks) {
      if (pageNumbers && PAGE_NUMBER_RE.test(block.text.trim().replace(/\s+/g, ' '))) continue;
      const key = block.text + '@' + Math.round(block.bbox[0]) + ',' + Math.round(block.bbox[1]);
      if (!blockRuns.has(key)) blockRuns.set(key, { kind: 'block', block, page: page.i, pages: new Set() });
      blockRuns.get(key).pages.add(page.i);
    }
  for (const run of blockRuns.values()) if (run.pages.size >= minPages) running.push(run);
  const objectRuns = new Map();
  for (const page of pages)
    for (const obj of page.objects) {
      const key = obj.vis.map((d) => Math.round(d)).join(',');
      if (!objectRuns.has(key))
        objectRuns.set(key, { kind: 'object', object: obj, page: page.i, pages: new Set() });
      objectRuns.get(key).pages.add(page.i);
    }
  for (const run of objectRuns.values()) if (run.pages.size >= minPages) running.push(run);
  return { pageNumbers, running };
}

export function formatPageNumber(spec, index, total) {
  let text = String(index + 1 + spec.offset);
  if (spec.withTotal)
    text +=
      (spec.sep === '/' || spec.sep === '|' ? ` ${spec.sep} ` : ` ${spec.sep} `) + (total + spec.totalDelta);
  return (spec.prefix ? spec.prefix + ' ' : '') + text;
}

export async function updatePageNumbers(session, spec, opts = {}) {
  const addTo = opts.addTo || new Set();
  const numPages = session.numPages;
  let changed = 0;
  const fam = spec.sample.block.fam;
  const sampleGlyph = spec.sample.block.glyphs[0];
  for (let k = 0; k < numPages; k++) {
    const label = formatPageNumber(spec, k, numPages);
    const existing = session
      .model(k)
      .blocks.find(
        (block) =>
          approxEqual(block.lines[0].y, spec.y, 2) &&
          PAGE_NUMBER_RE.test(block.text.trim().replace(/\s+/g, ' ')) &&
          Math.abs(
            (spec.align === 'right'
              ? block.bbox[2]
              : spec.align === 'left'
                ? block.bbox[0]
                : (block.bbox[0] + block.bbox[2]) / 2) - spec.anchor,
          ) < 30,
      );
    if (
      (existing && existing.text.trim().replace(/\s+/g, ' ') === label) ||
      (!existing && !addTo.has(session.page(k).ref.toString()))
    )
      continue;
    const glyph = existing ? existing.glyphs[0] : sampleGlyph;
    const size = glyph.size;
    const fill = glyph.fill;
    const labelFam = existing ? existing.fam : fam;
    let width = 0;
    for (const ch of label) width += (session.fonts.adv(labelFam, ch) / 1000) * size;
    const x =
      spec.align === 'right'
        ? spec.anchor - width
        : spec.align === 'left'
          ? spec.anchor
          : spec.anchor - width / 2;
    const xs = [];
    let cursor = x;
    for (const ch of label) {
      xs.push(cursor);
      cursor += (session.fonts.adv(labelFam, ch) / 1000) * size;
    }
    session.beginEdit(k, existing || null);
    await session.commitEdit(
      [{ segs: [{ x, y: spec.y, text: label, xs, fam: labelFam, size, color: fill, alpha: glyph.alpha }] }],
      'Seitenzahl angepasst',
    );
    changed++;
  }
  return changed;
}

export async function copyRunningElements(session, running, fromIndex, toIndex) {
  const model = session.model(fromIndex);
  const info = session.pageInfo(fromIndex);
  const topLimit = info.y + info.h * 0.94;
  const bottomLimit = info.y + info.h * 0.06;
  const inMargin = (box) => box[1] >= topLimit - 0.5 || box[3] <= bottomLimit + 0.5;
  const isRunning = (box) =>
    running.some((d) =>
      (d.kind === 'block' ? d.block.bbox : d.object.vis).every((C, p) => approxEqual(C, box[p], 1.5)),
    );
  const blocks = model.blocks.filter(
    (block) =>
      block.editable && inMargin(block.bbox) && !PAGE_NUMBER_RE.test(block.text.trim().replace(/\s+/g, ' ')),
  );
  const paths = model.objects.filter((obj) => obj.selectable && obj.type === 'path' && inMargin(obj.vis));
  const ops = [];
  for (const path of paths) {
    const [x0, y0, x1, y1] = path.vis;
    const color = path.color || [0, 0, 0];
    const round = (value) => Math.round(value * 1000) / 1000;
    if (path.fill)
      ops.push(
        `${round(color[0])} ${round(color[1])} ${round(color[2])} rg ${round(x0)} ${round(y0)} ${round(x1 - x0)} ${round(y1 - y0)} re f`,
      );
    else
      ops.push(
        `${round(color[0])} ${round(color[1])} ${round(color[2])} RG 0.75 w ${round(x0)} ${round((y0 + y1) / 2)} m ${round(x1)} ${round((y0 + y1) / 2)} l S`,
      );
  }
  if (ops.length) session.appendRaw(toIndex, 'q\n' + ops.join('\n') + '\nQ', 'Kopf-/Fußzeile übernommen');
  for (const block of blocks) {
    session.beginEdit(toIndex, null);
    await session.commitEdit(blockToEditLines(block), 'Kopf-/Fußzeile übernommen');
  }
  return blocks.length + paths.length;
}

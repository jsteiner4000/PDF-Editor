/**
 * Gruppiert Glyphen zu Zeilen und Zeilen zu Textblöcken (Absätze, Ausrichtung).
 */

const isSpaceChar = (ch) => ch === ' ' || ch === '\xA0' || ch === '\t';

const isUpright = (glyph) =>
  Math.abs(glyph.trm[1]) < 0.001 * Math.abs(glyph.trm[0] || 1) &&
  Math.abs(glyph.trm[2]) < 0.001 * Math.abs(glyph.trm[3] || 1) &&
  glyph.trm[0] > 0 &&
  glyph.trm[3] > 0;

/**
 * Wie `array.find`, sucht aber nur im Umkreis von `radius` Einträgen um `index`. Die Zeilen liegen
 * nach Höhe geordnet vor, Fortsetzungen stehen also nahe beieinander. Auf echten Seiten (weit unter
 * 3000 Zeilen) ändert sich nichts; bei absichtlich vermüllten Seiten (tausende Textstücke an
 * derselben Stelle) bleibt der Aufwand so begrenzt statt quadratisch.
 */
const MAX_SEARCH_RADIUS = 3000;
function findNear(array, index, predicate) {
  const from = Math.max(0, index - MAX_SEARCH_RADIUS);
  const to = Math.min(array.length, index + MAX_SEARCH_RADIUS);
  for (let i = from; i < to; i++) if (predicate(array[i])) return array[i];
  return undefined;
}

const onSameBaseline = (y1, size1, y2, size2) =>
  Math.max(size1, size2) / Math.max(0.01, Math.min(size1, size2)) > 1.5
    ? Math.abs(y1 - y2) < 0.1 * Math.min(size1, size2)
    : Math.abs(y1 - y2) < 0.3 * Math.max(size1, size2);

export function buildTextLines(glyphs) {
  const runs = [];
  let current = null;
  for (const glyph of glyphs) {
    if (glyph.mode === 3 || glyph.mode === 7) continue;
    const size = glyph.size || 1;
    const upright = isUpright(glyph);
    if (
      current &&
      current.up === upright &&
      upright &&
      onSameBaseline(glyph.y, size, current.y, current.size) &&
      glyph.x > current.ex - 0.3 * size &&
      glyph.x - current.ex < 1.2 * Math.max(size, current.size)
    ) {
      current.glyphs.push(glyph);
      current.ex = Math.max(current.ex, glyph.ex);
      current.size = Math.max(current.size, size);
    } else {
      current = { glyphs: [glyph], y: glyph.y, ex: glyph.ex, x: glyph.x, size, up: upright };
      runs.push(current);
    }
  }
  runs.sort((n, a) => a.y - n.y || n.x - a.x);
  const lines = [];
  for (const run of runs) {
    const line = findNear(
      lines,
      lines.length,
      (A) =>
        A.up &&
        run.up &&
        onSameBaseline(A.y, A.size, run.y, run.size) &&
        run.x > A.x0 - 0.3 * run.size &&
        run.x - A.ex < 1.2 * Math.max(A.size, run.size) &&
        run.x >= A.ex - 0.3 * run.size,
    );
    if (line) {
      line.glyphs.push(...run.glyphs);
      line.ex = Math.max(line.ex, run.ex);
      line.size = Math.max(line.size, run.size);
    } else
      lines.push({ glyphs: run.glyphs.slice(), y: run.y, x0: run.x, ex: run.ex, size: run.size, up: run.up });
  }
  for (let k = lines.length - 1; k >= 0; k--) {
    const line = lines[k];
    if (line.glyphs.length > 3) continue;
    const target = findNear(
      lines,
      k,
      (s) =>
        s !== line &&
        s.up &&
        line.up &&
        s.glyphs.length > line.glyphs.length + 2 &&
        Math.abs(line.y - s.y) < 0.6 * s.size &&
        line.x0 > s.x0 &&
        line.ex < s.ex + 0.5 * s.size,
    );
    if (target) {
      target.glyphs.push(...line.glyphs);
      target.ex = Math.max(target.ex, line.ex);
      lines.splice(k, 1);
    }
  }
  for (const line of lines) {
    line.glyphs.sort((l, c) => l.x - c.x);
    line.x0 = line.glyphs[0].x;
    line.ex = Math.max(...line.glyphs.map((glyph) => glyph.ex));
    const yVotes = new Map();
    line.glyphs.forEach((glyph) => {
      const y = Math.round(glyph.y * 10) / 10;
      const vote = yVotes.get(y);
      if (vote) vote.n++;
      else yVotes.set(y, { n: 1, y: glyph.y });
    });
    line.y = [...yVotes.values()].sort((l, c) => c.n - l.n)[0].y;
    const sizeVotes = new Map();
    line.glyphs.forEach((glyph) => {
      const size = Math.round(glyph.size * 100) / 100;
      sizeVotes.set(size, (sizeVotes.get(size) || 0) + 1);
    });
    line.size = [...sizeVotes.entries()].sort((l, c) => c[1] - l[1])[0][0];
    const styleVotes = new Map();
    line.glyphs.forEach((glyph) => {
      if (isSpaceChar(glyph.uni) || !glyph.uni) return;
      const key =
        (glyph.fam ? glyph.fam.key : glyph.font.baseFont) +
        '|' +
        glyph.fill.map((h) => h.toFixed(2)).join(',');
      styleVotes.set(key, (styleVotes.get(key) || 0) + 1);
    });
    line.style = styleVotes.size ? [...styleVotes.entries()].sort((l, c) => c[1] - l[1])[0][0] : '';
    line.top = Math.max(...line.glyphs.map((glyph) => glyph.y + glyph.asc * glyph.size));
    line.bottom = Math.min(...line.glyphs.map((glyph) => glyph.y + glyph.desc * glyph.size));
    line.items = [];
    let prev = null;
    for (const glyph of line.glyphs) {
      if (prev && !isSpaceChar(prev.uni) && !isSpaceChar(glyph.uni) && glyph.x - prev.ex > 0.18 * glyph.size)
        line.items.push({
          virtual: true,
          uni: ' ',
          x: prev.ex,
          ex: glyph.x,
          size: glyph.size,
          font: glyph.font,
          fill: glyph.fill,
        });
      line.items.push(glyph);
      prev = glyph;
    }
    line.text = line.items.map((item) => item.uni).join('');
  }
  lines.sort((n, a) => a.y - n.y || n.x0 - a.x0);
  return lines;
}

const overlapLength = (a0, a1, b0, b1) => Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));

/** Höchstzahl der zuletzt angelegten Blöcke, die für eine neue Zeile geprüft werden. */
const MAX_MERGE_CANDIDATES = 3000;

export function buildTextBlocks(lines) {
  const blocks = [];
  for (const line of lines) {
    if (!line.text.trim()) continue;
    let best = null;
    // Nur die zuletzt angelegten Blöcke kommen als Fortsetzung in Frage: Echte Seiten haben weit
    // weniger Blöcke (das Ergebnis bleibt dort unverändert), bei absichtlich vermüllten Seiten
    // (tausende Textstücke an derselben Stelle) bleibt der Aufwand so begrenzt statt quadratisch.
    for (let b = Math.max(0, blocks.length - MAX_MERGE_CANDIDATES); b < blocks.length; b++) {
      const block = blocks[b];
      const last = block.lines[block.lines.length - 1];
      const gap = last.y - line.y;
      if (gap <= 0.4 * line.size) continue;
      const ratio = line.size / block.size;
      if (
        ratio < 0.8 ||
        ratio > 1.25 ||
        (last.style &&
          line.style &&
          last.style !== line.style &&
          (last.glyphs.length < 12 ||
            (block.lines.length === 1 && last.style.split('|')[0] !== line.style.split('|')[0])))
      )
        continue;
      const maxGap = block.lines.length > 1 ? block.pitch * 1.18 : 1.75 * Math.max(line.size, block.size);
      if (gap > maxGap || (block.lines.length > 1 && Math.abs(gap - block.pitch) > 0.2 * block.pitch))
        continue;
      const overlap = overlapLength(block.x0, block.x1, line.x0, line.ex);
      const minWidth = Math.min(block.x1 - block.x0, line.ex - line.x0);
      if (Math.abs(line.x0 - block.x0) < 1.2 * line.size || overlap > 0.6 * minWidth) {
        if (!(line.x0 > block.x1 + 0.5 * line.size || line.ex < block.x0 - 0.5 * line.size)) {
          if (!best || gap < best.d) best = { B: block, d: gap };
        }
      }
    }
    if (best) {
      const block = best.B;
      const last = block.lines[block.lines.length - 1];
      if (block.lines.length === 1) block.pitch = last.y - line.y;
      block.lines.push(line);
      block.x0 = Math.min(block.x0, line.x0);
      block.x1 = Math.max(block.x1, line.ex);
    } else blocks.push({ lines: [line], x0: line.x0, x1: line.ex, size: line.size, pitch: 0 });
  }
  for (const block of blocks) finalizeBlock(block);
  return blocks;
}

function hasJustifiedRightEdge(rightEdges, tolerance) {
  const sorted = rightEdges
    .slice(0, -1)
    .slice()
    .sort((a, A) => a - A);
  const median = sorted[Math.floor(sorted.length / 2)];
  return (
    sorted.filter((a) => Math.abs(a - median) < tolerance * 0.5).length >=
      Math.max(3, Math.ceil(sorted.length * 0.66)) &&
    rightEdges[rightEdges.length - 1] < median - 3 * tolerance
  );
}

function finalizeBlock(block) {
  const lines = block.lines;
  block.top = Math.max(...lines.map((s) => s.top));
  block.bottom = Math.min(...lines.map((s) => s.bottom));
  block.x0 = Math.min(...lines.map((s) => s.x0));
  block.x1 = Math.max(...lines.map((s) => s.ex));
  block.bbox = [block.x0, block.bottom, block.x1, block.top];
  block.glyphs = lines.flatMap((s) => s.glyphs);
  block.text = lines.map((s) => s.text).join('\n');
  if (!block.pitch)
    block.pitch =
      lines.length > 1 ? (lines[0].y - lines[lines.length - 1].y) / (lines.length - 1) : lines[0].size * 1.2;
  const lefts = lines.map((s) => s.x0);
  const rights = lines.map((s) => s.ex);
  const centers = lines.map((s) => (s.x0 + s.ex) / 2);
  const spread = (values) => Math.max(...values) - Math.min(...values);
  const tolerance = Math.max(1, block.size * 0.15);
  if (
    lines.length > 1 &&
    spread(lefts) > tolerance &&
    spread(rights) > tolerance &&
    spread(centers) < tolerance
  )
    block.align = 'center';
  else if (lines.length > 1 && spread(lefts) > tolerance && spread(rights) < tolerance) block.align = 'right';
  else if (
    lines.length > 2 &&
    spread(lefts.slice(1)) < tolerance &&
    lefts[0] >= Math.min(...lefts) - tolerance &&
    hasJustifiedRightEdge(rights, tolerance)
  )
    block.align = 'justify';
  else block.align = 'left';
  block.editable =
    lines.every((s) => s.up) &&
    block.glyphs.every((glyph) => glyph.uni && !glyph.font.unsupported && !glyph.font.isType3);
  block.why = lines.every((s) => s.up)
    ? block.glyphs.some((glyph) => !glyph.uni)
      ? 'ohne Zeichenzuordnung'
      : block.glyphs.some((glyph) => glyph.font.unsupported)
        ? 'Schriftcodierung'
        : block.glyphs.some((glyph) => glyph.font.isType3)
          ? 'Type3-Schrift'
          : ''
    : 'gedreht';
  return block;
}

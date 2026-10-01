/**
 * Inline-Texteditor (contentEditable) für einen Textblock und Rückumwandlung in PDF-Textsegmente.
 */
import { LIGATURES } from '../pdf/pdf-objects.js';
import { SnapGuides } from './snap-guides.js';

const SOFT_HYPHEN = '\xAD';

const CONJUNCTION_RE = /^(und|oder|bzw\.?|sowie|bis|als|and|or|to|nor)\b/i;

const isLetter = (ch) => new RegExp('\\p{L}', 'u').test(ch);

const isLowercase = (ch) => new RegExp('\\p{Ll}', 'u').test(ch);

const cssRgb = (rgb) =>
  `rgb(${Math.round(rgb[0] * 255)},${Math.round(rgb[1] * 255)},${Math.round(rgb[2] * 255)})`;

const parseCssColor = (css) => {
  const match = (css || '').match(/rgba?\(([^)]+)\)/);
  if (!match) return { c: [0, 0, 0], a: 1 };
  const parts = match[1].split(',').map((i) => parseFloat(i));
  return { c: [parts[0] / 255, parts[1] / 255, parts[2] / 255], a: parts.length > 3 ? parts[3] : 1 };
};

const roundTo = (value, factor = 1000) => Math.round(value * factor) / factor;

export class TextEditor {
  constructor(app, pv, block, opts = {}) {
    this.app = app;
    this.pv = pv;
    this.block = block;
    this.opts = opts;
    this.fonts = app.session.fonts;
    this.s = pv.scale;
    this.offset = [0, 0];
    this.origLines = [];
    this.probeCache = new Map();
  }
  get session() {
    return this.app.session;
  }
  adv(fam, ch, size) {
    return (this.fonts.adv(fam, ch) / 1000) * size;
  }
  width(fam, text, size) {
    let sum = 0;
    for (const ch of text) sum += this.adv(fam, ch, size);
    return sum;
  }
  async open(clickPoint) {
    const block = this.block;
    const pv = this.pv;
    const scale = this.s;
    const families = new Set();
    if (block) block.glyphs.forEach((glyph) => families.add(glyph.fam));
    else families.add(this.opts.fam);
    for (const fam of families) await this.fonts.ensureCss(fam);
    const frame = (this.frame = document.createElement('div'));
    frame.className = 'te-frame';
    const te = (this.te = document.createElement('div'));
    te.className = 'te';
    te.contentEditable = 'true';
    te.spellcheck = false;
    te.setAttribute('role', 'textbox');
    te.setAttribute('aria-multiline', 'true');
    frame.appendChild(te);
    const widthHandle = document.createElement('div');
    widthHandle.className = 'wh';
    widthHandle.title = 'Breite ändern';
    frame.appendChild(widthHandle);
    const moveGrip = document.createElement('div');
    moveGrip.className = 'mvg';
    moveGrip.title = 'Textfeld verschieben';
    moveGrip.innerHTML =
      '<svg viewBox="0 0 12 12" width="12" height="12"><g fill="currentColor"><circle cx="4" cy="3" r="1"/><circle cx="8" cy="3" r="1"/><circle cx="4" cy="6" r="1"/><circle cx="8" cy="6" r="1"/><circle cx="4" cy="9" r="1"/><circle cx="8" cy="9" r="1"/></g></svg>';
    frame.appendChild(moveGrip);
    this.mvGrip = moveGrip;
    pv.layer.appendChild(frame);
    if (block) this.buildFromBlock(block);
    else this.buildEmpty();
    this.calibrate();
    this.wire(widthHandle);
    te.focus();
    if (clickPoint) {
      const caret =
        (block && this.caretFromPdf(...this.pv.clientToPdf(clickPoint[0], clickPoint[1]))) ||
        this.caretAt(clickPoint[0], clickPoint[1]);
      if (caret) {
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(caret);
      } else this.caretToEnd();
    } else if (block) {
      const range = document.createRange();
      range.selectNodeContents(te);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    } else this.caretToEnd();
    this.checkMissing();
  }
  caretAt(clientX, clientY) {
    const te = this.te;
    const rect = te.getBoundingClientRect();
    const x = Math.min(Math.max(clientX, rect.left + 1), rect.right - 1);
    const y = Math.min(Math.max(clientY, rect.top + 1), rect.bottom - 1);
    const caret = document.caretRangeFromPoint ? document.caretRangeFromPoint(x, y) : null;
    if (!caret || !te.contains(caret.startContainer)) return null;
    const node = caret.startContainer;
    const offset = caret.startOffset;
    if (node.nodeType === 3 && offset > 0 && /\s/.test(node.textContent[offset - 1])) {
      const nextRange = document.createRange();
      let nextRect = null;
      if (offset < node.textContent.length) {
        nextRange.setStart(node, offset);
        nextRange.setEnd(node, offset + 1);
        nextRect = nextRange.getBoundingClientRect();
      }
      const prevRange = document.createRange();
      prevRange.setStart(node, offset - 1);
      prevRange.setEnd(node, offset);
      const prevRect = prevRange.getBoundingClientRect();
      if (
        nextRect &&
        nextRect.height &&
        prevRect.height &&
        nextRect.top > prevRect.top + prevRect.height * 0.5 &&
        clientY < nextRect.top
      ) {
        caret.setStart(node, offset - 1);
        caret.collapse(true);
      }
    }
    return caret;
  }
  caretFromPdf(x, y) {
    const charLines = this.charLines;
    if (!charLines || !charLines.length) return null;
    let nearest = null;
    for (const line of charLines) {
      const dist =
        y < line.y - 0.35 * line.size
          ? line.y - 0.35 * line.size - y
          : y > line.y + 1 * line.size
            ? y - line.y - line.size
            : 0;
      if (!nearest || dist < nearest.d) nearest = { l: line, d: dist };
    }
    if (!nearest || nearest.d > 1.5 * nearest.l.size) return null;
    const chars = nearest.l.chars.filter((ch) => ch.p);
    if (!chars.length) return null;
    let target = null;
    let after = false;
    for (const ch of chars) {
      const adv = this.adv(ch.fam, ch.ch, ch.size);
      if (x < ch.x + adv / 2) {
        target = ch;
        break;
      }
    }
    if (!target) {
      target = chars[chars.length - 1];
      after = true;
    }
    const offset = target.off + (after ? target.ch.length : 0);
    const walker = document.createTreeWalker(target.p, NodeFilter.SHOW_TEXT);
    let pos = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const len = node.textContent.length;
      if (offset <= pos + len) {
        const range = document.createRange();
        range.setStart(node, offset - pos);
        range.collapse(true);
        return range;
      }
      pos += len;
    }
    return null;
  }
  fixLineEndCaret() {
    const selection = getSelection();
    if (!selection.rangeCount || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    const offset = range.startOffset;
    if (
      node.nodeType !== 3 ||
      !this.te.contains(node) ||
      offset === 0 ||
      !/\s/.test(node.textContent[offset - 1]) ||
      offset >= node.textContent.length
    )
      return;
    const nextRange = document.createRange();
    nextRange.setStart(node, offset);
    nextRange.setEnd(node, offset + 1);
    const nextRect = nextRange.getBoundingClientRect();
    const prevRange = document.createRange();
    prevRange.setStart(node, offset - 1);
    prevRange.setEnd(node, offset);
    const prevRect = prevRange.getBoundingClientRect();
    if (nextRect.height && prevRect.height && nextRect.top > prevRect.top + prevRect.height * 0.5) {
      const caret = document.createRange();
      caret.setStart(node, offset - 1);
      caret.collapse(true);
      selection.removeAllRanges();
      selection.addRange(caret);
    }
  }
  isWrapSpace(selection) {
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    const end = range.cloneRange();
    end.collapse(false);
    const node = end.startContainer;
    const offset = end.startOffset;
    let nextRange = null;
    if (node.nodeType === 3 && offset < node.textContent.length) {
      nextRange = document.createRange();
      nextRange.setStart(node, offset);
      nextRange.setEnd(node, offset + 1);
    } else {
      const walker = document.createTreeWalker(this.te, NodeFilter.SHOW_TEXT);
      walker.currentNode = (node.nodeType === 3, node);
      let next = walker.nextNode();
      while (next && !next.textContent.length) next = walker.nextNode();
      if (
        next &&
        next.parentElement.closest('p') === (node.nodeType === 3 ? node.parentElement : node).closest('p')
      ) {
        nextRange = document.createRange();
        nextRange.setStart(next, 0);
        nextRange.setEnd(next, 1);
      }
    }
    if (!nextRange) return false;
    const nextRect = nextRange.getBoundingClientRect();
    return nextRect.height > 0 && rect.height > 0 && nextRect.top > rect.top + rect.height * 0.5;
  }
  caretToEnd() {
    const range = document.createRange();
    range.selectNodeContents(this.te);
    range.collapse(false);
    const selection = getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
  spanFor(fam, size, color, alpha, rise) {
    const span = document.createElement('span');
    span.style.fontFamily = this.fonts.cssStack(fam);
    span.style.fontSize = roundTo(size * this.s, 10000) + 'px';
    const opacity = alpha ?? 1;
    span.style.color =
      opacity < 1
        ? `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${opacity})`
        : cssRgb(color);
    if (fam.weight) span.style.fontWeight = fam.weight;
    span.style.lineHeight = '0';
    if (rise) span.style.verticalAlign = roundTo(rise * this.s, 100) + 'px';
    span.dataset.fam = fam.key;
    span.dataset.size = String(size);
    span.dataset.color = color.join(',');
    return span;
  }
  buildEmpty() {
    const opts = this.opts;
    const scale = this.s;
    const availWidth =
      this.availRight(
        [opts.point[0], opts.point[1] - opts.size * 0.3, opts.point[0], opts.point[1] + opts.size],
        opts.size,
      ) - opts.point[0];
    if (availWidth > opts.size * 4) {
      this.mode = 'wrap';
      this.te.style.width = roundTo(availWidth * scale, 100) + 'px';
    } else {
      this.mode = 'nowrap';
      this.te.classList.add('nowrap');
    }
    const para = document.createElement('p');
    para.style.lineHeight = roundTo(opts.size * 1.25 * scale, 100) + 'px';
    const span = this.spanFor(opts.fam, opts.size, opts.color || [0, 0, 0], 1, 0);
    span.appendChild(document.createElement('br'));
    para.appendChild(span);
    this.te.appendChild(para);
    const [left, top] = this.pv.pdfToLayer(opts.point[0], opts.point[1]);
    this.frame.style.left = left + 'px';
    this.frame.style.top = top - opts.size * 0.95 * scale + 'px';
    this.targets = [{ p: para, y: opts.point[1] }];
    this.left0 = opts.point[0];
  }
  buildFromBlock(block) {
    const scale = this.s;
    const lines = block.lines;
    const info = this.pv.info;
    this.anchors = new Map();
    const anchorByGlyph = new Map();
    try {
      const model = this.session.model(this.pv.index);
      const glyphBox = (glyph) => [
        Math.min(glyph.x, glyph.ex),
        glyph.y + glyph.desc * glyph.size,
        Math.max(glyph.x, glyph.ex),
        glyph.y + glyph.asc * glyph.size,
      ];
      const overlapArea = (a, b) =>
        Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) *
        Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
      const glyphs = block.glyphs.filter((glyph) => glyph.uni && glyph.uni.trim());
      for (const obj of model.objects) {
        if (!obj.selectable || obj.type === 'image') continue;
        const vis = obj.vis;
        const objW = vis[2] - vis[0];
        const objH = vis[3] - vis[1];
        if (objH > 2.4 * block.size || objW > 14 * block.size) continue;
        let bestGlyph = null;
        let bestArea = 0;
        for (const glyph of glyphs) {
          const area = overlapArea(vis, glyphBox(glyph));
          if (area > bestArea) {
            bestArea = area;
            bestGlyph = glyph;
          }
        }
        if (
          !bestGlyph ||
          bestArea < 0.15 * Math.min(objW * objH, (bestGlyph.ex - bestGlyph.x) * bestGlyph.size)
        )
          continue;
        let anchorId = anchorByGlyph.get(bestGlyph);
        if (!anchorId) {
          anchorId = 'a' + (this.anchors.size + 1);
          anchorByGlyph.set(bestGlyph, anchorId);
          this.anchors.set(anchorId, { x: bestGlyph.x, y: bestGlyph.y, objs: [] });
        }
        this.anchors.get(anchorId).objs.push({ type: obj.type, vis: obj.vis.slice() });
      }
    } catch (err) {
      console.warn(err);
    }
    const charLines = lines.map((line) => {
      const chars = [];
      let lastReal = null;
      for (const item of line.items) {
        const src = item.virtual ? lastReal : item;
        if (!src) continue;
        let parts = [...item.uni];
        const ligature = LIGATURES[item.uni];
        if (
          ligature &&
          parts.some((O) => this.fonts.charWriter(src.fam, O).kind === 'fallback') &&
          this.fonts.charWriter(src.fam, String.fromCodePoint(ligature)).kind !== 'fallback'
        )
          parts = [String.fromCodePoint(ligature)];
        const anchor = item.virtual ? null : anchorByGlyph.get(item) || null;
        parts.forEach((O, K) =>
          chars.push({
            ch: O,
            x: K ? null : item.x,
            fam: src.fam,
            size: src.size,
            color: src.fill,
            alpha: src.alpha,
            rise: roundTo(src.y - line.y, 100),
            anchor: K ? null : anchor,
          }),
        );
        if (!item.virtual) lastReal = item;
      }
      for (let k = 0; k < chars.length; k++)
        if (chars[k].x == null)
          chars[k].x = chars[k - 1].x + this.adv(chars[k - 1].fam, chars[k - 1].ch, chars[k - 1].size);
      for (let k = 0; k < chars.length; k++)
        chars[k].gap =
          k + 1 < chars.length
            ? chars[k + 1].x - chars[k].x - this.adv(chars[k].fam, chars[k].ch, chars[k].size)
            : 0;
      const styleKey = (R) => [R.fam.key, R.size, R.color.join(',')].join('|');
      for (let start = 0; start < chars.length;) {
        let end = start;
        while (end + 1 < chars.length && styleKey(chars[end + 1]) === styleKey(chars[start])) end++;
        const charGaps = [];
        for (let k = start; k < end; k++)
          if (chars[k].ch.trim() && chars[k + 1].ch.trim()) charGaps.push(chars[k].gap);
        charGaps.sort((K, _) => K - _);
        const median = charGaps.length >= 3 ? charGaps[Math.floor(charGaps.length / 2)] : 0;
        const mean = charGaps.length >= 6 ? charGaps.reduce((K, _) => K + _, 0) / charGaps.length : 0;
        const letterSpacing =
          Math.abs(median) > 0.04 * chars[start].size
            ? roundTo(median, 1000)
            : Math.abs(mean) > 0.004 * chars[start].size && Math.abs(mean) < 0.05 * chars[start].size
              ? roundTo(mean, 1000)
              : 0;
        for (let k = start; k <= end; k++) chars[k].ls = letterSpacing;
        start = end + 1;
      }
      chars.forEach((ch, k) => {
        if (!ch.anchor) return;
        const gapBefore = k > 0 ? chars[k - 1].gap - chars[k - 1].ls : 0;
        const gapAfter = ch.gap - ch.ls;
        if (gapBefore > 0.3) ch.pl = roundTo(gapBefore, 1000);
        if (gapAfter > 0.3 && k + 1 < chars.length) ch.pr = roundTo(gapAfter, 1000);
      });
      return {
        ln: line,
        chars,
        text: chars.map((R) => R.ch).join(''),
        x0: line.x0,
        y: line.y,
        size: line.size,
      };
    });
    this.origLines = charLines.map((F) => ({ y: F.y, chars: F.chars }));
    this.charLines = charLines;
    const left = block.x0;
    const right = block.x1;
    const lineWidth = (line) =>
      line.chars.reduce(
        (G, x) => G + this.adv(x.fam, x.ch, x.size) + (x.ls || 0) + (x.pl || 0) + (x.pr || 0),
        0,
      );
    const lineEnds = charLines.map((F) => F.chars[0].x + lineWidth(F));
    let width = Math.max(right, ...lineEnds) - left + 0.3;
    if (block.align === 'justify' && lines.length > 2) {
      const ends = lines
        .slice(0, -1)
        .map((x) => x.ex)
        .sort((x, P) => x - P);
      const medianEnd = ends[Math.floor(ends.length / 2)];
      width =
        Math.max(
          medianEnd - left,
          ...lineEnds.filter((x, P) => lines[P].ex <= medianEnd + 0.5).map((x) => x - left),
        ) + 0.3;
    }
    const gaps = charLines
      .slice(1)
      .map((F, G) => charLines[G].y - F.y)
      .sort((F, G) => F - G);
    const pitch = gaps.length ? gaps[Math.floor(gaps.length / 2)] : block.pitch;
    const joins = [];
    const joinedEnds = [];
    for (let k = 0; k < charLines.length - 1; k++) {
      const line = charLines[k];
      const next = charLines[k + 1];
      const gap = line.y - next.y;
      const regularPitch = charLines.length > 1 && Math.abs(gap - pitch) < 0.12 * pitch;
      const sameSize = Math.abs(next.size - line.size) < 0.15 * line.size;
      const startsList =
        /^\s*([•·▪■●◦\-–—*]|\d{1,3}[.)]|[a-z][.)])\s/.test(next.text) ||
        /^\s/.test(next.text) ||
        next.chars[0].fam.mono ||
        line.chars[0].fam.mono;
      const hyphenated =
        /[-‐]$/.test(line.text) && line.text.length > 1 && isLetter(line.text[line.text.length - 2]);
      const nextWord = next.text.trimStart().split(/\s+/)[0] || '';
      const spaceWidth = this.adv(line.chars[line.chars.length - 1].fam, ' ', line.size);
      const nextWordLen = [...nextWord].length;
      const nextWordWidth = next.chars
        .slice(
          next.chars.findIndex((ch) => ch.ch.trim()),
          undefined,
        )
        .slice(0, nextWordLen)
        .reduce(
          (ke, we) => ke + this.adv(we.fam, we.ch, we.size) + (we.ls || 0) + (we.pl || 0) + (we.pr || 0),
          0,
        );
      const lineEnd = lineEnds[k] - left;
      const fits = lineEnd + (hyphenated ? 0 : spaceWidth) + nextWordWidth <= width - 0.3;
      const sameStyle = !line.ln.style || !next.ln.style || line.ln.style === next.ln.style;
      let join =
        regularPitch &&
        sameSize &&
        sameStyle &&
        !startsList &&
        (block.align === 'justify' ||
          block.align === 'left' ||
          block.align === 'center' ||
          block.align === 'right');
      if (join && !hyphenated && fits) join = false;
      if (join && !hyphenated) joinedEnds.push(lineEnd + spaceWidth + nextWordWidth);
      joins.push(
        join
          ? hyphenated
            ? isLowercase(nextWord[0] || '') && !CONJUNCTION_RE.test(nextWord)
              ? 'hyph'
              : CONJUNCTION_RE.test(nextWord)
                ? 'space'
                : 'join'
            : 'space'
          : null,
      );
    }
    if (joinedEnds.length) {
      const minWidth = Math.max(...lineEnds) - left + 0.02;
      const minJoined = Math.min(...joinedEnds) - 0.05;
      if (minJoined < width) width = Math.max(minWidth, minJoined);
    }
    const displayOk = [...new Set(block.glyphs.map((glyph) => glyph.fam))].every((F) => F.displayOk);
    if (!displayOk) joins.fill(null);
    this.approx = !displayOk;
    const anyJoin = joins.some(Boolean);
    const countChar = (ch) => [...block.text].filter((G) => G === ch).length;
    const spaceChar = countChar('\u2002') > countChar(' ') ? '\u2002' : ' ';
    if (displayOk && !anyJoin && (block.align === 'left' || block.align === 'justify')) {
      const avail = this.availRight(block.bbox, block.size) - left;
      if (avail > width) width = avail;
    }
    this.mode =
      displayOk && (anyJoin || block.align === 'left' || block.align === 'justify') ? 'wrap' : 'nowrap';
    if (this.mode === 'nowrap') this.te.classList.add('nowrap');
    const groups = [];
    let currentGroup = null;
    charLines.forEach((F, G) => {
      if (!currentGroup || !joins[G - 1]) {
        currentGroup = { lines: [F], joins: [] };
        groups.push(currentGroup);
      } else {
        currentGroup.lines.push(F);
        currentGroup.joins.push(joins[G - 1]);
      }
    });
    const align = block.align;
    this.targets = [];
    for (const group of groups) {
      const paraEl = document.createElement('p');
      const first = group.lines[0];
      const lineHeight =
        group.lines.length > 1
          ? (first.y - group.lines[group.lines.length - 1].y) / (group.lines.length - 1)
          : first.size * 1.2;
      paraEl.style.lineHeight = roundTo(lineHeight * scale, 100) + 'px';
      if (this.mode === 'wrap') {
        paraEl.style.textAlign = align === 'justify' ? 'justify' : align;
        if (align === 'left' || align === 'justify') {
          const firstIndent = Math.max(0, first.chars[0].x - left);
          const restIndent =
            group.lines.length > 1
              ? Math.max(0, Math.min(...group.lines.slice(1).map((K) => K.chars[0].x)) - left)
              : firstIndent;
          paraEl.style.paddingLeft = roundTo(restIndent * scale, 100) + 'px';
          paraEl.style.textIndent = roundTo((firstIndent - restIndent) * scale, 100) + 'px';
        }
      } else if (align === 'center' || align === 'right') paraEl.style.textAlign = align;
      else paraEl.style.paddingLeft = roundTo(Math.max(0, first.chars[0].x - left) * scale, 100) + 'px';
      let span = null;
      let spanKey = null;
      let offset = 0;
      const append = (ch, text) => {
        if (text == null || text === SOFT_HYPHEN) {
          ch.p = paraEl;
          ch.off = offset;
        }
        offset += (text ?? ch.ch).length;
        const key = [
          ch.fam.key,
          ch.size,
          ch.color.join(','),
          ch.alpha,
          ch.rise,
          ch.anchor || '',
          ch.ls || 0,
        ].join('|');
        if (key !== spanKey || ch.anchor) {
          span = this.spanFor(ch.fam, ch.size, ch.color, ch.alpha, ch.rise);
          if (ch.anchor) span.dataset.anchor = ch.anchor;
          if (ch.ls) {
            span.style.letterSpacing = roundTo(ch.ls * this.s, 1000) + 'px';
            span.dataset.ls = String(ch.ls);
          }
          if (ch.pl) {
            span.style.paddingLeft = roundTo(ch.pl * this.s, 1000) + 'px';
            span.dataset.pl = String(ch.pl);
          }
          if (ch.pr) {
            span.style.paddingRight = roundTo(ch.pr * this.s, 1000) + 'px';
            span.dataset.pr = String(ch.pr);
          }
          paraEl.appendChild(span);
          spanKey = ch.anchor ? '#' : key;
        }
        span.appendChild(document.createTextNode(text ?? ch.ch));
      };
      group.lines.forEach((line, k) => {
        let chars = line.chars;
        if (k > 0) {
          const join = group.joins[k - 1];
          const prevLast = group.lines[k - 1].chars[group.lines[k - 1].chars.length - 1];
          if (join === 'space' && !/\s/.test(prevLast.ch) && !/^\s/.test(line.text))
            append({ ...prevLast, rise: 0, anchor: null, pl: 0, pr: 0 }, spaceChar);
        }
        if (k < group.lines.length - 1 && group.joins[k] === 'hyph') {
          chars = chars.slice(0, -1);
          chars.forEach((_) => append(_));
          append({ ...line.chars[line.chars.length - 1] }, SOFT_HYPHEN);
          return;
        }
        chars.forEach((_) => append(_));
      });
      paraEl.normalize();
      this.te.appendChild(paraEl);
      this.targets.push({ p: paraEl, y: first.y });
    }
    const [frameLeft] = this.pv.pdfToLayer(left, 0);
    const [, frameTop] = this.pv.pdfToLayer(0, block.bbox[3]);
    this.frame.style.left = frameLeft + 'px';
    this.frame.style.top = frameTop + 'px';
    if (this.mode === 'wrap' || align === 'center' || align === 'right')
      this.te.style.width = roundTo(width * scale, 100) + 'px';
    else this.te.style.minWidth = roundTo((right - left) * scale, 100) + 'px';
    this.left0 = left;
    this.W = width;
  }
  availRight(bbox, size) {
    const model = this.session.model(this.pv.index);
    const info = this.pv.info;
    const ownBox = this.block && this.block.bbox;
    const others = model.blocks.filter(
      (block) => !ownBox || !block.bbox.every((u, f) => Math.abs(u - ownBox[f]) < 0.5),
    );
    const leftMargin = Math.max(18, Math.min(bbox[0], ...others.map((h) => h.bbox[0])) - info.x);
    let right = Math.max(bbox[2], ...others.map((h) => h.bbox[2]), info.x + info.w - leftMargin);
    const top = bbox[3];
    const bottom = bbox[1] - 2 * size;
    for (const other of others)
      if (other.bbox[0] >= bbox[2] - 0.5 && other.bbox[1] < top && other.bbox[3] > bottom)
        right = Math.min(right, other.bbox[0] - Math.max(6, size));
    return Math.max(right, bbox[2]);
  }
  calibrate() {
    const teRect = () => this.pv.clientToLayerRect(this.te.getBoundingClientRect());
    let firstTop = null;
    for (const target of this.targets) {
      const [, wantY] = this.pv.pdfToLayer(0, target.y);
      const baseline = this.baselineOf(target.p);
      if (baseline == null) continue;
      const marginTop = parseFloat(target.p.style.marginTop || '0');
      target.p.style.marginTop = roundTo(marginTop + (wantY - baseline), 100) + 'px';
      if (firstTop == null) firstTop = teRect()[1];
    }
  }
  baselineOf(para) {
    const marker = document.createElement('i');
    marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    para.insertBefore(marker, para.firstChild);
    const y = this.pv.clientToLayerRect(marker.getBoundingClientRect())[1];
    marker.remove();
    return y;
  }
  wire(widthHandle) {
    const te = this.te;
    const frame = this.frame;
    te.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        ev.stopPropagation();
        if (this.app.edit && this.app.edit.escapeEdit) this.app.edit.escapeEdit();
        else this.app.finishEdit();
        return;
      }
      if (
        (ev.ctrlKey || ev.metaKey) &&
        (ev.key.toLowerCase() === 'y' || (ev.key.toLowerCase() === 'z' && ev.shiftKey))
      ) {
        ev.preventDefault();
        ev.stopPropagation();
        document.execCommand('redo');
        return;
      }
      if (ev.key === 'Tab') {
        ev.preventDefault();
        document.execCommand('insertText', false, '    ');
        return;
      }
      if (ev.key === 'End' && !ev.shiftKey && !ev.ctrlKey && !ev.metaKey) {
        ev.preventDefault();
        ev.stopPropagation();
        const selection = getSelection();
        try {
          selection.collapseToEnd();
          selection.modify('move', 'forward', 'lineboundary');
          selection.modify('extend', 'backward', 'character');
          const selected = selection.toString();
          if (
            selected &&
            /^[ \u00a0\u2002]$/.test(selected) &&
            selection.focusNode &&
            this.isWrapSpace(selection)
          )
            selection.collapseToStart();
          else selection.collapseToEnd();
        } catch {}
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'y') {
        ev.preventDefault();
        ev.stopPropagation();
        document.execCommand('redo');
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ['+', '=', '-', '0'].includes(ev.key)) {
        ev.preventDefault();
        ev.stopPropagation();
        this.app.toast('Zum Zoomen die Textbearbeitung mit Esc beenden.');
        return;
      }
      if ((ev.ctrlKey || ev.metaKey) && ['b', 'i', 'u'].includes(ev.key.toLowerCase())) {
        ev.preventDefault();
        if (ev.key.toLowerCase() === 'b') this.app.toggleBold();
        return;
      }
      if (ev.key === 'Enter' && this.mode === 'nowrap') ev.shiftKey;
      ev.stopPropagation();
    });
    te.addEventListener('paste', (ev) => {
      ev.preventDefault();
      const text = (ev.clipboardData.getData('text/plain') || '')
        .replace(/\r\n?/g, '\n')
        .replace(/\t/g, '    ');
      document.execCommand('insertText', false, text);
    });
    te.addEventListener('drop', (ev) => ev.preventDefault());
    te.addEventListener('input', () => {
      this.dirty = true;
      this.cleanup();
      this.checkMissing();
      this.app.onEditorSelection();
    });
    document.addEventListener(
      'selectionchange',
      (this._sel = () => {
        const selection = getSelection();
        if (selection.rangeCount && te.contains(selection.anchorNode)) {
          this.lastRange = selection.getRangeAt(0).cloneRange();
          this.app.onEditorSelection();
        }
      }),
    );
    frame.addEventListener('pointerdown', (ev) => {
      if (ev.target === widthHandle) return this.dragWidth(ev);
      if (ev.target !== frame && !this.mvGrip.contains(ev.target)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const clientX = ev.clientX;
      const clientY = ev.clientY;
      const startLeft = parseFloat(frame.style.left);
      const startTop = parseFloat(frame.style.top);
      const startOffset = this.offset.slice();
      frame.setPointerCapture(ev.pointerId);
      let guides = null;
      let boxTopOffset = 0;
      let boxHeight = te.offsetHeight;
      try {
        const block = this.block;
        guides = new SnapGuides(
          this.pv,
          this.app.session.model(this.pv.index),
          (C) => !!block && C === block,
        );
        if (block) {
          const box = this.pv.boxOf(block.bbox);
          const frameLeft = startLeft - this.offset[0] * this.s;
          const frameTop = startTop + this.offset[1] * this.s;
          boxTopOffset = box.top - frameTop;
          boxHeight = box.height;
        }
      } catch {
        guides = null;
      }
      const onMove = (moveEv) => {
        let [dx, dy] = this.pv.clientDeltaToLayer(moveEv.clientX - clientX, moveEv.clientY - clientY);
        if (guides)
          if (moveEv.altKey) guides.clear();
          else {
            const snap = guides.snap({
              left: startLeft + dx,
              top: startTop + dy + boxTopOffset,
              width: te.offsetWidth,
              height: boxHeight,
            });
            dx += snap.dx;
            dy += snap.dy;
            guides.show(snap.lines);
          }
        frame.style.left = startLeft + dx + 'px';
        frame.style.top = startTop + dy + 'px';
        this.offset = [startOffset[0] + dx / this.s, startOffset[1] - dy / this.s];
        this.dirty = true;
      };
      const onUp = () => {
        frame.removeEventListener('pointermove', onMove);
        frame.removeEventListener('pointerup', onUp);
        if (guides) guides.clear();
        te.focus();
      };
      frame.addEventListener('pointermove', onMove);
      frame.addEventListener('pointerup', onUp);
    });
  }
  dragWidth(ev) {
    ev.preventDefault();
    ev.stopPropagation();
    const te = this.te;
    const clientX = ev.clientX;
    const clientY = ev.clientY;
    const width = te.getBoundingClientRect().width;
    const startWidth =
      this.pv.clientDeltaToLayer(width, 0)[0] || parseFloat(te.style.width) || te.offsetWidth;
    const target = ev.target;
    target.setPointerCapture(ev.pointerId);
    const margins = this.targets.map((target2) => target2.p.style.marginTop);
    const onMove = (moveEv) => {
      const [dx] = this.pv.clientDeltaToLayer(moveEv.clientX - clientX, moveEv.clientY - clientY);
      if (this.mode !== 'wrap') {
        this.mode = 'wrap';
        te.classList.remove('nowrap');
      }
      te.style.minWidth = '';
      te.style.width = Math.max(12, (te.offsetWidth, startWidth + dx)) + 'px';
      this.dirty = true;
    };
    const onUp = () => {
      target.removeEventListener('pointermove', onMove);
      target.removeEventListener('pointerup', onUp);
      te.focus();
    };
    target.addEventListener('pointermove', onMove);
    target.addEventListener('pointerup', onUp);
  }
  cleanup() {
    for (const el of [...this.te.querySelectorAll('font,b,strong,i,em,u')]) {
      const span = document.createElement('span');
      for (span.style.cssText = el.style.cssText; el.firstChild;) span.appendChild(el.firstChild);
      el.replaceWith(span);
    }
    for (const el of [...this.te.querySelectorAll('div')]) {
      const para = document.createElement('p');
      for (para.style.cssText = el.style.cssText; el.firstChild;) para.appendChild(el.firstChild);
      el.replaceWith(para);
    }
    for (const node of [...this.te.childNodes])
      if (node.nodeType === 3 && node.textContent) {
        const para = document.createElement('p');
        const span = this.defaultSpan();
        node.replaceWith(para);
        span.appendChild(node);
        para.appendChild(span);
      }
  }
  defaultSpan() {
    const existing = this.te.querySelector('span[data-fam]');
    if (existing) return existing.cloneNode(false);
    const opts = this.opts;
    return this.spanFor(opts.fam, opts.size, opts.color || [0, 0, 0], 1, 0);
  }
  styleOf(node) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    if (!el || !this.te.contains(el)) return null;
    const style = getComputedStyle(el);
    const span = el.closest('span[data-fam]');
    const fam =
      this.fonts.famFromCss(style.fontFamily) ||
      (span && this.fonts.get(span.dataset.fam)) ||
      this.opts.fam ||
      (this.block && this.block.fam);
    let size = parseFloat(style.fontSize) / this.s;
    if (span && span.dataset.size && Math.abs(+span.dataset.size - size) < 0.05) size = +span.dataset.size;
    let { c: color, a: alpha } = parseCssColor(style.color);
    if (span && span.dataset.color) {
      const dataColor = span.dataset.color.split(',').map(Number);
      if (dataColor.length === 3 && dataColor.every((u, f) => Math.abs(u * 255 - color[f] * 255) < 0.6))
        color = dataColor;
    }
    const para = el.closest('p');
    const align = para
      ? getComputedStyle(para).textAlign.replace('start', 'left').replace('end', 'right')
      : 'left';
    return {
      fam,
      size: roundTo(size, 100),
      color,
      alpha,
      align,
      rise: style.verticalAlign.endsWith('px') ? parseFloat(style.verticalAlign) / this.s : 0,
    };
  }
  currentStyle() {
    if (!this.te) return null;
    const selection = getSelection();
    const range =
      selection.rangeCount && this.te.contains(selection.anchorNode)
        ? selection.getRangeAt(0)
        : this.lastRange && this.te.contains(this.lastRange.startContainer)
          ? this.lastRange
          : null;
    if (range) {
      let node = range.startContainer;
      if (node.nodeType === 1 && node.childNodes[range.startOffset])
        node = node.childNodes[range.startOffset];
      return this.styleOf(node);
    }
    return this.styleOf(this.te.querySelector('span') || this.te);
  }
  applyStyle(style) {
    const selection = getSelection();
    let range = selection.rangeCount ? selection.getRangeAt(0) : null;
    if (
      (!range || !this.te.contains(range.commonAncestorContainer)) &&
      this.lastRange &&
      this.te.contains(this.lastRange.commonAncestorContainer)
    )
      range = this.lastRange;
    if (!range || range.collapsed || !this.te.contains(range.commonAncestorContainer)) {
      range = document.createRange();
      range.selectNodeContents(this.te);
    }
    const textNodes = [];
    const walker = document.createTreeWalker(this.te, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode())
      if (range.intersectsNode(node) && node.textContent.length) textNodes.push(node);
    const targets = [];
    for (let node of textNodes) {
      let start = 0;
      let end = node.textContent.length;
      if (node === range.startContainer) start = range.startOffset;
      if (node === range.endContainer) end = range.endOffset;
      if (!(start >= end)) {
        if (end < node.textContent.length) node.splitText(end);
        if (start > 0) node = node.splitText(start);
        targets.push(node);
      }
    }
    for (const node of targets) {
      const parent = node.parentElement;
      let span;
      if (parent.tagName === 'SPAN' && parent.childNodes.length === 1) span = parent;
      else {
        const oldSpan = parent.tagName === 'SPAN' ? parent : null;
        span = oldSpan ? oldSpan.cloneNode(false) : this.defaultSpan();
        if (oldSpan) {
          const tail = oldSpan.cloneNode(false);
          let sibling = node.nextSibling;
          while (sibling) {
            const next = sibling.nextSibling;
            tail.appendChild(sibling);
            sibling = next;
          }
          oldSpan.after(span);
          if (tail.childNodes.length) span.after(tail);
          span.appendChild(node);
          if (!oldSpan.childNodes.length) oldSpan.remove();
        } else {
          node.replaceWith(span);
          span.appendChild(node);
        }
      }
      if (style.fam) {
        span.style.fontFamily = this.fonts.cssStack(style.fam);
        span.dataset.fam = style.fam.key;
        span.style.fontWeight = style.fam.weight || '';
      }
      if (style.size) {
        span.style.fontSize = roundTo(style.size * this.s, 10000) + 'px';
        span.dataset.size = String(style.size);
      }
      if (style.color) {
        span.style.color = cssRgb(style.color);
        span.dataset.color = style.color.join(',');
      }
    }
    if (style.size && range.toString() === this.te.textContent)
      for (const para of this.te.querySelectorAll('p')) {
        const lineHeight = parseFloat(para.style.lineHeight) || 0;
        const size = +(para.querySelector('span[data-size]') || {}).dataset?.size || style.size;
        if (lineHeight && style.oldSize)
          para.style.lineHeight = roundTo(lineHeight * (style.size / style.oldSize), 100) + 'px';
      }
    this.mergeSpans();
    if (targets.length) {
      const newRange = document.createRange();
      newRange.setStartBefore(targets[0]);
      newRange.setEndAfter(targets[targets.length - 1]);
      this.lastRange = newRange.cloneRange();
      if (document.activeElement === this.te) {
        selection.removeAllRanges();
        selection.addRange(newRange);
      }
    }
    this.dirty = true;
    this.checkMissing();
  }
  mergeSpans() {
    for (const para of this.te.querySelectorAll('p')) {
      let prev = null;
      for (const node of [...para.childNodes]) {
        if (
          prev &&
          node.nodeType === 1 &&
          node.tagName === 'SPAN' &&
          prev.tagName === 'SPAN' &&
          !node.dataset.anchor &&
          node.style.cssText === prev.style.cssText &&
          node.dataset.fam === prev.dataset.fam &&
          node.dataset.size === prev.dataset.size
        ) {
          while (node.firstChild) prev.appendChild(node.firstChild);
          node.remove();
          continue;
        }
        prev = node.nodeType === 1 ? node : null;
      }
      para.normalize();
    }
  }
  setAlign(align) {
    if (this.mode !== 'wrap') {
      const rect = this.te.getBoundingClientRect();
      const size = this.pv.clientDeltaToLayer(rect.width, rect.height);
      this.te.style.width = Math.abs(size[0]) > 1 ? Math.abs(size[0]) + 'px' : this.te.offsetWidth + 'px';
      this.te.style.minWidth = '';
    }
    for (const para of this.te.querySelectorAll('p')) {
      para.style.textAlign = align;
      if (align !== 'left' && align !== 'justify') para.style.textIndent = '';
    }
    this.dirty = true;
  }
  checkMissing() {
    const missing = new Map();
    const walker = document.createTreeWalker(this.te, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const style = this.styleOf(node);
      if (!(!style || !style.fam))
        for (const ch of node.textContent)
          if (!(ch === SOFT_HYPHEN || ch === '\n')) {
            if (this.fonts.charWriter(style.fam, ch).kind === 'fallback') {
              if (!missing.has(style.fam)) missing.set(style.fam, new Set());
              missing.get(style.fam).add(ch);
            }
          }
    }
    this.missing = missing;
    this.app.showMissing(this, missing);
  }
  probe(fontFamily, fontSize) {
    const key = fontFamily + '|' + fontSize;
    if (this.probeCache.has(key)) return this.probeCache.get(key);
    const div = document.createElement('div');
    div.style.cssText = 'position:fixed;left:-9999px;top:0;white-space:pre;line-height:normal';
    const span = document.createElement('span');
    span.style.fontFamily = fontFamily;
    span.style.fontSize = fontSize + 'px';
    const text = document.createTextNode('Hxgäq');
    span.appendChild(text);
    const marker = document.createElement('i');
    marker.style.cssText = 'display:inline-block;width:0;height:0;vertical-align:baseline';
    span.appendChild(marker);
    div.appendChild(span);
    document.body.appendChild(div);
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, 1);
    const height = range.getBoundingClientRect().bottom - marker.getBoundingClientRect().top;
    div.remove();
    this.probeCache.set(key, height);
    return height;
  }
  collect() {
    const te = this.te;
    const scale = this.s;
    const info = this.pv.info;
    const chars = [];
    const styleByEl = new Map();
    const walker = document.createTreeWalker(te, NodeFilter.SHOW_TEXT);
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!styleByEl.has(el)) styleByEl.set(el, this.styleOf(node));
      const style = styleByEl.get(el);
      if (!style || !style.fam) continue;
      const para = el.closest('p');
      const text = node.textContent;
      let offset = 0;
      for (const ch of text) {
        const len = ch.length;
        range.setStart(node, offset);
        range.setEnd(node, offset + len);
        offset += len;
        const rects = [...range.getClientRects()].filter((F) => F.width > 0.01 || F.height > 0.01);
        if (!rects.length) continue;
        const rect = rects[rects.length - 1];
        const box = this.pv.clientToLayerRect(rect);
        if (!(ch === SOFT_HYPHEN && box[2] - box[0] < 0.2))
          chars.push({
            ch: ch === SOFT_HYPHEN ? '-' : ch === '\t' ? ' ' : ch,
            l: box[0],
            t: box[1],
            r: box[2],
            b: box[3],
            st: style,
            p: para,
            el,
          });
      }
    }
    const lines = [];
    let currentLine = null;
    for (const ch of chars) {
      if (ch.ch === '\n') {
        currentLine = null;
        continue;
      }
      const height = ch.b - ch.t;
      if (
        !currentLine ||
        ch.p !== currentLine.p ||
        ch.t >= currentLine.bottom - 0.3 * height ||
        ch.l < currentLine.lastR - 0.5 * height
      ) {
        currentLine = { p: ch.p, chars: [], bottom: ch.b, lastR: ch.r };
        lines.push(currentLine);
      }
      currentLine.chars.push(ch);
      currentLine.bottom = Math.max(currentLine.bottom, ch.b);
      currentLine.lastR = ch.r;
    }
    lines.forEach((d, I) => {
      d.lastInPara = I === lines.length - 1 || lines[I + 1].p !== d.p;
      d.k = I > 0 && lines[I - 1].p === d.p ? lines[I - 1].k + 1 : 0;
    });
    const paraMetrics = new Map();
    const teLeft = this.pv.clientToLayerRect(te.getBoundingClientRect())[0];
    const metricsOf = (para) => {
      if (paraMetrics.has(para)) return paraMetrics.get(para);
      const style = getComputedStyle(para);
      const metrics = {
        base: this.baselineOf(para),
        lh: parseFloat(style.lineHeight) || 0,
        pad: parseFloat(style.paddingLeft) || 0,
        indent: parseFloat(style.textIndent) || 0,
        left: this.pv.rot ? null : teLeft,
      };
      paraMetrics.set(para, metrics);
      return metrics;
    };
    const result = [];
    this.anchorPos = new Map();
    for (const line of lines) {
      while (line.chars.length && /^[ \u2000-\u200a]$/.test(line.chars[line.chars.length - 1].ch))
        line.chars.pop();
      if (!line.chars.length) continue;
      const metrics = metricsOf(line.p);
      const baseline = metrics.base + line.k * metrics.lh;
      const y = info.y + info.h - baseline / scale;
      const align = line.chars[0].st.align;
      const alignedLeft =
        (align === 'left' || align === 'justify') && metrics.left != null
          ? metrics.left + metrics.pad + (line.k === 0 ? metrics.indent : 0)
          : null;
      const startX =
        info.x +
        (alignedLeft != null && Math.abs(line.chars[0].l - alignedLeft) <= 1.5
          ? alignedLeft
          : line.chars[0].l) /
          scale;
      const xs = [];
      let cursor = startX;
      const letterSpacing = (ch) => {
        const span = ch.closest('span[data-fam]');
        return span && span.dataset.ls ? +span.dataset.ls : 0;
      };
      const advances = line.chars.map((ch) => this.adv(ch.st.fam, ch.ch, ch.st.size) + letterSpacing(ch.el));
      const padLeft = line.chars.map((ch, K) =>
        ch.el.dataset.pl && (K === 0 || line.chars[K - 1].el !== ch.el) ? +ch.el.dataset.pl : 0,
      );
      const padRight = line.chars.map((ch, K) =>
        ch.el.dataset.pr && (K === line.chars.length - 1 || line.chars[K + 1].el !== ch.el)
          ? +ch.el.dataset.pr
          : 0,
      );
      advances.forEach((O, K) => {
        advances[K] = O + padRight[K] + (K + 1 < advances.length ? padLeft[K + 1] : 0);
      });
      let wordSpacing = 0;
      const align2 = line.chars[0].st.align;
      if (align2 === 'justify' && !line.lastInPara) {
        const lineRight = info.x + line.chars[line.chars.length - 1].r / scale;
        const natural = advances.reduce((j, ee) => j + ee, 0);
        const spaces = line.chars.filter((ch, ee) => (ch.ch === ' ' || ch.ch === '\u2002') && ee > 0).length;
        if (spaces) wordSpacing = Math.max(0, (lineRight - startX - natural) / spaces);
      }
      line.chars.forEach((ch, K) => {
        xs.push(cursor);
        cursor += advances[K] + ((ch.ch === ' ' || ch.ch === '\u2002') && K > 0 ? wordSpacing : 0);
      });
      const tolerance = Math.max(0.6, 0.3 * (metrics.lh / scale || 0));
      const orig = this.matchOrig(y, tolerance);
      if (orig) {
        const chars2 = orig.chars;
        let same = 0;
        while (
          same < chars2.length &&
          same < line.chars.length &&
          chars2[same].ch === line.chars[same].ch &&
          chars2[same].fam === line.chars[same].st.fam &&
          Math.abs(chars2[same].size - line.chars[same].st.size) < 0.02
        )
          same++;
        const offsetX = this.offset[0];
        if (same === line.chars.length && same === chars2.length)
          for (let k = 0; k < same; k++) xs[k] = chars2[k].x + offsetX;
        else if (same > 0 && !(align2 === 'justify' && !line.lastInPara)) {
          for (let k = 0; k < same; k++) xs[k] = chars2[k].x + offsetX;
          let x = xs[same - 1] + advances[same - 1];
          for (let k = same; k < xs.length; k++) {
            xs[k] = x;
            x += advances[k];
          }
        } else if (Math.abs(chars2[0].x + offsetX - xs[0]) < 0.6) {
          const shift = chars2[0].x + offsetX - xs[0];
          for (let k = 0; k < xs.length; k++) xs[k] += shift;
        }
      }
      const segs = [];
      let seg = null;
      line.chars.forEach((ch, k) => {
        const anchorEl = ch.el.closest('span[data-anchor]');
        if (anchorEl && !this.anchorPos.has(anchorEl.dataset.anchor))
          this.anchorPos.set(anchorEl.dataset.anchor, { x: xs[k], y: y + (ch.st.rise || 0), yLine: y });
        const style = ch.st;
        const key = [style.fam.key, style.size, style.color.join(','), style.alpha, style.rise].join('|');
        if (!seg || seg.key !== key) {
          seg = {
            key,
            x: xs[k],
            y: roundTo(y + (style.rise || 0), 10000),
            text: '',
            xs: [],
            fam: style.fam,
            size: style.size,
            color: style.color,
            alpha: style.alpha,
          };
          segs.push(seg);
        }
        seg.text += ch.ch;
        seg.xs.push(roundTo(xs[k], 10000));
      });
      if (orig) {
        const origY = orig.y + this.offset[1];
        if (Math.abs(origY - y) < tolerance) {
          segs.forEach((K) => {
            K.y = roundTo(K.y - y + origY, 10000);
          });
          for (const [, anchor] of this.anchorPos)
            if (anchor.yLine === y) {
              anchor.y += origY - y;
              anchor.yLine = origY;
            }
        }
      }
      result.push({ segs });
    }
    return result;
  }
  matchOrig(y, tolerance) {
    let best = null;
    for (const line of this.origLines) {
      const dist = Math.abs(line.y + this.offset[1] - y);
      if (dist < tolerance && (!best || dist < best.d)) best = { o: line, d: dist };
    }
    return best ? best.o : null;
  }
  anchorMoves() {
    const moves = [];
    const removes = [];
    for (const [id, anchor] of this.anchors || []) {
      const pos = this.anchorPos && this.anchorPos.get(id);
      if (!pos) {
        removes.push(...anchor.objs);
        continue;
      }
      const dx = pos.x - anchor.x;
      const dy = pos.y - anchor.y;
      if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) moves.push({ objs: anchor.objs, dx, dy });
    }
    return { moves, removes };
  }
  isEmpty() {
    return !this.te.textContent.replace(/[\s­]/g, '').length;
  }
  destroy() {
    document.removeEventListener('selectionchange', this._sel);
    this.frame.remove();
  }
}

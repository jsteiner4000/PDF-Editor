/**
 * Minimaler CFF-Leser: verpackt CFF-Schriften als OpenType für die Anzeige im Browser.
 */
import fontkit from '@pdf-lib/fontkit';
import { GLYPH_TABLES } from './glyph-list.js';
import { addMissingTables, buildCmapTable, buildSfnt } from './sfnt.js';
import { singleCodePoint } from '../pdf/pdf-objects.js';

const readUint16 = (bytes, pos) => (bytes[pos] << 8) | bytes[pos + 1];

const readUintN = (bytes, pos, size) => {
  let value = 0;
  for (let k = 0; k < size; k++) value = value * 256 + bytes[pos + k];
  return value;
};

function readCffIndex(bytes, pos) {
  const count = readUint16(bytes, pos);
  if (!count) return { items: [], end: pos + 2 };
  const offSize = bytes[pos + 2];
  const offsets = [];
  for (let k = 0; k <= count; k++) offsets.push(readUintN(bytes, pos + 3 + k * offSize, offSize));
  const dataStart = pos + 3 + (count + 1) * offSize - 1;
  return {
    items: offsets.slice(0, -1).map((A, s) => [dataStart + A, dataStart + offsets[s + 1]]),
    end: dataStart + offsets[count],
  };
}

function readCffDict(bytes, pos, end) {
  const dict = new Map();
  let operands = [];
  while (pos < end) {
    const b = bytes[pos];
    if (b <= 21) {
      let key = b;
      pos++;
      if (b === 12) {
        key = 1200 + bytes[pos];
        pos++;
      }
      dict.set(key, operands);
      operands = [];
    } else if (b === 28) {
      let value = readUint16(bytes, pos + 1);
      if (value > 32767) value -= 65536;
      operands.push(value);
      pos += 3;
    } else if (b === 29) {
      operands.push((bytes[pos + 1] << 24) | (bytes[pos + 2] << 16) | (bytes[pos + 3] << 8) | bytes[pos + 4]);
      pos += 5;
    } else if (b === 30) {
      let str = '';
      pos++;
      e: while (true) {
        const byte = bytes[pos++];
        for (const nibble of [byte >> 4, byte & 15]) {
          if (nibble === 15) break e;
          str += '0123456789.EE?-'[nibble] + (nibble === 12 ? '-' : '');
        }
      }
      operands.push(parseFloat(str.replace('E-', 'e-').replace('E', 'e')) || 0);
    } else if (b >= 32 && b <= 246) {
      operands.push(b - 139);
      pos++;
    } else if (b >= 247 && b <= 250) {
      operands.push((b - 247) * 256 + bytes[pos + 1] + 108);
      pos += 2;
    } else if (b >= 251 && b <= 254) {
      operands.push(-(b - 251) * 256 - bytes[pos + 1] - 108);
      pos += 2;
    } else pos++;
  }
  return dict;
}

function readCffCharset(bytes, offset, numGlyphs) {
  const charset = [0];
  if (!offset || offset < 3) {
    for (let gid = 1; gid < numGlyphs; gid++) charset.push(gid);
    return charset;
  }
  const format = bytes[offset];
  let pos = offset + 1;
  if (format === 0) for (let gid = 1; gid < numGlyphs; gid++, pos += 2) charset.push(readUint16(bytes, pos));
  else
    while (charset.length < numGlyphs) {
      const first = readUint16(bytes, pos);
      const left = format === 1 ? bytes[pos + 2] : readUint16(bytes, pos + 2);
      pos += format === 1 ? 3 : 4;
      for (let k = 0; k <= left && charset.length < numGlyphs; k++) charset.push(first + k);
    }
  return charset;
}

let glyphNamesByUnicode = null;

const glyphNameCandidates = (cp) => {
  if (!glyphNamesByUnicode) {
    glyphNamesByUnicode = new Map();
    for (const [name, value] of Object.entries(GLYPH_TABLES.agl)) {
      if (!glyphNamesByUnicode.has(value)) glyphNamesByUnicode.set(value, []);
      glyphNamesByUnicode.get(value).push(name);
    }
  }
  const hex = cp.toString(16).toUpperCase().padStart(4, '0');
  return [...(glyphNamesByUnicode.get(cp) || []), 'uni' + hex, 'u' + hex];
};

function wrapCffAsOpenType(cff, numGlyphs, advances, uniToGid, upm, metrics) {
  const tables = new Map();
  tables.set('CFF ', cff);
  const head = new Uint8Array(54);
  const headView = new DataView(head.buffer);
  const bbox = metrics && metrics.bbox ? metrics.bbox : [-200, -300, 1200, 1000];
  headView.setUint32(0, 65536);
  headView.setUint32(4, 65536);
  headView.setUint32(12, 1594834165);
  headView.setUint16(16, 3);
  headView.setUint16(18, upm);
  [bbox[0], bbox[1], bbox[2], bbox[3]].forEach((B, E) => headView.setInt16(36 + E * 2, Math.round(B)));
  headView.setUint16(46, 8);
  headView.setInt16(48, 2);
  tables.set('head', head);
  const ascender = Math.round(metrics && metrics.ascent ? (metrics.ascent * upm) / 1000 : upm * 0.8);
  const descender = Math.round(metrics && metrics.descent ? (metrics.descent * upm) / 1000 : -upm * 0.2);
  const hhea = new Uint8Array(36);
  const hheaView = new DataView(hhea.buffer);
  hheaView.setUint32(0, 65536);
  hheaView.setInt16(4, ascender);
  hheaView.setInt16(6, descender);
  hheaView.setUint16(10, Math.max(...advances, 0));
  hheaView.setInt16(18, 1);
  hheaView.setUint16(34, numGlyphs);
  tables.set('hhea', hhea);
  const hmtx = new Uint8Array(numGlyphs * 4);
  const hmtxView = new DataView(hmtx.buffer);
  for (let gid = 0; gid < numGlyphs; gid++)
    hmtxView.setUint16(gid * 4, Math.max(0, Math.round(advances[gid] || 0)));
  tables.set('hmtx', hmtx);
  const maxp = new Uint8Array(6);
  new DataView(maxp.buffer).setUint32(0, 20480);
  new DataView(maxp.buffer).setUint16(4, numGlyphs);
  tables.set('maxp', maxp);
  const post = new Uint8Array(32);
  new DataView(post.buffer).setUint32(0, 196608);
  tables.set('post', post);
  tables.set('cmap', buildCmapTable(uniToGid));
  addMissingTables(tables, { upm, ascender, descender, lineGap: 0 }, uniToGid, advances);
  return buildSfnt(tables, 1330926671);
}

export function buildCffDisplayFont(font) {
  const prog = font.program();
  if (!prog) return null;
  let cff = null;
  if (prog.kind === 'cff') cff = prog.bytes;
  else if (prog.kind === 'opentype' && prog.sf && prog.sf.tables.get('CFF '))
    cff = prog.sf.tables.get('CFF ');
  if (!cff) return null;
  try {
    const headerSize = cff[2];
    const nameIndex = readCffIndex(cff, headerSize);
    const topDictIndex = readCffIndex(cff, nameIndex.end);
    if (!topDictIndex.items.length) return null;
    const topDict = readCffDict(cff, topDictIndex.items[0][0], topDictIndex.items[0][1]);
    const charStringsOffset = (topDict.get(17) || [])[0];
    if (!charStringsOffset) return null;
    const numGlyphs = readCffIndex(cff, charStringsOffset).items.length;
    const isCid = topDict.has(1230);
    const fontMatrix = topDict.get(1207);
    const upm = fontMatrix && fontMatrix[0] ? Math.round(1 / fontMatrix[0]) : 1000;
    const charset = readCffCharset(cff, (topDict.get(15) || [0])[0], numGlyphs);
    const uniToGid = new Map();
    const advances = new Array(numGlyphs).fill(0);
    const widthScale = upm / 1000;
    const metrics = font.metrics();
    const fontMetrics = { ascent: metrics.ascent, descent: metrics.descent, bbox: null };
    if (font.isType0) {
      const cidToGid = new Map();
      charset.forEach((E, m) => cidToGid.set(E, m));
      for (const [cid, text] of font.uni) {
        const cp = singleCodePoint(text);
        if (cp == null) continue;
        const gid = isCid ? cidToGid.get(cid) : cid;
        if (!(gid == null || gid >= numGlyphs)) {
          if (!uniToGid.has(cp)) uniToGid.set(cp, gid);
          advances[gid] = font.width(cid) * widthScale;
        }
      }
    } else {
      const otf = wrapCffAsOpenType(cff, numGlyphs, advances, new Map(), upm, fontMetrics);
      const fkFont = fontkit.create(otf);
      const gidByName = new Map();
      for (let gid = 1; gid < numGlyphs; gid++)
        try {
          const name = fkFont.getGlyph(gid).name;
          if (name && !gidByName.has(name)) gidByName.set(name, gid);
        } catch {}
      for (let code = 0; code < 256; code++) {
        const text = font.uni.get(code);
        const cp = singleCodePoint(text);
        if (cp == null) continue;
        let gid = null;
        const diffName = font.differences && font.differences.get(code);
        if (diffName && gidByName.has(diffName)) gid = gidByName.get(diffName);
        if (gid == null) {
          for (const candidate of glyphNameCandidates((font.encUni && font.encUni.get(code)) || cp))
            if (gidByName.has(candidate)) {
              gid = gidByName.get(candidate);
              break;
            }
        }
        if (gid == null) {
          for (const candidate of glyphNameCandidates(cp))
            if (gidByName.has(candidate)) {
              gid = gidByName.get(candidate);
              break;
            }
        }
        if (gid != null) {
          if (!uniToGid.has(cp)) uniToGid.set(cp, gid);
          advances[gid] = font.width(code) * widthScale;
        }
      }
    }
    return uniToGid.size
      ? { bytes: wrapCffAsOpenType(cff, numGlyphs, advances, uniToGid, upm, fontMetrics), uni: uniToGid }
      : null;
  } catch {
    return null;
  }
}

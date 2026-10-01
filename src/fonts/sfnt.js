/**
 * Lesen und Schreiben von TrueType/OpenType-Tabellen (sfnt) sowie Zusammenführen von Schrift-Teilmengen.
 */

export const isSpaceCodePoint = (cp) =>
  cp === 32 || cp === 160 || (cp >= 8192 && cp <= 8203) || cp === 8239 || cp === 12288;

const readTag = (bytes, offset) =>
  String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);

export function parseSfnt(data) {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0);
  if (version !== 65536 && version !== 1953658213 && version !== 1330926671)
    throw new Error('keine sfnt-Schrift');
  const numTables = view.getUint16(4);
  const tables = new Map();
  for (let k = 0; k < numTables; k++) {
    const rec = 12 + k * 16;
    const tag = readTag(bytes, rec);
    const offset = view.getUint32(rec + 8);
    const length = view.getUint32(rec + 12);
    if (!(offset + length > bytes.length)) tables.set(tag, bytes.subarray(offset, offset + length));
  }
  return { version, tables, cff: version === 1330926671 || tables.has('CFF ') };
}

const viewOf = (bytes) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

export function readFontInfo(sfnt) {
  const head = viewOf(sfnt.tables.get('head'));
  const hhea = viewOf(sfnt.tables.get('hhea'));
  const maxp = viewOf(sfnt.tables.get('maxp'));
  return {
    upm: head.getUint16(18),
    locFormat: head.getInt16(50),
    numGlyphs: maxp.getUint16(4),
    numHMetrics: hhea.getUint16(34),
    ascender: hhea.getInt16(4),
    descender: hhea.getInt16(6),
    lineGap: hhea.getInt16(8),
  };
}

export function readAdvanceWidths(sfnt, info = readFontInfo(sfnt)) {
  const hmtx = sfnt.tables.get('hmtx');
  const widths = new Array(info.numGlyphs).fill(0);
  if (!hmtx) return widths;
  const view = viewOf(hmtx);
  let last = 0;
  for (let gid = 0; gid < info.numGlyphs; gid++) {
    if (gid < info.numHMetrics && gid * 4 + 2 <= hmtx.length) last = view.getUint16(gid * 4);
    widths[gid] = last;
  }
  return widths;
}

export function readLeftSideBearings(sfnt, info = readFontInfo(sfnt)) {
  const hmtx = sfnt.tables.get('hmtx');
  const lsbs = new Array(info.numGlyphs).fill(0);
  if (!hmtx) return lsbs;
  const view = viewOf(hmtx);
  for (let gid = 0; gid < info.numGlyphs; gid++) {
    const offset = gid < info.numHMetrics ? gid * 4 + 2 : info.numHMetrics * 4 + (gid - info.numHMetrics) * 2;
    if (offset + 2 <= hmtx.length) lsbs[gid] = view.getInt16(offset);
  }
  return lsbs;
}

export function readGlyphData(sfnt, info = readFontInfo(sfnt)) {
  const loca = sfnt.tables.get('loca');
  const glyf = sfnt.tables.get('glyf');
  if (!loca || !glyf) return null;
  const view = viewOf(loca);
  const glyphs = [];
  const offsetOf = (gid) => (info.locFormat === 0 ? view.getUint16(gid * 2) * 2 : view.getUint32(gid * 4));
  const count = info.locFormat === 0 ? loca.length / 2 - 1 : loca.length / 4 - 1;
  for (let gid = 0; gid < info.numGlyphs; gid++) {
    if (gid >= count) {
      glyphs.push(new Uint8Array(0));
      continue;
    }
    const start = offsetOf(gid);
    const end = offsetOf(gid + 1);
    glyphs.push(end > start && end <= glyf.length ? glyf.subarray(start, end) : new Uint8Array(0));
  }
  return glyphs;
}

export function readCmaps(sfnt) {
  const cmap = sfnt.tables.get('cmap');
  const result = { unicode: new Map(), symbol: new Map(), mac: new Map() };
  if (!cmap) return result;
  const view = viewOf(cmap);
  const numTables = view.getUint16(2);
  const records = [];
  for (let k = 0; k < numTables; k++)
    records.push({
      pid: view.getUint16(4 + k * 8),
      eid: view.getUint16(6 + k * 8),
      off: view.getUint32(8 + k * 8),
    });
  const readSubtable = (offset, target) => {
    if (offset >= cmap.length) return;
    const format = view.getUint16(offset);
    if (format === 4) {
      const segX2 = view.getUint16(offset + 6);
      const segCount = segX2 / 2;
      const endOff = offset + 14;
      const startOff = endOff + segX2 + 2;
      const deltaOff = startOff + segX2;
      const rangeOff = deltaOff + segX2;
      for (let seg = 0; seg < segCount; seg++) {
        const endCode = view.getUint16(endOff + seg * 2);
        const startCode = view.getUint16(startOff + seg * 2);
        const delta = view.getInt16(deltaOff + seg * 2);
        const rangeOffset = view.getUint16(rangeOff + seg * 2);
        for (let code = startCode; code <= endCode && code !== 65535; code++) {
          let gid;
          if (rangeOffset === 0) gid = (code + delta) & 65535;
          else {
            const addr = rangeOff + seg * 2 + rangeOffset + (code - startCode) * 2;
            if (addr + 2 > cmap.length) continue;
            gid = view.getUint16(addr);
            if (gid) gid = (gid + delta) & 65535;
          }
          if (gid) target.set(code, gid);
        }
      }
    } else if (format === 12) {
      const numGroups = view.getUint32(offset + 12);
      for (let g = 0; g < numGroups; g++) {
        const rec = offset + 16 + g * 12;
        const startChar = view.getUint32(rec);
        const endChar = view.getUint32(rec + 4);
        const startGlyph = view.getUint32(rec + 8);
        for (let code = startChar; code <= endChar && code - startChar < 131072; code++)
          target.set(code, startGlyph + (code - startChar));
      }
    } else if (format === 0)
      for (let code = 0; code < 256; code++) {
        const gid = cmap[offset + 6 + code];
        if (gid) target.set(code, gid);
      }
    else if (format === 6) {
      const firstCode = view.getUint16(offset + 6);
      const count = view.getUint16(offset + 8);
      for (let k = 0; k < count; k++) {
        const gid = view.getUint16(offset + 10 + k * 2);
        if (gid) target.set(firstCode + k, gid);
      }
    }
  };
  for (const rec of records)
    if ((rec.pid === 3 && (rec.eid === 1 || rec.eid === 10)) || rec.pid === 0)
      readSubtable(rec.off, result.unicode);
    else if (rec.pid === 3 && rec.eid === 0) readSubtable(rec.off, result.symbol);
    else if (rec.pid === 1 && rec.eid === 0) readSubtable(rec.off, result.mac);
  return result;
}

class ByteWriter {
  constructor(capacity = 256) {
    this.b = new Uint8Array(capacity);
    this.n = 0;
  }
  need(count) {
    if (this.n + count > this.b.length) {
      const grown = new Uint8Array(Math.max(this.b.length * 2, this.n + count));
      grown.set(this.b.subarray(0, this.n));
      this.b = grown;
    }
  }
  u8(value) {
    this.need(1);
    this.b[this.n++] = value & 255;
  }
  u16(value) {
    this.need(2);
    this.b[this.n++] = (value >> 8) & 255;
    this.b[this.n++] = value & 255;
  }
  i16(value) {
    this.u16(value < 0 ? value + 65536 : value);
  }
  u32(value) {
    this.need(4);
    this.b[this.n++] = (value >>> 24) & 255;
    this.b[this.n++] = (value >>> 16) & 255;
    this.b[this.n++] = (value >>> 8) & 255;
    this.b[this.n++] = value & 255;
  }
  bytes(bytes) {
    this.need(bytes.length);
    this.b.set(bytes, this.n);
    this.n += bytes.length;
  }
  pad4() {
    while (this.n % 4) this.u8(0);
  }
  out() {
    return this.b.slice(0, this.n);
  }
}

export function buildCmapTable(uniToGid) {
  const entries = [...uniToGid.entries()].filter(([f, d]) => d > 0 && f >= 0).sort((f, d) => f[0] - d[0]);
  const bmp = entries.filter(([f]) => f < 65535);
  const segments = [];
  for (const [cp, gid] of bmp) {
    const last = segments[segments.length - 1];
    if (last && cp === last.end + 1 && gid - cp === last.delta) last.end = cp;
    else segments.push({ start: cp, end: cp, delta: gid - cp });
  }
  segments.push({ start: 65535, end: 65535, delta: 1 });
  const fmt4 = new ByteWriter();
  const segX2 = segments.length * 2;
  const searchRange = 2 ** Math.floor(Math.log2(segments.length)) * 2;
  fmt4.u16(4);
  fmt4.u16(0);
  fmt4.u16(0);
  fmt4.u16(segX2);
  fmt4.u16(searchRange);
  fmt4.u16(Math.log2(searchRange / 2));
  fmt4.u16(segX2 - searchRange);
  segments.forEach((f) => fmt4.u16(f.end));
  fmt4.u16(0);
  segments.forEach((f) => fmt4.u16(f.start));
  segments.forEach((f) => fmt4.u16(f.delta & 65535));
  segments.forEach(() => fmt4.u16(0));
  const sub4 = fmt4.out();
  sub4[2] = (sub4.length >> 8) & 255;
  sub4[3] = sub4.length & 255;
  const hasSupplementary = entries.some(([f]) => f > 65535);
  let sub12 = null;
  if (hasSupplementary) {
    const groups = [];
    for (const [cp, gid] of entries) {
      const last = groups[groups.length - 1];
      if (last && cp === last.e + 1 && gid === last.g + (cp - last.s)) last.e = cp;
      else groups.push({ s: cp, e: cp, g: gid });
    }
    const fmt12 = new ByteWriter();
    fmt12.u16(12);
    fmt12.u16(0);
    fmt12.u32(16 + groups.length * 12);
    fmt12.u32(0);
    fmt12.u32(groups.length);
    groups.forEach((I) => {
      fmt12.u32(I.s);
      fmt12.u32(I.e);
      fmt12.u32(I.g);
    });
    sub12 = fmt12.out();
  }
  const out = new ByteWriter();
  const numTables = hasSupplementary ? 3 : 2;
  out.u16(0);
  out.u16(numTables);
  const offset = 4 + numTables * 8;
  out.u16(0);
  out.u16(3);
  out.u32(offset);
  out.u16(3);
  out.u16(1);
  out.u32(offset);
  if (hasSupplementary) {
    out.u16(3);
    out.u16(10);
    out.u32(offset + sub4.length);
  }
  out.bytes(sub4);
  if (sub12) out.bytes(sub12);
  return out.out();
}

function tableChecksum(data) {
  let sum = 0;
  const len = Math.ceil(data.length / 4) * 4;
  for (let k = 0; k < len; k += 4)
    sum =
      (sum +
        (((data[k] || 0) << 24) >>> 0) +
        ((data[k + 1] || 0) << 16) +
        ((data[k + 2] || 0) << 8) +
        (data[k + 3] || 0)) >>>
      0;
  return sum >>> 0;
}

export function buildSfnt(tables, version = 65536) {
  const tags = [...tables.keys()].sort();
  const numTables = tags.length;
  const searchRange = 2 ** Math.floor(Math.log2(numTables));
  const out = new ByteWriter(1024);
  out.u32(version);
  out.u16(numTables);
  out.u16(searchRange * 16);
  out.u16(Math.log2(searchRange));
  out.u16(numTables * 16 - searchRange * 16);
  let offset = 12 + numTables * 16;
  const entries = [];
  for (const tag of tags) {
    const data = tables.get(tag);
    entries.push({ t: tag, data, off: offset, cs: tableChecksum(data) });
    offset += Math.ceil(data.length / 4) * 4;
  }
  for (const entry of entries) {
    for (let k = 0; k < 4; k++) out.u8(entry.t.charCodeAt(k));
    out.u32(entry.cs);
    out.u32(entry.off);
    out.u32(entry.data.length);
  }
  for (const entry of entries) {
    out.bytes(entry.data);
    out.pad4();
  }
  const bytes = out.out();
  const head = entries.find((c) => c.t === 'head');
  if (head) {
    const adjustment = (2981146554 - tableChecksum(bytes)) >>> 0;
    const pos = head.off + 8;
    bytes[pos] = adjustment >>> 24;
    bytes[pos + 1] = (adjustment >>> 16) & 255;
    bytes[pos + 2] = (adjustment >>> 8) & 255;
    bytes[pos + 3] = adjustment & 255;
  }
  return bytes;
}

export function haveSameGlyphs(fontA, fontB) {
  const count = Math.min(fontA.glyphs.length, fontB.glyphs.length);
  let compared = 0;
  for (let gid = 1; gid < count; gid++) {
    const glyphA = fontA.glyphs[gid];
    const glyphB = fontB.glyphs[gid];
    if (glyphA.length && glyphB.length) {
      compared++;
      if (glyphA.length !== glyphB.length) return false;
      for (let k = 0; k < glyphA.length; k++) if (glyphA[k] !== glyphB[k]) return false;
    }
  }
  return true;
}

const glyphIdSetCache = new WeakMap();

function mappedGlyphIds(font) {
  if (!glyphIdSetCache.has(font)) glyphIdSetCache.set(font, new Set(font.uni.values()));
  return glyphIdSetCache.get(font);
}

export function mergeFontSubsets(fonts) {
  const richest = fonts.reduce((B, E) =>
    E.glyphs.filter((glyph) => glyph.length).length > B.glyphs.filter((glyph) => glyph.length).length ? E : B,
  );
  const numGlyphs = Math.max(...fonts.map((B) => B.info.numGlyphs));
  const glyphs = [];
  const advances = [];
  const lsbs = [];
  for (let gid = 0; gid < numGlyphs; gid++) {
    let source = null;
    for (const font of fonts)
      if (gid < font.glyphs.length && font.glyphs[gid].length) {
        source = font;
        break;
      }
    if (!source)
      source =
        fonts.find((m) => mappedGlyphIds(m).has(gid)) || fonts.find((m) => gid < m.info.numGlyphs) || richest;
    glyphs.push(gid < source.glyphs.length ? source.glyphs[gid] : new Uint8Array(0));
    advances.push(gid < source.adv.length ? source.adv[gid] : 0);
    lsbs.push(gid < source.lsb.length ? source.lsb[gid] : 0);
  }
  const uniToGid = new Map();
  for (const font of fonts)
    for (const [cp, gid] of font.uni)
      if (!uniToGid.has(cp) && gid < numGlyphs && (glyphs[gid].length || isSpaceCodePoint(cp)))
        uniToGid.set(cp, gid);
  const spaceCp = [32, 160, 8194, 8201, 8192, 8193, 8195, 8196, 8197, 8198, 8199, 8200, 8202, 8239].find(
    (B) => uniToGid.has(B),
  );
  if (spaceCp != null)
    for (const cp of [32, 160]) if (!uniToGid.has(cp)) uniToGid.set(cp, uniToGid.get(spaceCp));
  const glyf = new ByteWriter(4096);
  const loca = new ByteWriter((numGlyphs + 1) * 4);
  for (const glyph of glyphs) {
    loca.u32(glyf.n);
    glyf.bytes(glyph);
    glyf.pad4();
  }
  loca.u32(glyf.n);
  const hmtx = new ByteWriter(numGlyphs * 4);
  for (let gid = 0; gid < numGlyphs; gid++) {
    hmtx.u16(advances[gid]);
    hmtx.i16(lsbs[gid]);
  }
  const tables = new Map();
  for (const [tag, data] of richest.sf.tables)
    if (['OS/2', 'name', 'cvt ', 'fpgm', 'prep', 'gasp'].includes(tag)) tables.set(tag, data.slice());
  const head = richest.sf.tables.get('head').slice();
  head[50] = 0;
  head[51] = 1;
  head[8] = head[9] = head[10] = head[11] = 0;
  tables.set('head', head);
  const hhea = richest.sf.tables.get('hhea').slice();
  let maxAdvance = 0;
  advances.forEach((B) => {
    if (B > maxAdvance) maxAdvance = B;
  });
  hhea[10] = maxAdvance >> 8;
  hhea[11] = maxAdvance & 255;
  hhea[34] = numGlyphs >> 8;
  hhea[35] = numGlyphs & 255;
  tables.set('hhea', hhea);
  const maxp = richest.sf.tables.get('maxp').slice();
  maxp[4] = numGlyphs >> 8;
  maxp[5] = numGlyphs & 255;
  if (maxp.length >= 32)
    for (let offset = 6; offset + 2 <= 32; offset += 2) {
      let maxValue = 0;
      for (const font of fonts) {
        const fontMaxp = font.sf.tables.get('maxp');
        if (fontMaxp.length >= offset + 2)
          maxValue = Math.max(maxValue, (fontMaxp[offset] << 8) | fontMaxp[offset + 1]);
      }
      maxp[offset] = maxValue >> 8;
      maxp[offset + 1] = maxValue & 255;
    }
  tables.set('maxp', maxp);
  const post = new ByteWriter(32);
  post.u32(196608);
  post.bytes(
    richest.sf.tables.get('post') ? richest.sf.tables.get('post').subarray(4, 32) : new Uint8Array(28),
  );
  tables.set('post', post.out());
  tables.set('glyf', glyf.out());
  tables.set('loca', loca.out());
  tables.set('hmtx', hmtx.out());
  tables.set('cmap', buildCmapTable(uniToGid));
  addMissingTables(tables, richest.info, uniToGid, advances);
  return { bytes: buildSfnt(tables), uni: uniToGid, adv: advances, numGlyphs, upm: richest.info.upm, glyphs };
}

export function addMissingTables(tables, info, uniToGid, advances) {
  const hasTable = (tag, minLength) => tables.has(tag) && tables.get(tag).length >= minLength;
  if (!hasTable('OS/2', 78)) {
    const os2 = new ByteWriter(96);
    const ascender = info.ascender || Math.round(info.upm * 0.8);
    const descender = info.descender || -Math.round(info.upm * 0.2);
    const nonZero = advances.filter((d) => d > 0);
    const avgWidth = nonZero.length
      ? Math.round(nonZero.reduce((d, I) => d + I, 0) / nonZero.length)
      : Math.round(info.upm / 2);
    const bmpCodes = [...uniToGid.keys()].filter((d) => d <= 65535);
    const firstChar = bmpCodes.length ? Math.min(...bmpCodes) : 32;
    const lastChar = bmpCodes.length ? Math.max(...bmpCodes) : 126;
    os2.u16(4);
    os2.i16(avgWidth);
    os2.u16(400);
    os2.u16(5);
    os2.u16(0);
    const upm = info.upm;
    [
      upm * 0.65,
      upm * 0.6,
      0,
      upm * 0.075,
      upm * 0.65,
      upm * 0.6,
      0,
      upm * 0.35,
      upm * 0.05,
      upm * 0.3,
    ].forEach((d) => os2.i16(Math.round(d)));
    os2.i16(0);
    for (let k = 0; k < 10; k++) os2.u8(0);
    os2.u32(1);
    os2.u32(0);
    os2.u32(0);
    os2.u32(0);
    os2.bytes([80, 68, 70, 69]);
    os2.u16(64);
    os2.u16(firstChar);
    os2.u16(lastChar);
    os2.i16(ascender);
    os2.i16(descender);
    os2.i16(info.lineGap || 0);
    os2.u16(Math.max(0, ascender));
    os2.u16(Math.max(0, -descender));
    os2.u32(1);
    os2.u32(0);
    os2.i16(Math.round(upm * 0.5));
    os2.i16(Math.round(upm * 0.7));
    os2.u16(0);
    os2.u16(32);
    os2.u16(1);
    tables.set('OS/2', os2.out());
  }
  if (!hasTable('name', 6)) {
    const names = [
      [1, 'PDFE Font'],
      [2, 'Regular'],
      [3, 'PDFE Font'],
      [4, 'PDFE Font'],
      [6, 'PDFE-Font'],
    ];
    const nameTable = new ByteWriter(256);
    nameTable.u16(0);
    nameTable.u16(names.length);
    nameTable.u16(6 + names.length * 12);
    let stringOffset = 0;
    const strings = [];
    for (const [nameId, text] of names) {
      const utf16 = [];
      for (const ch of text) utf16.push(0, ch.charCodeAt(0));
      nameTable.u16(3);
      nameTable.u16(1);
      nameTable.u16(1033);
      nameTable.u16(nameId);
      nameTable.u16(utf16.length);
      nameTable.u16(stringOffset);
      stringOffset += utf16.length;
      strings.push(utf16);
    }
    for (const str of strings) nameTable.bytes(str);
    tables.set('name', nameTable.out());
  }
}

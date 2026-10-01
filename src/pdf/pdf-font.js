/**
 * Analyse von PDF-Schriften: Codierung, Breiten, ToUnicode, eingebettete Programme.
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, StandardFontEmbedder } from 'pdf-lib';
import { GLYPH_TABLES } from '../fonts/glyph-list.js';
import {
  isSpaceCodePoint,
  parseSfnt,
  readAdvanceWidths,
  readCmaps,
  readFontInfo,
  readGlyphData,
  readLeftSideBearings,
} from '../fonts/sfnt.js';
import { LIGATURES, nameText, numberOf, pdfName, readStreamBytes, singleCodePoint } from './pdf-objects.js';

function parseHexCode(hex) {
  const digits = hex.replace(/[^0-9a-fA-F]/g, '');
  return { v: parseInt(digits || '0', 16), len: digits.length / 2 };
}

function hexToText(hex) {
  const digits = hex.replace(/[^0-9a-fA-F]/g, '');
  let text = '';
  for (let k = 0; k + 4 <= digits.length; k += 4)
    text += String.fromCharCode(parseInt(digits.substr(k, 4), 16));
  if (digits.length === 2) text = String.fromCharCode(parseInt(digits, 16));
  return text;
}

function parseToUnicodeCMap(cmap) {
  const map = new Map();
  let codeLen = 0;
  const codespaceRe = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let match;
  while ((match = codespaceRe.exec(cmap))) {
    const hex = match[1].match(/<([0-9a-fA-F]+)>/);
    if (hex) codeLen = Math.max(codeLen, hex[1].length / 2);
  }
  const bfcharRe = /beginbfchar([\s\S]*?)endbfchar/g;
  while ((match = bfcharRe.exec(cmap))) {
    const pairRe = /<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>/g;
    let pair;
    while ((pair = pairRe.exec(match[1]))) map.set(parseHexCode(pair[1]).v, hexToText(pair[2]));
  }
  const bfrangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
  while ((match = bfrangeRe.exec(cmap))) {
    const rangeRe = /<([0-9a-fA-F\s]*)>\s*<([0-9a-fA-F\s]*)>\s*(<[0-9a-fA-F\s]*>|\[[^\]]*\])/g;
    let range;
    while ((range = rangeRe.exec(match[1]))) {
      const lo = parseHexCode(range[1]).v;
      const hi = parseHexCode(range[2]).v;
      if (!(hi - lo > 65536))
        if (range[3][0] === '[') {
          const targets = [...range[3].matchAll(/<([0-9a-fA-F\s]*)>/g)].map((u) => hexToText(u[1]));
          for (let code = lo; code <= hi && code - lo < targets.length; code++)
            map.set(code, targets[code - lo]);
        } else {
          const base = hexToText(range[3].slice(1, -1));
          for (let code = lo; code <= hi; code++) {
            const last = base.charCodeAt(base.length - 1) + (code - lo);
            map.set(code, base.slice(0, -1) + String.fromCharCode(last));
          }
        }
    }
  }
  return { map, codeLen };
}

const glyphNameToUnicode = (name) => {
  if (!name) return 0;
  if (GLYPH_TABLES.agl[name] !== undefined) return GLYPH_TABLES.agl[name];
  let match = name.match(/^uni([0-9A-Fa-f]{4})/);
  if (match || ((match = name.match(/^u([0-9A-Fa-f]{4,6})$/)), match)) return parseInt(match[1], 16);
  const base = name.split('.')[0];
  return base !== name && GLYPH_TABLES.agl[base] !== undefined ? GLYPH_TABLES.agl[base] : 0;
};

const STANDARD_FONT_RE = /^(Helvetica|Arial|Times|Courier|Symbol|ZapfDingbats)/i;

class PdfFont {
  constructor(ctx, ref, dict, key) {
    this.ctx = ctx;
    this.ref = ref;
    this.dict = dict;
    this.key = key;
    this.seen = new Set();
    this.subtype = nameText(dict.get(pdfName('Subtype')));
    this.baseFont = nameText(dict.get(pdfName('BaseFont'))) || key || 'Unbenannt';
    this.psName = this.baseFont.replace(/^[A-Z]{6}\+/, '');
    this.isType0 = this.subtype === 'Type0';
    this.isType3 = this.subtype === 'Type3';
    this.cid = null;
    this.encodingName = null;
    this.differences = null;
    this.vertical = false;
    this.twoByte = false;
    this.unsupported = null;
    if (this.isType0) {
      const encoding = dict.get(pdfName('Encoding'));
      this.encodingName = nameText(encoding);
      if (this.encodingName === 'Identity-H') this.twoByte = true;
      else if (this.encodingName === 'Identity-V') {
        this.twoByte = true;
        this.vertical = true;
      } else this.unsupported = 'Codierung ' + (this.encodingName || 'eingebettet');
      const descendants = dict.lookupMaybe(pdfName('DescendantFonts'), PDFArray);
      this.cid = descendants ? ctx.lookup(descendants.get(0), PDFDict) : null;
    } else {
      const encoding = dict.lookup(pdfName('Encoding'));
      if (encoding instanceof PDFName) this.encodingName = encoding.decodeText();
      else if (encoding instanceof PDFDict) {
        this.encodingName = nameText(encoding.get(pdfName('BaseEncoding')));
        const differences = encoding.lookupMaybe(pdfName('Differences'), PDFArray);
        if (differences) {
          this.differences = new Map();
          let code = 0;
          for (const item of differences.asArray()) {
            const entry = ctx.lookup(item);
            if (entry instanceof PDFNumber) code = entry.asNumber();
            else if (entry instanceof PDFName) this.differences.set(code++, entry.decodeText());
          }
        }
      }
    }
    this.fd = (this.cid || dict).lookupMaybe(pdfName('FontDescriptor'), PDFDict) || null;
    this.flags = this.fd ? numberOf(this.fd.lookup(pdfName('Flags'))) : 0;
    this.symbolic = !!(this.flags & 4) && !(this.flags & 32);
    this._widths();
    this._toUnicode();
  }
  get family() {
    return this.psName;
  }
  get bold() {
    return (
      /bold|black|heavy|semibold|demi/i.test(this.psName) ||
      (this.fd && numberOf(this.fd.lookup(pdfName('FontWeight'))) >= 600)
    );
  }
  get italic() {
    return /italic|oblique/i.test(this.psName) || !!(this.flags & 64);
  }
  get serif() {
    return (
      (/times|serif|georgia|garamond|cambria|book/i.test(this.psName) && !/sans/i.test(this.psName)) ||
      !!(this.flags & 2)
    );
  }
  get mono() {
    return /courier|mono|consol/i.test(this.psName) || !!(this.flags & 1);
  }
  _widths() {
    this.w = new Map();
    this.dw = 1000;
    if (this.isType0 && this.cid) {
      this.dw = this.cid.has(pdfName('DW')) ? numberOf(this.cid.lookup(pdfName('DW'))) : 1000;
      const widthArray = this.cid.lookupMaybe(pdfName('W'), PDFArray);
      if (widthArray) {
        const items = widthArray.asArray().map((i) => this.ctx.lookup(i));
        for (let k = 0; k < items.length;) {
          const first = numberOf(items[k]);
          if (items[k + 1] instanceof PDFArray) {
            items[k + 1].asArray().forEach((a, A) => this.w.set(first + A, numberOf(this.ctx.lookup(a))));
            k += 2;
          } else {
            const last = numberOf(items[k + 1]);
            const width = numberOf(items[k + 2]);
            for (let code = first; code <= last && code - first < 65536; code++) this.w.set(code, width);
            k += 3;
          }
        }
      }
    } else {
      const firstChar = numberOf(this.dict.lookup(pdfName('FirstChar')));
      const widths = this.dict.lookupMaybe(pdfName('Widths'), PDFArray);
      if (widths) widths.asArray().forEach((i, n) => this.w.set(firstChar + n, numberOf(this.ctx.lookup(i))));
      this.dw =
        this.fd && this.fd.has(pdfName('MissingWidth'))
          ? numberOf(this.fd.lookup(pdfName('MissingWidth')))
          : widths
            ? 0
            : 500;
      if (!widths && !this.isType3 && STANDARD_FONT_RE.test(this.psName)) {
        const name = this.psName;
        const bold = /bold|black|heavy/i.test(name);
        const italic = /italic|oblique/i.test(name);
        const base = /^(Times)/i.test(name)
          ? 'Times'
          : /^Courier/i.test(name)
            ? 'Courier'
            : /^Symbol/i.test(name)
              ? 'Symbol'
              : /^ZapfDingbats/i.test(name)
                ? 'ZapfDingbats'
                : 'Helvetica';
        const stdName =
          base === 'Times'
            ? bold && italic
              ? 'Times-BoldItalic'
              : bold
                ? 'Times-Bold'
                : italic
                  ? 'Times-Italic'
                  : 'Times-Roman'
            : base === 'Symbol' || base === 'ZapfDingbats'
              ? base
              : base + (bold && italic ? '-BoldOblique' : bold ? '-Bold' : italic ? '-Oblique' : '');
        try {
          this._stdEmb = StandardFontEmbedder.for(stdName);
        } catch {
          this._stdEmb = null;
        }
      }
      if (this.isType3) {
        const matrix = this.dict.lookupMaybe(pdfName('FontMatrix'), PDFArray);
        this.fm = matrix
          ? matrix.asArray().map((n) => numberOf(this.ctx.lookup(n)))
          : [0.001, 0, 0, 0.001, 0, 0];
      }
    }
  }
  width(code) {
    if (this._stdEmb && !this.w.has(code)) {
      const text = this.unicode(code);
      let measured = 0;
      try {
        measured = text ? this._stdEmb.widthOfTextAtSize(text, 1000) : 0;
      } catch {
        measured = 0;
      }
      this.w.set(code, measured || this.dw);
    }
    const width = this.w.has(code) ? this.w.get(code) : this.dw;
    return this.isType3 ? width * this.fm[0] * 1000 : width;
  }
  _toUnicode() {
    this.uni = new Map();
    const toUnicode = this.dict.lookup(pdfName('ToUnicode'));
    if (toUnicode && !(toUnicode instanceof PDFName))
      try {
        const bytes = readStreamBytes(this.ctx, toUnicode);
        let cmapText = '';
        for (let k = 0; k < bytes.length; k++) cmapText += String.fromCharCode(bytes[k]);
        this.uni = parseToUnicodeCMap(cmapText).map;
      } catch {}
    if (!this.isType0) {
      const table =
        this.encodingName === 'WinAnsiEncoding'
          ? GLYPH_TABLES.winansi
          : this.encodingName === 'MacRomanEncoding'
            ? GLYPH_TABLES.macroman
            : this.encodingName === 'StandardEncoding'
              ? GLYPH_TABLES.standard
              : this.symbolic
                ? null
                : STANDARD_FONT_RE.test(this.psName) || !this.fd
                  ? GLYPH_TABLES.standard
                  : GLYPH_TABLES.winansi;
      this.encUni = new Map();
      for (let code = 0; code < 256; code++) {
        let cp = 0;
        if (this.differences && this.differences.has(code))
          cp = glyphNameToUnicode(this.differences.get(code));
        else if (table) cp = table[code];
        if (cp) this.encUni.set(code, cp);
        if (!this.uni.has(code) && cp) this.uni.set(code, String.fromCodePoint(cp));
      }
    }
  }
  decode(bytes) {
    const codes = [];
    if (this.twoByte)
      for (let k = 0; k + 1 < bytes.length; k += 2) codes.push((bytes[k] << 8) | bytes[k + 1]);
    else for (let k = 0; k < bytes.length; k++) codes.push(bytes[k]);
    return codes;
  }
  unicode(code) {
    const text = this.uni.get(code);
    if (text !== undefined) return text;
    if (this.isType0 && this.program()) {
      const gidToUni = this.gidToUni();
      const gid = this.gid(code);
      if (gidToUni.has(gid)) return String.fromCodePoint(gidToUni.get(gid));
    }
    return '';
  }
  program() {
    if (this._prog !== undefined) return this._prog;
    this._prog = null;
    if (!this.fd) return null;
    for (const key of ['FontFile2', 'FontFile3', 'FontFile']) {
      const ref = this.fd.get(pdfName(key));
      if (ref) {
        try {
          const bytes = readStreamBytes(this.ctx, ref);
          let kind = key === 'FontFile2' ? 'truetype' : key === 'FontFile' ? 'type1' : 'cff';
          if (key === 'FontFile3') {
            const stream = this.ctx.lookup(ref);
            if (nameText(stream.dict.get(pdfName('Subtype'))) === 'OpenType') kind = 'opentype';
          }
          this._prog = { kind, bytes, ref };
          if (kind === 'truetype' || kind === 'opentype')
            try {
              this._prog.sf = parseSfnt(bytes);
              this._prog.info = readFontInfo(this._prog.sf);
              if (this._prog.sf.cff) this._prog.kind = 'opentype';
            } catch {
              this._prog.sf = null;
            }
        } catch {
          this._prog = null;
        }
        break;
      }
    }
    return this._prog;
  }
  gid(code) {
    if (this.isType0) {
      const map = this.cid && this.cid.get(pdfName('CIDToGIDMap'));
      if (!map || map instanceof PDFName) return code;
      if (!this._c2g) {
        const bytes = readStreamBytes(this.ctx, map);
        this._c2g = bytes;
      }
      return code * 2 + 1 < this._c2g.length ? (this._c2g[code * 2] << 8) | this._c2g[code * 2 + 1] : 0;
    }
    const prog = this.program();
    if (!prog || !prog.sf) return 0;
    if (!this._cm) this._cm = readCmaps(prog.sf);
    const cmaps = this._cm;
    if (cmaps.symbol.size) return cmaps.symbol.get(61440 + code) || cmaps.symbol.get(code) || 0;
    const text = this.uni.get(code);
    if (text && cmaps.unicode.size) {
      const gid = cmaps.unicode.get(text.codePointAt(0));
      if (gid) return gid;
    }
    const cp = this.encUni && this.encUni.get(code);
    if (cp && cmaps.unicode.size) {
      const gid = cmaps.unicode.get(cp);
      if (gid) return gid;
    }
    return (cmaps.mac.size && cmaps.mac.get(code)) || 0;
  }
  gidToUni() {
    if (this._g2u) return this._g2u;
    this._g2u = new Map();
    const prog = this.program();
    if (prog && prog.sf) {
      const cmaps = readCmaps(prog.sf);
      for (const [cp, gid] of cmaps.unicode) if (!this._g2u.has(gid)) this._g2u.set(gid, cp);
    }
    return this._g2u;
  }
  mergeable() {
    if (this._mg !== undefined) return this._mg;
    this._mg = null;
    const prog = this.program();
    if (!prog || prog.kind !== 'truetype' || !prog.sf || prog.sf.cff || this.unsupported || this.vertical)
      return null;
    try {
      const glyphs = readGlyphData(prog.sf, prog.info);
      if (!glyphs) return null;
      const uniToGid = new Map();
      const codes = new Set([...this.uni.keys()]);
      if (!this.isType0) for (let code = 0; code < 256; code++) codes.add(code);
      for (const code of codes) {
        const text = this.uni.get(code);
        const cp = singleCodePoint(text);
        if (cp == null) continue;
        const gid = this.gid(code);
        if (gid > 0 && gid < glyphs.length && (glyphs[gid].length || isSpaceCodePoint(cp))) {
          if (!uniToGid.has(cp)) uniToGid.set(cp, gid);
        }
      }
      if (this.isType0)
        for (const [gid, cp] of this.gidToUni())
          if (!uniToGid.has(cp) && gid < glyphs.length && (glyphs[gid].length || isSpaceCodePoint(cp)))
            uniToGid.set(cp, gid);
      this._mg = {
        sf: prog.sf,
        info: prog.info,
        glyphs,
        adv: readAdvanceWidths(prog.sf, prog.info),
        lsb: readLeftSideBearings(prog.sf, prog.info),
        uni: uniToGid,
        font: this,
      };
    } catch {
      this._mg = null;
    }
    return this._mg;
  }
  codeFor(text) {
    if (!this._rev) {
      this._rev = new Map();
      for (const [srcCode, srcText] of this.uni) {
        if (!this._rev.has(srcText)) this._rev.set(srcText, srcCode);
        const ligature = LIGATURES[srcText];
        if (ligature) {
          const ligatureText = String.fromCodePoint(ligature);
          if (!this._rev.has(ligatureText)) this._rev.set(ligatureText, srcCode);
        }
      }
    }
    const code = this._rev.get(text);
    if (code === undefined) return null;
    const prog = this.program();
    if (prog && prog.sf && !prog.sf.cff) {
      const mergeable = this.mergeable();
      if (mergeable) {
        const gid = this.gid(code);
        if (!(
          gid > 0 &&
          mergeable.glyphs[gid] &&
          (mergeable.glyphs[gid].length || isSpaceCodePoint(text.codePointAt(0)))
        ))
          return null;
      }
    } else if (prog && /^[A-Z]{6}\+/.test(this.baseFont || '') && !this.seen.has(code)) return null;
    return code;
  }
  metrics() {
    const fd = this.fd;
    const read = (key, fallback) =>
      fd && fd.has(pdfName(key)) ? numberOf(fd.lookup(pdfName(key))) : fallback;
    return {
      ascent: read('Ascent', 800),
      descent: read('Descent', -200),
      capHeight: read('CapHeight', 700),
      italicAngle: read('ItalicAngle', 0),
    };
  }
}

export class PdfFontCache {
  constructor(ctx) {
    this.ctx = ctx;
    this.byRef = new Map();
  }
  get(ref, dict, key) {
    const refKey = ref ? ref.toString() : null;
    if (refKey && this.byRef.has(refKey)) return this.byRef.get(refKey);
    const font = new PdfFont(this.ctx, ref, dict, key);
    if (refKey) this.byRef.set(refKey, font);
    return font;
  }
}

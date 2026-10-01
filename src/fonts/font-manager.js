/**
 * Schriftfamilien des Dokuments, Schriftbibliothek und Auswahl der Schrift beim Schreiben.
 */
import { PDFName, PDFNumber, PDFString, StandardFontEmbedder, StandardFonts } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import { haveSameGlyphs, mergeFontSubsets } from './sfnt.js';
import { pdfName } from '../pdf/pdf-objects.js';
import { buildCffDisplayFont } from './cff.js';

let fontFaceSeq = 0;

const nextFontFaceName = () => 'pdfe-font-' + ++fontFaceSeq;

const hex4 = (n) => n.toString(16).padStart(4, '0').toUpperCase();

const randomSubsetTag = () =>
  Array.from({ length: 6 }, () => String.fromCharCode(65 + Math.floor(Math.random() * 26))).join('');

const isBlankChar = (ch) => ch === ' ' || ch === '\xA0' || ch === '\t';

export function parseFontName(baseFont) {
  const name = baseFont.replace(/^[A-Z]{6}\+/, '').replace(/-Identity-[HV]$/, '');
  const [familyPart, stylePart] = name.split(/[-,]/);
  const family = familyPart
    .replace(/([a-zA-Z])(?=[A-Z][a-z])/g, '$1 ')
    .replace(/(PS)?MT$|PS$/, '')
    .replace(/\s+/g, ' ')
    .replace(/^Deja Vu/, 'DejaVu')
    .trim();
  const style = (stylePart || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/MT$/, '')
    .trim();
  return {
    family,
    style: style || 'Regular',
    label: family + (style && style !== 'Regular' && style !== 'Roman' ? ' ' + style : ''),
  };
}

export const fontKey = (name) =>
  name
    .replace(/^[A-Z]{6}\+/, '')
    .replace(/-Identity-[HV]$/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/(regular|roman|mt|ps)$/, '');

const STANDARD_FAMILIES = [
  {
    key: 'std:Helvetica',
    std: StandardFonts.Helvetica,
    label: 'Helvetica',
    css: 'local("Arial"), local("Helvetica"), local("Liberation Sans"), local("Arimo")',
  },
  {
    key: 'std:Helvetica-Bold',
    std: StandardFonts.HelveticaBold,
    label: 'Helvetica Bold',
    css: 'local("Arial Bold"), local("Arial-BoldMT"), local("Helvetica Bold"), local("Liberation Sans Bold")',
    weight: 'bold',
  },
  {
    key: 'std:Times-Roman',
    std: StandardFonts.TimesRoman,
    label: 'Times',
    css: 'local("Times New Roman"), local("Times"), local("Liberation Serif"), local("Tinos")',
  },
  {
    key: 'std:Times-Bold',
    std: StandardFonts.TimesRomanBold,
    label: 'Times Bold',
    css: 'local("Times New Roman Bold"), local("TimesNewRomanPS-BoldMT"), local("Liberation Serif Bold")',
    weight: 'bold',
  },
  {
    key: 'std:Courier',
    std: StandardFonts.Courier,
    label: 'Courier',
    css: 'local("Courier New"), local("Courier"), local("Liberation Mono"), local("Cousine")',
  },
];

const standardEmbedders = new Map();

const standardEmbedder = (name) => (
  standardEmbedders.has(name) || standardEmbedders.set(name, StandardFontEmbedder.for(name)),
  standardEmbedders.get(name)
);

const standardWidth = (name, text) => {
  try {
    return standardEmbedder(name).widthOfTextAtSize(text, 1000);
  } catch {
    return 500;
  }
};

const standardCanEncode = (name, text) => {
  try {
    standardEmbedder(name).encodeText(text);
    return true;
  } catch {
    return false;
  }
};

function localFontSources(fam) {
  const name = fam.key.replace(/^[A-Z]{6}\+/, '');
  const nameInfo = parseFontName(name);
  const bold = fam.bold;
  const italic = fam.italic;
  const substitutes = /^(Helvetica|Arial)/i.test(name)
    ? ['Arial', 'Liberation Sans', 'Arimo', 'Helvetica']
    : /^Times/i.test(name)
      ? ['Times New Roman', 'Liberation Serif', 'Tinos', 'Times']
      : /^Courier/i.test(name)
        ? ['Courier New', 'Liberation Mono', 'Cousine', 'Courier']
        : [];
  const styleSuffix = bold && italic ? ' Bold Italic' : bold ? ' Bold' : italic ? ' Italic' : '';
  const names = [
    name,
    name.replace(/,/g, '-'),
    nameInfo.family + (nameInfo.style !== 'Regular' ? ' ' + nameInfo.style : ''),
    ...substitutes.map((o) => o + styleSuffix),
  ];
  return [...new Set(names)].map((o) => `local("${o.replace(/"/g, '')}")`).join(', ');
}

class FontFamily {
  constructor(key) {
    this.key = key;
    this.fonts = [];
    this.css = null;
    this.full = null;
    this.embedded = null;
    this.std = null;
    this.uses = 0;
  }
  get label() {
    return this.std ? this.stdLabel : parseFontName(this.key).label;
  }
  get sample() {
    return this.fonts[0];
  }
  get bold() {
    return this.std ? /Bold/.test(this.std) : this.sample ? this.sample.bold : false;
  }
  get italic() {
    return this.std ? /Oblique|Italic/.test(this.std) : this.sample ? this.sample.italic : false;
  }
  get serif() {
    return this.std ? /Times/.test(this.std) : this.sample ? this.sample.serif : false;
  }
  get mono() {
    return this.std ? /Courier/.test(this.std) : this.sample ? this.sample.mono : false;
  }
  add(font) {
    this.fonts.push(font);
    this._merged = undefined;
  }
  merged() {
    if (this._merged !== undefined) return this._merged;
    this._merged = null;
    if (this.std) return null;
    const parts = this.fonts.map((font) => font.mergeable()).filter(Boolean);
    const groups = [];
    for (const part of parts) {
      const group = groups.find((a) => haveSameGlyphs(a[0], part));
      if (group) group.push(part);
      else groups.push([part]);
    }
    groups.sort((i, n) => n.length - i.length);
    if (groups.length)
      try {
        this._merged = mergeFontSubsets(groups[0]);
        this._merged.source = groups[0][0].font;
      } catch (err) {
        console.warn('Zusammenführen fehlgeschlagen', this.key, err);
        this._merged = null;
      }
    return this._merged;
  }
  metrics() {
    if (this.std) return { ascent: 0.75, descent: -0.25 };
    const metrics = this.sample.metrics();
    return { ascent: metrics.ascent / 1000, descent: metrics.descent / 1000 };
  }
}

export class FontLibrary {
  constructor() {
    this.items = new Map();
  }
  add(data, source) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const fkFont = fontkit.create(bytes);
    const ps = fkFont.postscriptName || fkFont.fullName || 'Schrift' + this.items.size;
    const item = {
      ps,
      bytes,
      fk: fkFont,
      source,
      family: fkFont.familyName,
      style: fkFont.subfamilyName,
      uni: new Set(fkFont.characterSet),
      upm: fkFont.unitsPerEm,
    };
    this.items.set(fontKey(ps), item);
    return item;
  }
  find(name) {
    return this.items.get(fontKey(name)) || null;
  }
  list() {
    return [...this.items.values()];
  }
}

export class FontManager {
  constructor(doc, library) {
    this.doc = doc;
    this.library = library || new FontLibrary();
    this.fams = new Map();
    this.byCss = new Map();
    this.stdFonts = new Map();
    for (const std of STANDARD_FAMILIES) {
      const fam = new FontFamily(std.key);
      fam.std = std.std;
      fam.stdLabel = std.label;
      fam.stdCss = std.css;
      fam.weight = std.weight;
      fam._merged = null;
      this.fams.set(std.key, fam);
    }
  }
  family(font) {
    const psName = font.psName;
    if (!this.fams.has(psName)) this.fams.set(psName, new FontFamily(psName));
    const fam = this.fams.get(psName);
    if (!fam.fonts.includes(font)) fam.add(font);
    return fam;
  }
  get(key) {
    return this.fams.get(key) || null;
  }
  list() {
    return [...this.fams.values()]
      .filter((e) => !e.std && e.fonts.length)
      .sort((e, t) => t.uses - e.uses || e.label.localeCompare(t.label));
  }
  stdList() {
    return [...this.fams.values()].filter((e) => e.std);
  }
  fullFor(fam) {
    if (fam.std) return null;
    if (fam.full) return fam.full;
    const item = this.library.find(fam.key);
    if (item) fam.full = item;
    return fam.full;
  }
  setFull(fam, item) {
    fam.full = item;
    fam.fullCss = null;
    fam.embeddedFull = null;
  }
  charWriter(fam, ch) {
    if (fam.std)
      return standardCanEncode(fam.std, ch) || !isBlankChar(ch)
        ? { kind: 'std', name: fam.std, key: 'std:' + fam.std }
        : { kind: 'skip', key: 'skip' };
    const cp = ch.codePointAt(0);
    const merged = fam.merged();
    if (merged && merged.uni.has(cp)) return { kind: 'merged', fam, key: 'm' };
    {
      const font = fam.fonts.find((font2) => font2.codeFor(ch) !== null);
      if (font) return { kind: 'orig', font, key: 'o:' + (font.ref ? font.ref.toString() : font.baseFont) };
    }
    const full = this.fullFor(fam);
    if (full && full.uni.has(cp)) return { kind: 'full', fam, key: 'f' };
    if (isBlankChar(ch)) return { kind: 'skip', key: 'skip' };
    const fallback = this.fallbackName(fam);
    return { kind: 'fallback', name: fallback, key: 'fb:' + fallback };
  }
  plan(fam, text) {
    const runs = [];
    for (const ch of text) {
      const writer = this.charWriter(fam, ch);
      const last = runs[runs.length - 1];
      if (last && last.writer.key === writer.key) last.text += ch;
      else runs.push({ writer, text: ch });
    }
    return runs;
  }
  adv(fam, ch) {
    return this.advW(this.charWriter(fam, ch), fam, ch);
  }
  advW(writer, fam, ch) {
    switch (writer.kind) {
      case 'merged': {
        const merged = fam.merged();
        const gid = merged.uni.get(ch.codePointAt(0));
        return (merged.adv[gid] * 1000) / merged.upm;
      }
      case 'orig':
        return writer.font.width(writer.font.codeFor(ch));
      case 'full': {
        const full = fam.full;
        return (full.fk.glyphForCodePoint(ch.codePointAt(0)).advanceWidth * 1000) / full.upm;
      }
      case 'std':
      case 'fallback':
        return standardWidth(writer.name, standardCanEncode(writer.name, ch) ? ch : '?');
      default: {
        if (fam.std) return standardWidth(fam.std, ' ');
        const sample = fam.sample;
        const code = sample && sample.codeFor(' ');
        const width = code != null ? sample.width(code) : 0;
        return width > 0 ? width : fam.mono ? 600 : 250;
      }
    }
  }
  missing(fam, text) {
    return [...new Set([...text].filter((i) => i !== '\n' && this.charWriter(fam, i).kind === 'fallback'))];
  }
  fallbackName(fam) {
    return fam.mono
      ? fam.bold
        ? StandardFonts.CourierBold
        : StandardFonts.Courier
      : fam.serif
        ? fam.bold
          ? fam.italic
            ? StandardFonts.TimesRomanBoldItalic
            : StandardFonts.TimesRomanBold
          : fam.italic
            ? StandardFonts.TimesRomanItalic
            : StandardFonts.TimesRoman
        : fam.bold
          ? fam.italic
            ? StandardFonts.HelveticaBoldOblique
            : StandardFonts.HelveticaBold
          : fam.italic
            ? StandardFonts.HelveticaOblique
            : StandardFonts.Helvetica;
  }
  async ensureCss(fam) {
    if (fam.css) return fam.css;
    const cssName = nextFontFaceName();
    try {
      let face;
      if (fam.std) face = new FontFace(cssName, fam.stdCss);
      else {
        const merged = fam.merged();
        if (merged) face = new FontFace(cssName, merged.bytes, { weight: '1 1000' });
        else if (fam.fonts.every((font) => !font.program()))
          face = new FontFace(cssName, localFontSources(fam), { weight: '1 1000' });
        else {
          let best = null;
          for (const font of fam.fonts) {
            const cff = buildCffDisplayFont(font);
            if (cff && (!best || cff.uni.size > best.uni.size)) best = cff;
          }
          if (best) face = new FontFace(cssName, best.bytes, { weight: '1 1000' });
        }
      }
      if (face) {
        await face.load();
        document.fonts.add(face);
        fam.displayOk = true;
      } else fam.displayOk = false;
    } catch {
      fam.displayOk = false;
    }
    fam.css = cssName;
    this.byCss.set(cssName, fam);
    const full = this.fullFor(fam);
    if (full && !fam.fullCss) {
      const fullName = nextFontFaceName();
      try {
        const fullFace = new FontFace(fullName, full.bytes, { weight: '1 1000' });
        await fullFace.load();
        document.fonts.add(fullFace);
        fam.fullCss = fullName;
        this.byCss.set(fullName, fam);
      } catch {
        fam.fullCss = null;
      }
    }
    return fam.css;
  }
  cssStack(fam) {
    const stack = [`"${fam.css}"`];
    if (fam.fullCss) stack.push(`"${fam.fullCss}"`);
    stack.push(
      fam.mono
        ? '"Courier New", monospace'
        : fam.serif
          ? '"Times New Roman", serif'
          : 'Arial, "Helvetica Neue", sans-serif',
    );
    return stack.join(', ');
  }
  famFromCss(fontFamily) {
    const first = (fontFamily || '')
      .split(',')[0]
      .trim()
      .replace(/^["']|["']$/g, '');
    return this.byCss.get(first) || null;
  }
  async writerFont(writer) {
    return writer.kind === 'merged'
      ? this.embedMerged(writer.fam)
      : writer.kind === 'full'
        ? this.embedFull(writer.fam)
        : writer.kind === 'orig'
          ? this.origFont(writer.font)
          : this.stdFont(writer.name, writer.kind === 'fallback');
  }
  embedMerged(fam) {
    if (fam.embedded) return fam.embedded;
    const merged = fam.merged();
    const reusable = fam.fonts.find((font) => {
      if (!font.isType0 || !font.twoByte || !font.ref) return false;
      const mergeable = font.mergeable();
      if (!mergeable) return false;
      for (const [cp, gid] of merged.uni) if (mergeable.uni.get(cp) !== gid) return false;
      return true;
    });
    if (reusable) {
      const orig = this.origFont(reusable);
      fam.embedded = {
        ...orig,
        width: (ch) => {
          const gid = merged.uni.get(ch.codePointAt(0));
          return gid ? (merged.adv[gid] * 1000) / merged.upm : 0;
        },
      };
      return fam.embedded;
    }
    const context = this.doc.context;
    const source = merged.source;
    const scale = 1000 / merged.upm;
    const fontFile = context.register(context.flateStream(merged.bytes, { Length1: merged.bytes.length }));
    const baseFont = randomSubsetTag() + '+' + fam.key;
    const sourceFd = source.fd;
    const descriptor = context.obj({ Type: 'FontDescriptor', FontName: baseFont });
    if (sourceFd)
      for (const key of [
        'Flags',
        'FontBBox',
        'ItalicAngle',
        'Ascent',
        'Descent',
        'CapHeight',
        'StemV',
        'XHeight',
        'FontWeight',
        'Leading',
        'AvgWidth',
        'MaxWidth',
      ]) {
        const value = sourceFd.get(pdfName(key));
        if (value !== undefined) descriptor.set(pdfName(key), value);
      }
    if (!descriptor.has(pdfName('Flags'))) descriptor.set(pdfName('Flags'), PDFNumber.of(32));
    for (const [key, fallback] of [
      ['ItalicAngle', 0],
      ['Ascent', 800],
      ['Descent', -200],
      ['CapHeight', 700],
      ['StemV', 80],
    ])
      if (!descriptor.has(pdfName(key))) descriptor.set(pdfName(key), PDFNumber.of(fallback));
    if (!descriptor.has(pdfName('FontBBox')))
      descriptor.set(pdfName('FontBBox'), context.obj([-200, -300, 1200, 1000]));
    descriptor.set(pdfName('FontFile2'), fontFile);
    const descriptorRef = context.register(descriptor);
    const gids = [...new Set(merged.uni.values())].sort((w, S) => w - S);
    const widths = [];
    for (const gid of gids) {
      widths.push(gid);
      widths.push([Math.round(merged.adv[gid] * scale * 1000) / 1000]);
    }
    const cidFont = context.obj({
      Type: 'Font',
      Subtype: 'CIDFontType2',
      BaseFont: baseFont,
      CIDSystemInfo: { Registry: PDFString.of('Adobe'), Ordering: PDFString.of('Identity'), Supplement: 0 },
      FontDescriptor: descriptorRef,
      W: widths,
      CIDToGIDMap: 'Identity',
      DW: 0,
    });
    const cidFontRef = context.register(cidFont);
    let cmap = `/CIDInit /ProcSet findresource begin
12 dict begin
begincmap
/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def
/CMapName /Adobe-Identity-UCS def
/CMapType 2 def
1 begincodespacerange
<0000> <FFFF>
endcodespacerange
`;
    const pairs = [...merged.uni.entries()].filter(([w]) => w <= 65535).map(([w, S]) => [S, w]);
    const seenGids = new Set();
    const uniquePairs = pairs.filter(([w]) => (seenGids.has(w) ? false : seenGids.add(w)));
    for (let k = 0; k < uniquePairs.length; k += 100) {
      const chunk = uniquePairs.slice(k, k + 100);
      cmap +=
        chunk.length +
        ' beginbfchar\n' +
        chunk.map(([N, F]) => `<${hex4(N)}> <${hex4(F)}>`).join('\n') +
        '\nendbfchar\n';
    }
    cmap += `endcmap
CMapName currentdict /CMap defineresource pop
end
end`;
    const toUnicodeRef = context.register(context.flateStream(cmap));
    const fontRef = context.register(
      context.obj({
        Type: 'Font',
        Subtype: 'Type0',
        BaseFont: baseFont,
        Encoding: 'Identity-H',
        DescendantFonts: [cidFontRef],
        ToUnicode: toUnicodeRef,
      }),
    );
    fam.embedded = {
      ref: fontRef,
      twoByte: true,
      encode: (text) => {
        const bytes = [];
        for (const ch of text) {
          const gid = merged.uni.get(ch.codePointAt(0)) || 0;
          bytes.push(gid >> 8, gid & 255);
        }
        return Uint8Array.from(bytes);
      },
      width: (ch) => {
        const gid = merged.uni.get(ch.codePointAt(0));
        return gid ? merged.adv[gid] * scale : 0;
      },
    };
    return fam.embedded;
  }
  async embedFull(fam) {
    if (fam.embeddedFull) return fam.embeddedFull;
    const full = fam.full;
    const font = await this.doc.embedFont(full.bytes, { subset: false });
    fam.embeddedFull = {
      ref: font.ref,
      twoByte: true,
      pdfFont: font,
      encode: (text) => {
        let hex = '';
        for (const ch of text) hex += font.encodeText(ch).asString();
        const bytes = new Uint8Array(hex.length / 2);
        for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.substr(k * 2, 2), 16);
        return bytes;
      },
      width: (ch) => (full.fk.glyphForCodePoint(ch.codePointAt(0)).advanceWidth * 1000) / full.upm,
    };
    return fam.embeddedFull;
  }
  fixEmbeddedNames() {
    const context = this.doc.context;
    for (const fam of this.fams.values()) {
      const embeddedFull = fam.embeddedFull;
      if (!embeddedFull || !embeddedFull.ref) continue;
      const fontDict = context.lookup(embeddedFull.ref);
      if (!fontDict || !fontDict.get) continue;
      if (!fam.fullTag)
        fam.fullTag =
          randomSubsetTag() + '+' + (fam.full.ps || fam.key).replace(/[^\x21-\x7e]|[#()<>[\]{}/%]/g, '');
      const baseFont = PDFName.of(fam.fullTag);
      fontDict.set(pdfName('BaseFont'), baseFont);
      const descendants = fontDict.lookup(pdfName('DescendantFonts'));
      const cidFont = descendants && descendants.get ? context.lookup(descendants.get(0)) : null;
      if (cidFont && cidFont.set) {
        cidFont.set(pdfName('BaseFont'), baseFont);
        const descriptor = cidFont.lookup(pdfName('FontDescriptor'));
        if (descriptor && descriptor.set) descriptor.set(pdfName('FontName'), baseFont);
        if (
          fam.full.bytes &&
          fam.full.bytes[0] === 79 &&
          fam.full.bytes[1] === 84 &&
          fam.full.bytes[2] === 84 &&
          fam.full.bytes[3] === 79 &&
          descriptor &&
          descriptor.get
        ) {
          cidFont.set(pdfName('Subtype'), pdfName('CIDFontType0'));
          cidFont.delete(pdfName('CIDToGIDMap'));
          const fontFile = descriptor.get(pdfName('FontFile2'));
          if (fontFile) {
            const fontStream = context.lookup(fontFile);
            if (fontStream && fontStream.dict) {
              fontStream.dict.set(pdfName('Subtype'), pdfName('OpenType'));
              fontStream.dict.delete(pdfName('Length1'));
            }
            descriptor.delete(pdfName('FontFile2'));
            descriptor.set(pdfName('FontFile3'), fontFile);
          }
        }
      }
    }
  }
  origFont(font) {
    return {
      ref: font.ref,
      twoByte: font.twoByte,
      encode: (text) => {
        const bytes = [];
        for (const ch of text) {
          const code = font.codeFor(ch);
          if (font.twoByte) bytes.push(code >> 8, code & 255);
          else bytes.push(code);
        }
        return Uint8Array.from(bytes);
      },
      width: (ch) => font.width(font.codeFor(ch)),
    };
  }
  async stdFont(name, isFallback) {
    if (!this.stdFonts.has(name)) this.stdFonts.set(name, await this.doc.embedFont(name));
    const pdfFont = this.stdFonts.get(name);
    return {
      ref: pdfFont.ref,
      twoByte: false,
      pdfFont,
      fallback: isFallback ? name : null,
      encode: (text) => {
        let encodable = '';
        for (const ch of text) encodable += standardCanEncode(name, ch) ? ch : '?';
        const hex = pdfFont.encodeText(encodable).asString();
        const bytes = new Uint8Array(hex.length / 2);
        for (let k = 0; k < bytes.length; k++) bytes[k] = parseInt(hex.substr(k * 2, 2), 16);
        return bytes;
      },
      width: (ch) => standardWidth(name, standardCanEncode(name, ch) ? ch : '?'),
    };
  }
}

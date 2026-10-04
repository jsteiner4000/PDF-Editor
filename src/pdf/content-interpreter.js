/**
 * Interpretiert einen Content-Stream: Glyphen mit Position/Schrift/Farbe und Grafikobjekte (Pfade, Bilder, Formulare).
 */
import { PDFArray, PDFDict, PDFName, PDFNumber, PDFRef, PDFStream } from 'pdf-lib';
import { NameToken, StringToken } from './content-stream.js';
import { nameText, pdfName } from './pdf-objects.js';
import { IDENTITY_MATRIX, multiplyMatrix, toNumber, transformPoint } from './matrix.js';
import { PathRecorder } from './path-geometry.js';

function toRgb(colorSpace, components) {
  const values = components.map(toNumber);
  if (colorSpace === 'DeviceGray' || colorSpace === 'G' || colorSpace === 'CalGray' || colorSpace === 'N1')
    return [values[0], values[0], values[0]];
  if (colorSpace === 'DeviceCMYK' || colorSpace === 'CMYK' || colorSpace === 'N4') {
    const [c, m, y, k] = values;
    return [(1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)];
  }
  return colorSpace === 'DeviceRGB' ||
    colorSpace === 'RGB' ||
    colorSpace === 'CalRGB' ||
    colorSpace === 'N3' ||
    colorSpace === 'Lab'
    ? [values[0] || 0, values[1] || 0, values[2] || 0]
    : colorSpace === 'Sep'
      ? [1 - values[0], 1 - values[0], 1 - values[0]]
      : values.length >= 3
        ? values.slice(0, 3)
        : values.length === 1
          ? [values[0], values[0], values[0]]
          : [0, 0, 0];
}

function resolveColorSpace(ctx, resources, name) {
  if (['DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Pattern'].includes(name)) return name;
  const spaces = resources && resources.lookupMaybe(pdfName('ColorSpace'), PDFDict);
  const space = spaces && spaces.lookup(pdfName(name));
  if (space instanceof PDFName) return space.decodeText();
  if (space instanceof PDFArray) {
    const family = nameText(ctx.lookup(space.get(0)));
    if (family === 'ICCBased') {
      const iccStream = ctx.lookup(space.get(1));
      const numComponents = iccStream && iccStream.dict && iccStream.dict.lookup(pdfName('N'));
      return 'N' + (numComponents instanceof PDFNumber ? numComponents.asNumber() : 3);
    }
    return family === 'Separation' || family === 'DeviceN'
      ? 'Sep'
      : family === 'Indexed'
        ? 'Indexed'
        : family === 'Pattern'
          ? 'Pattern'
          : family;
  }
  return name;
}

/**
 * Interpretiert einen Content-Stream und liefert
 *   - `glyphs`: je Zeichen Position (x, y, ex, ey), Textmatrix, Schrift, Größe, Farbe, Unicode
 *     und Herkunft (Operator-Index `op`, Teil `part`, Zeichenindex `ci`)
 *   - `objects`: Grafikobjekte – je Malbefehl ein Pfad (`type: 'path'`, `start`/`end` =
 *     Operator-Indizes vom ersten Pfadoperator bis zum Malbefehl; Linien, Rechtecke und `re` sind
 *     also zunächst einzelne Objekte), Bilder (`image`, auch Inline-Bilder), Formulare (`form`)
 *     und Verläufe (`shading`); mit `bbox` (inkl. halber Linienbreite), `vis` (beschnitten),
 *     `clip`, `fill`/`stroke`, `color`, `ctm`, `depth`; Pfade zusätzlich mit `geom` (Teilpfade
 *     im Benutzerraum, siehe path-geometry.js), `lw` (Linienbreite in Seitenpunkten) und `evenOdd`
 *   - `fonts`, `qctm`: Schriftobjekte und die CTM bei jedem `q`.
 */
export function interpretContent(ctx, ops, resources, fontCache) {
  const glyphs = [];
  const objects = [];
  const fontsByName = new Map();
  const fontRefs = new Map();
  const fontDict = resources && resources.lookupMaybe(pdfName('Font'), PDFDict);
  if (fontDict)
    for (const [name, ref] of fontDict.entries()) {
      const dict = ctx.lookup(ref);
      if (dict instanceof PDFDict)
        fontRefs.set(name.decodeText(), { ref: ref instanceof PDFRef ? ref : null, dict });
    }
  const xobjects = resources && resources.lookupMaybe(pdfName('XObject'), PDFDict);
  const fontByName = (name) => {
    if (fontsByName.has(name)) return fontsByName.get(name);
    const entry = fontRefs.get(name);
    if (!entry) {
      fontsByName.set(name, null);
      return null;
    }
    const font = fontCache.get(entry.ref, entry.dict, name);
    fontsByName.set(name, font);
    return font;
  };
  let gs = {
    ctm: IDENTITY_MATRIX.slice(),
    fill: [0, 0, 0],
    stroke: [0, 0, 0],
    fcs: 'DeviceGray',
    scs: 'DeviceGray',
    lw: 1,
    Tc: 0,
    Tw: 0,
    Th: 1,
    TL: 0,
    font: null,
    fontName: null,
    fs: 0,
    Tr: 0,
    Ts: 0,
    fillAlpha: 1,
    clip: null,
  };
  const gsStack = [];
  let tm = IDENTITY_MATRIX.slice();
  let tlm = IDENTITY_MATRIX.slice();
  let pathBox = null;
  let pathStart = -1;
  const recorder = new PathRecorder();
  let clipPending = false;
  let inText = false;
  let qSeq = 0;
  const qCtm = new Map();
  const intersect = (a, b) =>
    b ? [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])] : a.slice();
  const addObject = (obj) => {
    obj.vis = obj.bbox ? intersect(obj.bbox, gs.clip) : gs.clip ? gs.clip.slice() : null;
    obj.clipRect = gs.clip ? gs.clip.slice() : null;
    obj.alpha = gs.fillAlpha;
    objects.push(obj);
  };
  const extend = (box, x, y) => {
    if (x < box[0]) box[0] = x;
    if (y < box[1]) box[1] = y;
    if (x > box[2]) box[2] = x;
    if (y > box[3]) box[3] = y;
  };
  const toPage = (x, y) => transformPoint(gs.ctm, x, y);
  const addPoint = (x, y) => {
    if (!pathBox) pathBox = [Infinity, Infinity, -Infinity, -Infinity];
    const pt = toPage(x, y);
    extend(pathBox, pt[0], pt[1]);
  };
  const showText = (opIndex, part, str) => {
    const font = gs.font;
    if (!font) return;
    const codes = font.decode(str.bytes);
    const metrics = font.metrics();
    codes.forEach((code, charIndex) => {
      font.seen.add(code);
      const trm = multiplyMatrix(multiplyMatrix([gs.fs * gs.Th, 0, 0, gs.fs, 0, gs.Ts], tm), gs.ctm);
      const width = font.width(code);
      let advance = ((width / 1000) * gs.fs + gs.Tc + (!font.twoByte && code === 32 ? gs.Tw : 0)) * gs.Th;
      if (font.vertical) advance = 0;
      const nextTm = multiplyMatrix([1, 0, 0, 1, advance, 0], tm);
      const start = transformPoint(multiplyMatrix(tm, gs.ctm), 0, gs.Ts);
      const end = transformPoint(multiplyMatrix(nextTm, gs.ctm), 0, gs.Ts);
      const size = Math.hypot(trm[2], trm[3]);
      glyphs.push({
        op: opIndex,
        part,
        ci: charIndex,
        code,
        uni: font.unicode(code),
        font,
        fontRes: gs.fontName,
        tfs: gs.fs,
        size,
        trm,
        x: trm[4],
        y: trm[5],
        ex: end[0],
        ey: end[1],
        w: width,
        asc: metrics.ascent / 1000,
        desc: metrics.descent / 1000,
        fill: gs.fill.slice(),
        mode: gs.Tr,
        alpha: gs.fillAlpha,
        Tc: gs.Tc,
        Tw: gs.Tw,
        Th: gs.Th,
        Ts: gs.Ts,
      });
      tm = nextTm;
    });
  };
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    const args = op.args;
    const operator = op.op;
    switch (operator) {
      case 'q':
        qCtm.set(k, gs.ctm.slice());
        gsStack.push({ ...gs, ctm: gs.ctm.slice(), fill: gs.fill.slice(), stroke: gs.stroke.slice() });
        gs.qid = ++qSeq;
        break;
      case 'Q':
        if (gsStack.length) gs = gsStack.pop();
        break;
      case 'cm':
        if (args.length >= 6) gs.ctm = multiplyMatrix(args.slice(0, 6).map(toNumber), gs.ctm);
        break;
      case 'w':
        gs.lw = toNumber(args[0]);
        break;
      case 'gs': {
        const extGStates = resources && resources.lookupMaybe(pdfName('ExtGState'), PDFDict);
        const extGState =
          extGStates && args[0] instanceof NameToken ? extGStates.lookup(pdfName(args[0].v)) : null;
        if (extGState instanceof PDFDict) {
          const alpha = extGState.lookup(pdfName('ca'));
          if (alpha instanceof PDFNumber) gs.fillAlpha = alpha.asNumber();
          const lineWidth = extGState.lookup(pdfName('LW'));
          if (lineWidth instanceof PDFNumber) gs.lw = lineWidth.asNumber();
          const fontEntry = extGState.lookup(pdfName('Font'));
          if (fontEntry instanceof PDFArray) {
            const fontRef = fontEntry.get(0);
            const fontObj = ctx.lookup(fontRef);
            if (fontObj instanceof PDFDict) {
              gs.font = fontCache.get(fontRef instanceof PDFRef ? fontRef : null, fontObj, null);
              gs.fs = toNumber(
                ctx.lookup(fontEntry.get(1)).asNumber ? ctx.lookup(fontEntry.get(1)).asNumber() : 0,
              );
            }
          }
        }
        break;
      }
      case 'g':
        gs.fcs = 'DeviceGray';
        gs.fill = toRgb('DeviceGray', args);
        break;
      case 'G':
        gs.scs = 'DeviceGray';
        gs.stroke = toRgb('DeviceGray', args);
        break;
      case 'rg':
        gs.fcs = 'DeviceRGB';
        gs.fill = toRgb('DeviceRGB', args);
        break;
      case 'RG':
        gs.scs = 'DeviceRGB';
        gs.stroke = toRgb('DeviceRGB', args);
        break;
      case 'k':
        gs.fcs = 'DeviceCMYK';
        gs.fill = toRgb('DeviceCMYK', args);
        break;
      case 'K':
        gs.scs = 'DeviceCMYK';
        gs.stroke = toRgb('DeviceCMYK', args);
        break;
      case 'cs':
        gs.fcs = args[0] instanceof NameToken ? resolveColorSpace(ctx, resources, args[0].v) : 'DeviceGray';
        gs.fill = [0, 0, 0];
        break;
      case 'CS':
        gs.scs = args[0] instanceof NameToken ? resolveColorSpace(ctx, resources, args[0].v) : 'DeviceGray';
        gs.stroke = [0, 0, 0];
        break;
      case 'sc':
      case 'scn':
        gs.fill = toRgb(
          gs.fcs,
          args.filter((q) => typeof q == 'number'),
        );
        break;
      case 'SC':
      case 'SCN':
        gs.stroke = toRgb(
          gs.scs,
          args.filter((q) => typeof q == 'number'),
        );
        break;
      case 'm':
      case 'l': {
        if (pathStart < 0) pathStart = k;
        const x = toNumber(args[0]);
        const y = toNumber(args[1]);
        addPoint(x, y);
        if (operator === 'm') recorder.moveTo(k, x, y);
        else recorder.lineTo(k, x, y);
        break;
      }
      case 'c': {
        if (pathStart < 0) pathStart = k;
        const [x1, y1, x2, y2, x3, y3] = [0, 1, 2, 3, 4, 5].map((i) => toNumber(args[i]));
        addPoint(x1, y1);
        addPoint(x2, y2);
        addPoint(x3, y3);
        recorder.curveTo(k, [x1, y1], [x2, y2], [x3, y3]);
        break;
      }
      case 'v':
      case 'y': {
        if (pathStart < 0) pathStart = k;
        const [x1, y1, x2, y2] = [0, 1, 2, 3].map((i) => toNumber(args[i]));
        addPoint(x1, y1);
        addPoint(x2, y2);
        if (operator === 'v') recorder.curveTo(k, recorder.currentPoint().slice(), [x1, y1], [x2, y2]);
        else recorder.curveTo(k, [x1, y1], [x2, y2], [x2, y2]);
        break;
      }
      case 're': {
        if (pathStart < 0) pathStart = k;
        const [x, y, w, h] = args.map(toNumber);
        addPoint(x, y);
        addPoint(x + w, y);
        addPoint(x, y + h);
        addPoint(x + w, y + h);
        recorder.rect(k, x, y, w, h);
        break;
      }
      case 'h':
        recorder.close(k);
        break;
      case 'W':
      case 'W*':
        clipPending = true;
        break;
      case 'S':
      case 's':
      case 'f':
      case 'F':
      case 'f*':
      case 'B':
      case 'B*':
      case 'b':
      case 'b*':
      case 'n': {
        if (pathBox && clipPending) gs.clip = intersect(pathBox, gs.clip);
        if (pathBox && pathStart >= 0 && operator !== 'n') {
          const stroke = /^[SsBb]/.test(operator);
          const fill = operator !== 'S' && operator !== 's';
          const scale = Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2]));
          const halfWidth = stroke ? (gs.lw * scale) / 2 : 0;
          addObject({
            type: 'path',
            start: pathStart,
            end: k,
            bbox: [
              pathBox[0] - halfWidth,
              pathBox[1] - halfWidth,
              pathBox[2] + halfWidth,
              pathBox[3] + halfWidth,
            ],
            clip: clipPending,
            fill,
            stroke,
            color: fill ? gs.fill.slice() : gs.stroke.slice(),
            ctm: gs.ctm.slice(),
            depth: gsStack.length,
            geom: recorder.take(),
            lw: stroke ? gs.lw * scale : 0,
            evenOdd: operator.endsWith('*'),
          });
        }
        recorder.reset();
        pathBox = null;
        pathStart = -1;
        clipPending = false;
        break;
      }
      case 'BT':
        inText = true;
        tm = IDENTITY_MATRIX.slice();
        tlm = IDENTITY_MATRIX.slice();
        break;
      case 'ET':
        inText = false;
        break;
      case 'Tc':
        gs.Tc = toNumber(args[0]);
        break;
      case 'Tw':
        gs.Tw = toNumber(args[0]);
        break;
      case 'Tz':
        gs.Th = toNumber(args[0]) / 100;
        break;
      case 'TL':
        gs.TL = toNumber(args[0]);
        break;
      case 'Ts':
        gs.Ts = toNumber(args[0]);
        break;
      case 'Tr':
        gs.Tr = toNumber(args[0]);
        break;
      case 'Tf':
        gs.fontName = args[0] instanceof NameToken ? args[0].v : null;
        gs.font = gs.fontName ? fontByName(gs.fontName) : null;
        gs.fs = toNumber(args[1]);
        break;
      case 'Td':
        tlm = multiplyMatrix([1, 0, 0, 1, toNumber(args[0]), toNumber(args[1])], tlm);
        tm = tlm.slice();
        break;
      case 'TD':
        gs.TL = -toNumber(args[1]);
        tlm = multiplyMatrix([1, 0, 0, 1, toNumber(args[0]), toNumber(args[1])], tlm);
        tm = tlm.slice();
        break;
      case 'Tm':
        tlm = args.slice(0, 6).map(toNumber);
        tm = tlm.slice();
        break;
      case 'T*':
        tlm = multiplyMatrix([1, 0, 0, 1, 0, -gs.TL], tlm);
        tm = tlm.slice();
        break;
      case 'Tj':
        if (args[0] instanceof StringToken) showText(k, 0, args[0]);
        break;
      case "'":
        tlm = multiplyMatrix([1, 0, 0, 1, 0, -gs.TL], tlm);
        tm = tlm.slice();
        if (args[0] instanceof StringToken) showText(k, 0, args[0]);
        break;
      case '"':
        gs.Tw = toNumber(args[0]);
        gs.Tc = toNumber(args[1]);
        tlm = multiplyMatrix([1, 0, 0, 1, 0, -gs.TL], tlm);
        tm = tlm.slice();
        if (args[2] instanceof StringToken) showText(k, 0, args[2]);
        break;
      case 'TJ': {
        (Array.isArray(args[0]) ? args[0] : []).forEach((U, L) => {
          if (U instanceof StringToken) showText(k, L, U);
          else if (typeof U == 'number')
            tm = multiplyMatrix([1, 0, 0, 1, (-U / 1000) * gs.fs * gs.Th, 0], tm);
        });
        break;
      }
      case 'Do': {
        const xName = args[0] instanceof NameToken ? args[0].v : null;
        const xobj = xName && xobjects ? xobjects.lookup(pdfName(xName)) : null;
        const stream = xobj instanceof PDFStream ? xobj : null;
        const subtype = stream ? nameText(stream.dict.get(pdfName('Subtype'))) : null;
        if (subtype === 'Image') {
          const corners = [
            transformPoint(gs.ctm, 0, 0),
            transformPoint(gs.ctm, 1, 0),
            transformPoint(gs.ctm, 0, 1),
            transformPoint(gs.ctm, 1, 1),
          ];
          const box = [Infinity, Infinity, -Infinity, -Infinity];
          corners.forEach((j) => extend(box, j[0], j[1]));
          addObject({
            type: 'image',
            start: k,
            end: k,
            bbox: box,
            name: xName,
            ctm: gs.ctm.slice(),
            depth: gsStack.length,
            ref: xobjects.get(pdfName(xName)),
          });
        } else if (subtype === 'Form') {
          const bbox = stream.dict.lookupMaybe(pdfName('BBox'), PDFArray);
          const matrix = stream.dict.lookupMaybe(pdfName('Matrix'), PDFArray);
          const formMatrix = matrix
            ? matrix.asArray().map((ke) => toNumber(ctx.lookup(ke).asNumber ? ctx.lookup(ke).asNumber() : 0))
            : IDENTITY_MATRIX;
          const bboxValues = bbox ? bbox.asArray().map((ke) => ctx.lookup(ke).asNumber()) : [0, 0, 0, 0];
          const toPageMatrix = multiplyMatrix(formMatrix, gs.ctm);
          const box = [Infinity, Infinity, -Infinity, -Infinity];
          [
            [bboxValues[0], bboxValues[1]],
            [bboxValues[2], bboxValues[1]],
            [bboxValues[0], bboxValues[3]],
            [bboxValues[2], bboxValues[3]],
          ].forEach(([ke, we]) => {
            const pt = transformPoint(toPageMatrix, ke, we);
            extend(box, pt[0], pt[1]);
          });
          addObject({
            type: 'form',
            start: k,
            end: k,
            bbox: box,
            name: xName,
            ctm: gs.ctm.slice(),
            depth: gsStack.length,
            ref: xobjects.get(pdfName(xName)),
          });
        }
        break;
      }
      case 'BI': {
        const corners = [
          transformPoint(gs.ctm, 0, 0),
          transformPoint(gs.ctm, 1, 0),
          transformPoint(gs.ctm, 0, 1),
          transformPoint(gs.ctm, 1, 1),
        ];
        const box = [Infinity, Infinity, -Infinity, -Infinity];
        corners.forEach((L) => extend(box, L[0], L[1]));
        addObject({
          type: 'image',
          inline: true,
          start: k,
          end: k,
          bbox: box,
          ctm: gs.ctm.slice(),
          depth: gsStack.length,
        });
        break;
      }
      case 'sh':
        addObject({
          type: 'shading',
          start: k,
          end: k,
          bbox: null,
          ctm: gs.ctm.slice(),
          depth: gsStack.length,
        });
        break;
      default:
        break;
    }
  }
  return { glyphs, objects, fonts: fontsByName, qctm: qCtm };
}

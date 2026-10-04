/**
 * Dokumentmodell (PdfSession): Seitenmodelle, Bearbeitungsoperationen auf Content-Streams, Undo/Redo, Speichern.
 */
import { PDFArray, PDFDict, PDFDocument, PDFNumber, PDFRawStream, PDFRef, PDFStream, degrees } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import {
  bytesToHexString,
  bytesToLatin1,
  ContentOp,
  formatNumber,
  latin1ToBytes,
  NameToken,
  newOp,
  parseContentStream,
  serializeOps,
  StringToken,
} from './content-stream.js';
import { nameText, pdfName, readStreamBytes } from './pdf-objects.js';
import { PdfFontCache } from './pdf-font.js';
import { IDENTITY_MATRIX, invertMatrix, multiplyMatrix } from './matrix.js';
import { interpretContent } from './content-interpreter.js';
import { subpathOps, transformSubpaths, userMatrix } from './path-geometry.js';
import { buildTextBlocks, buildTextLines } from './text-layout.js';
import { FontManager } from '../fonts/font-manager.js';

/**
 * Korrigiert Streams, deren /Length um 1–2 Byte zu groß angegeben ist (pdf-lib kürzt den
 * Inhalt sonst): sucht die Rohdaten in der Originaldatei und übernimmt die vollständige Länge.
 */
function repairStreamLengths(doc, fileBytes) {
  const context = doc.context;
  const indexOf = (needle, from) => {
    const len = needle.length;
    const first = needle[0];
    for (
      let pos = fileBytes.indexOf(first, from);
      pos >= 0 && pos <= fileBytes.length - len;
      pos = fileBytes.indexOf(first, pos + 1)
    ) {
      let k = 1;
      while (k < len && fileBytes[pos + k] === needle[k]) k++;
      if (k === len) return pos;
    }
    return -1;
  };
  for (const [, stream] of context.enumerateIndirectObjects()) {
    if (!(stream instanceof PDFRawStream)) continue;
    let lengthObj = stream.dict.get(pdfName('Length'));
    if (lengthObj instanceof PDFRef) lengthObj = context.lookup(lengthObj);
    if (!(lengthObj instanceof PDFNumber)) continue;
    const declared = lengthObj.asNumber();
    const actual = stream.contents.length;
    if (declared <= actual || declared - actual > 2 || actual < 16) continue;
    const start = indexOf(stream.contents.subarray(0, Math.min(64, actual)), 0);
    if (start < 0 || start + declared > fileBytes.length) continue;
    const candidate = fileBytes.subarray(start, start + declared);
    let matches = true;
    for (let k = 0; k < actual && matches; k++) if (candidate[k] !== stream.contents[k]) matches = false;
    if (matches) stream.contents = candidate.slice();
  }
}

/**
 * Gruppiert auswählbare Grafikobjekte (Union-Find) zu Clustern: Objekte, deren sichtbare
 * Rechtecke (`vis`) sich mit 1 pt Toleranz berühren, gehören zusammen. Ausgenommen sind Bilder und
 * der Fall, dass ein Objekt ein mindestens 6-mal kleineres vollständig umschließt (Rahmen um
 * Inhalt). Ergebnis: `obj.cluster = { members, bbox }` – ein Klick wählt die ganze Gruppe.
 * Ausnahme: Strichgitter aus mehr als 8 ungefüllten Pfaden werden nicht gruppiert.
 *
 * Die Gruppierung wird nur einmal je Seite für den ursprünglichen Inhalt berechnet und danach über
 * die Objekt-Identität (`uid`) weitergeführt (siehe PdfSession.objectIdentity): Verschieben oder
 * Einrasten an ein Nachbarobjekt erzeugt nie neue Gruppen.
 */
function clusterObjects(objects) {
  const count = objects.length;
  const parent = objects.map((o, l) => l);
  const find = (k) => {
    while (parent[k] !== k) {
      parent[k] = parent[parent[k]];
      k = parent[k];
    }
    return k;
  };
  const tolerance = 1;
  const touches = (a, b) =>
    a[0] <= b[2] + tolerance &&
    b[0] <= a[2] + tolerance &&
    a[1] <= b[3] + tolerance &&
    b[1] <= a[3] + tolerance;
  const contains = (outer, inner) =>
    outer[0] <= inner[0] + 0.5 &&
    outer[1] <= inner[1] + 0.5 &&
    outer[2] >= inner[2] - 0.5 &&
    outer[3] >= inner[3] - 0.5;
  if (count <= 4000) {
    const order = objects.map((l, c) => c).sort((l, c) => objects[l].vis[0] - objects[c].vis[0]);
    for (let k = 0; k < count; k++) {
      const a = objects[order[k]];
      for (let j = k + 1; j < count; j++) {
        const b = objects[order[j]];
        if (b.vis[0] > a.vis[2] + tolerance) break;
        if (touches(a.vis, b.vis)) {
          if (!(
            (contains(a.vis, b.vis) && a.area > 6 * b.area) ||
            (contains(b.vis, a.vis) && b.area > 6 * a.area) ||
            a.type === 'image' ||
            b.type === 'image'
          ))
            parent[find(order[k])] = find(order[j]);
        }
      }
    }
  }
  const clusters = new Map();
  objects.forEach((obj, k) => {
    const root = find(k);
    if (!clusters.has(root)) clusters.set(root, []);
    clusters.get(root).push(obj);
  });
  // Reine Strichgitter (Tabellen, Raster: mehr als 8 Teile, alles ungefüllte Pfade) sind keine
  // sinnvolle Einheit – jede Linie bleibt einzeln wählbar. Kleine Gruppen (Rechteck aus vier Linien,
  // Kreisnummer mit Linie) und alles mit Flächen, Bildern oder Formularen bleiben Gruppen.
  const groups = [];
  for (const members of clusters.values()) {
    if (members.length > 8 && members.every((m) => m.type === 'path' && !m.fill))
      groups.push(...members.map((m) => [m]));
    else groups.push(members);
  }
  attachClusters(groups);
}

/** Setzt `obj.cluster = { members, bbox }` für jede Gruppe (Liste von Objektlisten). */
function attachClusters(groups) {
  for (const members of groups) {
    const bbox = [Infinity, Infinity, -Infinity, -Infinity];
    members.forEach((h) => {
      bbox[0] = Math.min(bbox[0], h.vis[0]);
      bbox[1] = Math.min(bbox[1], h.vis[1]);
      bbox[2] = Math.max(bbox[2], h.vis[2]);
      bbox[3] = Math.max(bbox[3], h.vis[3]);
    });
    const cluster = { members, bbox };
    members.forEach((h) => {
      h.cluster = cluster;
    });
  }
}

/** Gruppen aus einer gespeicherten Zuordnung uid → Gruppenkennung (neue Objekte: einzeln). */
function applyClusters(objects, clusterOf) {
  const groups = new Map();
  for (const obj of objects) {
    const cid = clusterOf.has(obj.uid) ? clusterOf.get(obj.uid) : 'u' + obj.uid;
    if (!groups.has(cid)) groups.set(cid, []);
    groups.get(cid).push(obj);
  }
  attachClusters(groups.values());
}

/**
 * Wandelt einen Textblock in Zeilen mit Segmenten gleicher Schrift/Größe/Farbe um (das Format,
 * das `commitEdit()` schreibt); `dx`/`dy` verschieben den Text dabei.
 */
export function blockToEditLines(block, dx = 0, dy = 0) {
  return block.lines.map((line) => {
    const segs = [];
    for (const item of line.items) {
      const key = item.virtual
        ? null
        : [item.fam.key, item.size.toFixed(3), item.fill.join(','), item.y.toFixed(3), item.alpha].join('|');
      let seg = segs[segs.length - 1];
      if (!seg || (key && seg.key !== key)) {
        if (item.virtual && seg) {
          seg.text += ' ';
          seg.xs.push(item.x + dx);
          continue;
        }
        if (item.virtual) continue;
        seg = {
          key,
          x: item.x + dx,
          y: item.y + dy,
          text: '',
          xs: [],
          fam: item.fam,
          size: item.size,
          color: item.fill,
          alpha: item.alpha,
        };
        segs.push(seg);
      }
      [...item.uni].forEach((o, l) => {
        seg.text += o;
        seg.xs.push(l ? null : item.x + dx);
      });
    }
    return { segs };
  });
}

/**
 * Ein geöffnetes Dokument (pdf-lib) mit Seitenmodellen und Änderungsverlauf.
 *
 * Seitenmodell `model(index)` (zwischengespeichert, bis sich der Content-Stream ändert):
 *   { page, key, src, ops, glyphs, lines, blocks, objects, fonts, qctm }
 *   - `ops`: geparster Content-Stream (ContentOp[]), Änderungen werden als neuer Stream geschrieben
 *   - `blocks`: Textblöcke (siehe text-layout.js)
 *   - `objects`: Grafikobjekte aus interpretContent() mit zusätzlich `uid`, `id`, `area`,
 *     `background`, `selectable` und `cluster` (siehe clusterObjects)
 *
 * Objekt-Identität: `uid` bleibt für ein Grafikobjekt über alle Änderungen gleich (Verschieben,
 * Größe, Pfad bearbeiten, Text bearbeiten, Rückgängig). Grundlage ist die Reihenfolge der
 * Malbefehle (n-tes S/f/B/Do/BI/sh); jede Änderung am Content-Stream gibt an, wie sich diese
 * Reihenfolge ändert (Löschen, Ebenen). Gespeichert wird die Zuordnung je Contents-Objekt, daher
 * stellt Rückgängig/Wiederholen sie automatisch mit wieder her.
 *
 * Rückgängig/Wiederholen: `hist.undo`/`hist.redo` (max. 200 Einträge). Einträge:
 *   - `{ kind: 'content', label, before: [snap], after: [snap], page }` – Seiteninhalt
 *   - `{ kind: 'pages', label, before, after, beforeSnaps, afterSnaps }` – Seitenreihenfolge
 *   - `{ kind: 'multi', label, entries }` – aus `batch()` zusammengefasst
 *   Ein Snapshot (`snap()`) merkt sich Contents, Resources und Rotate einer Seite.
 * `version`/`savedVersion` ergeben `dirty`.
 */
export class PdfSession {
  /**
   * Lädt ein PDF (ohne Metadaten zu ändern), registriert fontkit und repariert Stream-Längen.
   */
  static async open(bytes, opts = {}) {
    const doc = await PDFDocument.load(bytes, {
      updateMetadata: false,
      ignoreEncryption: !!opts.ignoreEncryption,
    });
    doc.registerFontkit(fontkit);
    repairStreamLengths(doc, bytes);
    return new PdfSession(doc, opts.library);
  }
  constructor(doc, library) {
    this.doc = doc;
    this.ctx = doc.context;
    this.fontCache = new PdfFontCache(this.ctx);
    this.fonts = new FontManager(doc, library);
    this.models = new Map();
    this.hist = { undo: [], redo: [] };
    this.version = 0;
    this.savedVersion = 0;
    this.pending = null;
    this.nameSeq = 0;
    this.idents = new WeakMap();
    this.uidSeq = 0;
    this.modelSeq = 0;
    for (const [ref, obj] of this.ctx.enumerateIndirectObjects())
      if (
        obj instanceof PDFDict &&
        nameText(obj.get(pdfName('Type'))) === 'Font' &&
        ['Type0', 'TrueType', 'Type1', 'MMType1'].includes(nameText(obj.get(pdfName('Subtype'))))
      )
        try {
          this.fonts.family(this.fontCache.get(ref, obj, null));
        } catch {}
  }
  get dirty() {
    return this.version !== this.savedVersion;
  }
  get numPages() {
    return this.doc.getPageCount();
  }
  page(index) {
    return this.doc.getPage(index);
  }
  pageInfo(index) {
    const page = this.page(index);
    const mediaBox = page.getMediaBox();
    const cropBox = page.getCropBox();
    return {
      w: cropBox.width,
      h: cropBox.height,
      x: cropBox.x,
      y: cropBox.y,
      rotate: page.getRotation().angle % 360,
      media: mediaBox,
    };
  }
  contentSrc(page) {
    const contents = page.node.get(pdfName('Contents'));
    if (!contents) return '';
    const resolved = this.ctx.lookup(contents);
    return (resolved instanceof PDFArray ? resolved.asArray() : [contents])
      .map((a) => {
        try {
          return bytesToLatin1(readStreamBytes(this.ctx, a) || new Uint8Array(0));
        } catch {
          return '';
        }
      })
      .join('\n');
  }
  /**
   * Schreibt einen neuen Content-Stream. `derive(base)` beschreibt, wie sich die Objekt-Identität
   * ändert (`{ uids, types, clusters }` → neue Fassung); ohne Angabe bleibt die Reihenfolge der
   * Malbefehle erhalten und neu hinzugekommene Objekte am Ende bekommen neue Kennungen.
   */
  setContentSrc(page, src, derive = null) {
    const parent = this.idents.get(this.contentsKey(page)) || null;
    const ref = this.ctx.register(this.ctx.flateStream(latin1ToBytes(src)));
    page.node.set(pdfName('Contents'), ref);
    this.idents.set(ref, { parent, derive });
    this.models.delete(page.ref.toString());
  }
  contentsKey(page) {
    return page.node.get(pdfName('Contents')) || page.node;
  }
  identityChain(ident) {
    if (!ident) return null;
    if (ident.uids) return ident;
    const base = this.identityChain(ident.parent);
    if (!base) return null;
    return ident.derive ? ident.derive(base) : base;
  }
  /**
   * Objekt-Identität für den aktuellen Content-Stream einer Seite: vergibt `uid` an alle Objekte
   * (Reihenfolge der Malbefehle) und liefert die Gruppenzuordnung (`clusters`, null = neu berechnen).
   */
  objectIdentity(page, objects) {
    const key = this.contentsKey(page);
    let ident = this.idents.get(key);
    if (!ident) {
      ident = { parent: null, derive: null };
      this.idents.set(key, ident);
    }
    if (!ident.uids) {
      const base = this.identityChain(ident.parent ? ident : null);
      const uids = [];
      const types = [];
      objects.forEach((obj, k) => {
        const reuse = base && k < base.uids.length && base.types[k] === obj.type;
        uids.push(reuse ? base.uids[k] : ++this.uidSeq);
        types.push(obj.type);
      });
      ident.uids = uids;
      ident.types = types;
      ident.clusters = base ? base.clusters : null;
      ident.parent = null;
      ident.derive = null;
    }
    objects.forEach((obj, k) => {
      obj.uid = ident.uids[k];
    });
    return ident;
  }
  /**
   * Seitenmodell: Content-Stream parsen und interpretieren, Text in Zeilen/Blöcke gliedern,
   * Grafikobjekte bewerten (Hintergrund > 80 % der Seite, Clip-Pfade nicht auswählbar) und gruppieren.
   */
  model(index) {
    const page = this.page(index);
    const key = page.ref.toString();
    if (this.models.has(key)) return this.models.get(key);
    const src = this.contentSrc(page);
    const ops = parseContentStream(src);
    const resources = page.node.Resources();
    const content = interpretContent(this.ctx, ops, resources, this.fontCache);
    for (const glyph of content.glyphs) {
      glyph.fam = this.fonts.family(glyph.font);
      glyph.fam.uses++;
    }
    const lines = buildTextLines(content.glyphs);
    const blocks = buildTextBlocks(lines);
    blocks.forEach((d, I) => {
      d.id = key + '#' + I;
      d.fam = d.glyphs[0].fam;
    });
    const info = this.pageInfo(index);
    const pageArea = info.w * info.h;
    const ident = this.objectIdentity(page, content.objects);
    const objects = content.objects
      .filter((obj) => obj.vis && isFinite(obj.vis[0]))
      .map((obj) => {
        const vis = obj.vis;
        const area = Math.max(0, vis[2] - vis[0]) * Math.max(0, vis[3] - vis[1]);
        const isBackground = (obj.type === 'path' || obj.type === 'shading') && area > pageArea * 0.8;
        return {
          ...obj,
          id: key + '@' + obj.uid,
          area,
          background: isBackground,
          selectable:
            !isBackground &&
            !(obj.type === 'path' && obj.clip) &&
            vis[2] - vis[0] > 0.05 &&
            vis[3] - vis[1] > 0.05,
        };
      });
    const selectable = objects.filter((d) => d.selectable);
    if (ident.clusters) applyClusters(selectable, ident.clusters);
    else {
      clusterObjects(selectable);
      ident.clusters = new Map(selectable.map((obj) => [obj.uid, obj.cluster.members[0].uid]));
    }
    const model = {
      page,
      key,
      src,
      ops,
      version: ++this.modelSeq,
      allObjects: content.objects,
      glyphs: content.glyphs,
      lines,
      blocks,
      objects,
      fonts: content.fonts,
      qctm: content.qctm,
    };
    this.models.set(key, model);
    return model;
  }
  ownResources(page) {
    const original = page.node.get(pdfName('Resources'));
    const resources = page.node.Resources() || this.ctx.obj({});
    const copy = this.ctx.obj({});
    for (const [key, value] of resources.entries()) {
      const resolved = this.ctx.lookup(value);
      if (['Font', 'XObject', 'ExtGState'].includes(key.decodeText()) && resolved instanceof PDFDict) {
        const dictCopy = this.ctx.obj({});
        for (const [entryKey, entryValue] of resolved.entries()) dictCopy.set(entryKey, entryValue);
        copy.set(key, dictCopy);
      } else copy.set(key, value);
    }
    page.node.set(pdfName('Resources'), copy);
    return copy;
  }
  addResource(page, category, ref, prefix) {
    const resources = this.ownResources(page);
    let dict = resources.get(pdfName(category));
    if (!(dict instanceof PDFDict)) {
      dict = this.ctx.obj({});
      resources.set(pdfName(category), dict);
    }
    for (const [existingName, existingRef] of dict.entries())
      if (existingRef instanceof PDFRef && existingRef.toString() === ref.toString())
        return existingName.decodeText();
    let name;
    do name = prefix + ++this.nameSeq;
    while (dict.has(pdfName(name)));
    dict.set(pdfName(name), ref);
    return name;
  }
  snap(page) {
    return {
      page,
      contents: page.node.get(pdfName('Contents')),
      resources: page.node.get(pdfName('Resources')),
      rotate: page.node.get(pdfName('Rotate')),
    };
  }
  restoreSnap(snapshot) {
    const restore = (key, value) => {
      if (value === undefined) snapshot.page.node.delete(pdfName(key));
      else snapshot.page.node.set(pdfName(key), value);
    };
    restore('Contents', snapshot.contents);
    restore('Resources', snapshot.resources);
    restore('Rotate', snapshot.rotate);
    this.models.delete(snapshot.page.ref.toString());
  }
  removePage(index) {
    this.doc.removePage(index);
    if (this.doc.pageCache && this.doc.pageCache.invalidate) this.doc.pageCache.invalidate();
  }
  pageOrder() {
    return this.doc.getPages().slice();
  }
  setPageOrder(pages) {
    const count = this.doc.getPageCount();
    for (let k = count - 1; k >= 0; k--) this.removePage(k);
    pages.forEach((i, n) => this.doc.insertPage(n, i));
  }
  /**
   * Fasst alle während `fn` erzeugten Verlaufseinträge zu einem Eintrag zusammen.
   */
  async batch(label, fn) {
    if (this._batch) return fn();
    const batch = (this._batch = { entries: [] });
    try {
      await fn();
    } finally {
      this._batch = null;
    }
    if (!batch.entries.length) return;
    if (batch.entries.length === 1) {
      const entry = batch.entries[0];
      entry.label = label || entry.label;
      this.push(entry);
      return;
    }
    if (batch.entries.some((entry) => entry.kind !== 'content')) {
      this.push({ kind: 'multi', label, entries: batch.entries });
      return;
    }
    const beforeByPage = new Map();
    const pageByKey = new Map();
    for (const entry of batch.entries)
      for (const snapshot of entry.before) {
        const key = snapshot.page.ref.toString();
        if (!beforeByPage.has(key)) {
          beforeByPage.set(key, snapshot);
          pageByKey.set(key, snapshot.page);
        }
      }
    this.push({
      kind: 'content',
      label,
      before: [...beforeByPage.values()],
      after: [...pageByKey.values()].map((A) => this.snap(A)),
      page: batch.entries[0].page,
    });
  }
  /**
   * Neuer Verlaufseintrag; leert „Wiederholen“, begrenzt auf 200 Einträge.
   */
  push(entry) {
    if (this._batch) {
      this._batch.entries.push(entry);
      this.version++;
      return;
    }
    this.hist.undo.push(entry);
    if (this.hist.undo.length > 200) this.hist.undo.shift();
    this.hist.redo.length = 0;
    this.version++;
  }
  applyEntry(entry, direction) {
    if (entry.kind === 'content')
      (direction === 'undo' ? entry.before : entry.after).forEach((i) => this.restoreSnap(i));
    else if (entry.kind === 'multi')
      (direction === 'undo' ? entry.entries.slice().reverse() : entry.entries).forEach((n) =>
        this.applyEntry(n, direction),
      );
    else if (entry.kind === 'pages') {
      this.setPageOrder(direction === 'undo' ? entry.before : entry.after);
      (direction === 'undo' ? entry.beforeSnaps : entry.afterSnaps || []).forEach((i) => this.restoreSnap(i));
    }
  }
  undo() {
    const entry = this.hist.undo.pop();
    return entry ? (this.applyEntry(entry, 'undo'), this.hist.redo.push(entry), this.version++, entry) : null;
  }
  redo() {
    const entry = this.hist.redo.pop();
    return entry ? (this.applyEntry(entry, 'redo'), this.hist.undo.push(entry), this.version++, entry) : null;
  }
  removeGlyphs(model, glyphSet) {
    const glyphsByOp = new Map();
    for (const glyph of model.glyphs) {
      if (!glyphsByOp.has(glyph.op)) glyphsByOp.set(glyph.op, []);
      glyphsByOp.get(glyph.op).push(glyph);
    }
    const opIndices = [...new Set([...glyphSet].map((A) => A.op))].sort((A, s) => s - A);
    const ops = model.ops.slice();
    for (const opIndex of opIndices) {
      const op = ops[opIndex];
      const opGlyphs = glyphsByOp.get(opIndex) || [];
      const font = opGlyphs[0] && opGlyphs[0].font;
      if (!font) continue;
      const parts =
        op.op === 'TJ'
          ? Array.isArray(op.args[0])
            ? op.args[0]
            : []
          : [op.op === '"' ? op.args[2] : op.args[0]];
      const newParts = [];
      let pendingShift = 0;
      const flushShift = () => {
        if (Math.abs(pendingShift) > 1e-6) newParts.push(pendingShift);
        pendingShift = 0;
      };
      parts.forEach((part, partIndex) => {
        if (typeof part == 'number') {
          pendingShift += part;
          return;
        }
        if (!(part instanceof StringToken)) return;
        const codes = font.decode(part.bytes);
        let kept = [];
        const flushKept = () => {
          if (kept.length) {
            flushShift();
            const bytes = [];
            kept.forEach((w) => {
              if (font.twoByte) bytes.push(w >> 8, w & 255);
              else bytes.push(w);
            });
            newParts.push(new StringToken(Uint8Array.from(bytes), true));
            kept = [];
          }
        };
        codes.forEach((code, charIndex) => {
          const glyph = opGlyphs.find(
            (N) => N.part === (op.op === 'TJ' ? partIndex : 0) && N.ci === charIndex,
          );
          if (glyph && glyphSet.has(glyph)) {
            flushKept();
            const advance =
              ((glyph.w / 1000) * glyph.tfs + glyph.Tc + (!font.twoByte && code === 32 ? glyph.Tw : 0)) *
              glyph.Th;
            const scale = glyph.tfs * glyph.Th;
            if (scale) pendingShift -= (advance * 1000) / scale;
          } else kept.push(code);
        });
        flushKept();
      });
      flushShift();
      const tjOp = new ContentOp('TJ', [newParts], null, null);
      tjOp.dirty = true;
      const replacement = [];
      if (op.op === "'") replacement.push(newOp('T*'));
      if (op.op === '"') {
        replacement.push(newOp('Tw', op.args[0]));
        replacement.push(newOp('Tc', op.args[1]));
        replacement.push(newOp('T*'));
      }
      replacement.push(tjOp);
      ops.splice(opIndex, 1, ...replacement);
    }
    return ops;
  }
  finalSrc(ops, src, append) {
    let depth = 0;
    let hasTopLevelCm = false;
    for (const op of ops)
      if (!op.deleted) {
        if (op.op === 'q') depth++;
        else if (op.op === 'Q') depth = Math.max(0, depth - 1);
        else if (op.op === 'cm' && depth === 0) hasTopLevelCm = true;
      }
    let out = serializeOps(ops, src);
    if (append) {
      if (depth !== 0 || hasTopLevelCm)
        out = 'q\n' + out + '\n' + 'Q '.repeat(depth).trim() + (depth ? '\n' : '') + 'Q';
      out += '\n' + append;
    }
    return out;
  }
  async textOps(page, lines) {
    const out = ['q', 'BT', '0 Tc 0 Tw 100 Tz 0 Ts 0 Tr'];
    const fallbacks = new Set();
    for (const line of lines)
      for (const seg of line.segs) {
        if (!seg.text) continue;
        const runs = this.fonts.plan(seg.fam, seg.text);
        let x = seg.xs && seg.xs[0] != null ? seg.xs[0] : seg.x;
        let charIndex = 0;
        for (const run of runs) {
          const chars = [...run.text];
          if (run.writer.kind === 'skip') {
            chars.forEach((ch, k) => {
              const fixedX = seg.xs ? seg.xs[charIndex + k] : null;
              x =
                (fixedX ?? x) +
                (this.fonts.advW(run.writer, seg.fam, ch) / 1000) * seg.size +
                (seg.wordSpace || 0);
            });
            charIndex += chars.length;
            continue;
          }
          const font = await this.fonts.writerFont(run.writer);
          if (font.fallback) fallbacks.add(font.fallback);
          const resName = this.addResource(page, 'Font', font.ref, 'PEF');
          const runX = seg.xs && seg.xs[charIndex] != null ? seg.xs[charIndex] : x;
          out.push(`/${resName} ${formatNumber(seg.size)} Tf`);
          out.push(
            `${formatNumber(seg.color[0])} ${formatNumber(seg.color[1])} ${formatNumber(seg.color[2])} rg`,
          );
          out.push(`/${this.alphaGs(page, seg.alpha == null ? 1 : seg.alpha)} gs`);
          out.push(`1 0 0 1 ${formatNumber(runX)} ${formatNumber(seg.y)} Tm`);
          const tjParts = [];
          let pending = '';
          x = runX;
          const flush = () => {
            if (pending) {
              tjParts.push(bytesToHexString(font.encode(pending)));
              pending = '';
            }
          };
          chars.forEach((ch, k) => {
            const fixedX = seg.xs ? seg.xs[charIndex + k] : null;
            if (fixedX != null && Math.abs(fixedX - x) > 0.01) {
              flush();
              tjParts.push(formatNumber(Math.round(((-(fixedX - x) * 1000) / seg.size) * 1000) / 1000));
              x = fixedX;
            }
            pending += ch;
            x += (font.width(ch) / 1000) * seg.size;
            if (seg.wordSpace && ch === ' ' && fixedX == null) {
              flush();
              tjParts.push(formatNumber((-seg.wordSpace * 1000) / seg.size));
              x += seg.wordSpace;
            }
          });
          flush();
          out.push('[' + tjParts.join(' ') + '] TJ');
          charIndex += chars.length;
        }
      }
    out.push('ET', 'Q');
    return { text: out.join('\n'), warn: [...fallbacks] };
  }
  appendRaw(index, raw, label) {
    const page = this.page(index);
    const before = this.snap(page);
    const src = this.contentSrc(page);
    const ops = parseContentStream(src);
    this.setContentSrc(page, this.finalSrc(ops, src, raw));
    this.push({ kind: 'content', label, before: [before], after: [this.snap(page)], page: index });
  }
  alphaGs(page, alpha) {
    alpha = Math.round(Math.max(0, Math.min(1, alpha)) * 1000) / 1000;
    this._gs = this._gs || new Map();
    if (!this._gs.has(alpha))
      this._gs.set(alpha, this.ctx.register(this.ctx.obj({ Type: 'ExtGState', ca: alpha, CA: alpha })));
    return this.addResource(page, 'ExtGState', this._gs.get(alpha), 'PEG');
  }
  beginEdit(index, block) {
    const page = this.page(index);
    const model = this.model(index);
    const before = this.snap(page);
    if (block) {
      const ops = this.removeGlyphs(model, new Set(block.glyphs));
      this.setContentSrc(page, this.finalSrc(ops, model.src, null));
    }
    this.pending = { i: index, page, before, block };
    this.version++;
    return this.pending;
  }
  cancelEdit() {
    if (this.pending) {
      this.restoreSnap(this.pending.before);
      this.pending = null;
      this.version++;
    }
  }
  async commitEdit(lines, label = 'Text bearbeitet') {
    const pending = this.pending;
    if (!pending) return null;
    this.pending = null;
    const page = pending.page;
    const hasText = lines.some((s) => s.segs.some((seg) => seg.text && seg.text.trim()));
    let warn = [];
    if (hasText) {
      const src = this.contentSrc(page);
      const ops = parseContentStream(src);
      const textOps = await this.textOps(page, lines);
      warn = textOps.warn;
      this.setContentSrc(page, this.finalSrc(ops, src, textOps.text));
    } else if (!pending.block) {
      this.restoreSnap(pending.before);
      this.version++;
      return { warn };
    }
    this.push({
      kind: 'content',
      label: pending.block ? (hasText ? label : 'Text gelöscht') : 'Text hinzugefügt',
      before: [pending.before],
      after: [this.snap(page)],
      page: pending.i,
    });
    return { warn };
  }
  deleteObjects(index, objects, label = 'Objekt gelöscht') {
    const page = this.page(index);
    const model = this.model(index);
    const before = this.snap(page);
    const ops = model.ops.slice();
    for (const obj of objects)
      if (obj.type === 'path') {
        if (obj.clip) {
          const paintOp = ops[obj.end];
          const op = new ContentOp('n', [], null, null);
          op.dirty = true;
          ops[obj.end] = op;
        } else
          for (let k = obj.start; k <= obj.end; k++)
            if (!['W', 'W*'].includes(ops[k].op))
              ops[k] = Object.assign(new ContentOp(ops[k].op, ops[k].args, ops[k].s, ops[k].e), {
                deleted: true,
              });
      } else
        ops[obj.start] = Object.assign(
          new ContentOp(ops[obj.start].op, ops[obj.start].args, ops[obj.start].s, ops[obj.start].e),
          { deleted: true },
        );
    const gone = new Set(objects.map((obj) => obj.uid));
    this.setContentSrc(page, this.finalSrc(ops, model.src, null), (base) => {
      const keep = base.uids.map((uid) => !gone.has(uid));
      return {
        uids: base.uids.filter((_, k) => keep[k]),
        types: base.types.filter((_, k) => keep[k]),
        clusters: base.clusters,
      };
    });
    this.push({ kind: 'content', label, before: [before], after: [this.snap(page)], page: index });
  }
  /**
   * Verschiebt/skaliert/dreht Grafikobjekte um `matrix` (PDF-Koordinaten): umschließt die
   * betroffenen Operatoren mit `q <cm> … Q`; liegt das Objekt in einer q/Q-Gruppe nur mit eigenen
   * Inhalten, wird die ganze Gruppe transformiert, bei Beschneidungspfaden ggf. herausgelöst (liftOps).
   */
  transformObjects(index, objects, matrix, label = 'Objekt verschoben') {
    const page = this.page(index);
    const model = this.model(index);
    const before = this.snap(page);
    const ops = model.ops.slice();
    const selected = new Set(objects);
    const objectByOp = new Map();
    model.objects.forEach((obj) => {
      for (let start = obj.start; start <= obj.end; start++) objectByOp.set(start, obj);
    });
    const textOps = new Set(model.glyphs.map((glyph) => glyph.op));
    const ranges = [];
    for (const obj of objects.filter((I) => !(I.type === 'path' && I.clip))) {
      let start = obj.start;
      let end = obj.end;
      let ctm = obj.ctm;
      let clipped = false;
      while (true) {
        let depth = 0;
        let qStart = -1;
        for (let k = start - 1; k >= 0; k--) {
          const opName = ops[k].op;
          if (opName === 'Q') depth++;
          else if (opName === 'q') {
            if (depth === 0) {
              qStart = k;
              break;
            }
            depth--;
          }
        }
        if (qStart < 0) break;
        depth = 0;
        let qEnd = -1;
        for (let k = qStart + 1; k < ops.length; k++) {
          const opName = ops[k].op;
          if (opName === 'q') depth++;
          else if (opName === 'Q') {
            if (depth === 0) {
              qEnd = k;
              break;
            }
            depth--;
          }
        }
        if (qEnd < 0) break;
        let onlySelected = true;
        let hasClip = false;
        for (let k = qStart; k <= qEnd && onlySelected; k++) {
          if (textOps.has(k)) onlySelected = false;
          const other = objectByOp.get(k);
          if (other && !selected.has(other) && !(other.type === 'path' && other.clip)) onlySelected = false;
          if (ops[k].op === 'W' || ops[k].op === 'W*') hasClip = true;
        }
        if (!onlySelected || !model.qctm.has(qStart)) break;
        start = qStart;
        end = qEnd;
        ctm = model.qctm.get(qStart);
        if (hasClip) {
          clipped = true;
          break;
        }
      }
      const lift = !clipped && obj.depth > 0 && obj.clipRect && !this.insideAfter(obj, matrix);
      if (lift) {
        start = obj.start;
        end = obj.end;
      }
      if (!ranges.some((m) => m.s <= start && m.e >= end))
        ranges.push({ s: start, e: end, ctm, lift: lift ? obj : null });
    }
    const outermost = ranges.filter((d) => !ranges.some((I) => I !== d && I.s <= d.s && I.e >= d.e));
    outermost.sort((d, I) => I.s - d.s);
    for (const range of outermost) {
      if (range.lift) {
        ops.splice(range.s, range.e - range.s + 1, ...this.liftOps(model, ops, range.lift, matrix));
        continue;
      }
      const cm = multiplyMatrix(multiplyMatrix(range.ctm, matrix), invertMatrix(range.ctm));
      ops.splice(range.e + 1, 0, newOp('Q'));
      ops.splice(range.s, 0, newOp('q'), newOp('cm', ...cm));
    }
    this.setContentSrc(page, this.finalSrc(ops, model.src, null));
    this.push({ kind: 'content', label, before: [before], after: [this.snap(page)], page: index });
  }
  insideAfter(obj, matrix) {
    const bbox = obj.bbox;
    const corners = [
      [bbox[0], bbox[1]],
      [bbox[2], bbox[1]],
      [bbox[0], bbox[3]],
      [bbox[2], bbox[3]],
    ].map(([A, s]) => [matrix[0] * A + matrix[2] * s + matrix[4], matrix[1] * A + matrix[3] * s + matrix[5]]);
    const clipRect = obj.clipRect;
    return corners.every(
      ([A, s]) =>
        A >= clipRect[0] - 0.5 && A <= clipRect[2] + 0.5 && s >= clipRect[1] - 0.5 && s <= clipRect[3] + 0.5,
    );
  }
  restackObjects(index, objects, direction, label) {
    const page = this.page(index);
    const model = this.model(index);
    const ops = model.ops.slice();
    let depth = 0;
    for (const op of ops)
      if (op.op === 'q') depth++;
      else if (op.op === 'Q' && (depth--, depth < 0)) return false;
    if (depth !== 0) return false;
    const targets = objects.filter((B) => !(B.type === 'path' && B.clip)).sort((B, E) => B.start - E.start);
    if (!targets.length) return false;
    const before = this.snap(page);
    const replays = targets.map((B) => this.replayOps(ops, B));
    for (const obj of targets)
      if (obj.type === 'path') {
        for (let k = obj.start; k <= obj.end; k++)
          if (!['W', 'W*'].includes(ops[k].op))
            ops[k] = Object.assign(new ContentOp(ops[k].op, ops[k].args, ops[k].s, ops[k].e), {
              deleted: true,
            });
      } else
        ops[obj.start] = Object.assign(
          new ContentOp(ops[obj.start].op, ops[obj.start].args, ops[obj.start].s, ops[obj.start].e),
          { deleted: true },
        );
    let insertAt = ops.length;
    if (direction === 'back') {
      const targetSet = new Set(targets);
      let firstOther = ops.length;
      for (const obj of model.objects)
        if (obj.selectable && !targetSet.has(obj)) firstOther = Math.min(firstOther, obj.start);
      for (const glyph of model.glyphs) firstOther = Math.min(firstOther, glyph.op);
      const qStack = [];
      let btIndex = -1;
      for (let k = 0; k < firstOther; k++) {
        const opName = ops[k].op;
        if (opName === 'q') qStack.push(k);
        else if (opName === 'Q') qStack.pop();
        else if (opName === 'BT') btIndex = k;
        else if (opName === 'ET') btIndex = -1;
      }
      insertAt = qStack.length ? qStack[0] : btIndex >= 0 ? btIndex : firstOther;
    }
    let ctm = IDENTITY_MATRIX.slice();
    const ctmStack = [];
    for (let k = 0; k < insertAt; k++) {
      const op = ops[k];
      if (!op.deleted) {
        if (op.op === 'q') ctmStack.push(ctm);
        else if (op.op === 'Q') ctm = ctmStack.pop() || ctm;
        else if (
          op.op === 'cm' &&
          op.args.length >= 6 &&
          op.args.slice(0, 6).every((m) => typeof m == 'number')
        )
          ctm = multiplyMatrix(op.args.slice(0, 6), ctm);
      }
    }
    const isIdentity = ctm.every((B, E) => Math.abs(B - IDENTITY_MATRIX[E]) < 1e-9);
    const inserted = replays
      .map((B) => (isIdentity ? B : [B[0], newOp('cm', ...invertMatrix(ctm)), ...B.slice(1)]))
      .flat();
    const newOps = [...ops.slice(0, insertAt), ...inserted, ...ops.slice(insertAt)];
    const moved = new Set(targets.map((obj) => obj.uid));
    const startOf = new Map(model.allObjects.map((obj) => [obj.uid, obj.start]));
    this.setContentSrc(page, this.finalSrc(newOps, model.src, null), (base) => {
      const entries = base.uids.map((uid, k) => ({ uid, type: base.types[k] }));
      const movedEntries = entries.filter((e) => moved.has(e.uid));
      const rest = entries.filter((e) => !moved.has(e.uid));
      const cut =
        direction === 'back'
          ? rest.filter((e) => (startOf.get(e.uid) ?? Infinity) < insertAt).length
          : rest.length;
      const order = [...rest.slice(0, cut), ...movedEntries, ...rest.slice(cut)];
      return { uids: order.map((e) => e.uid), types: order.map((e) => e.type), clusters: base.clusters };
    });
    this.push({
      kind: 'content',
      label: label || (direction === 'back' ? 'In den Hintergrund' : 'In den Vordergrund'),
      before: [before],
      after: [this.snap(page)],
      page: index,
    });
    return true;
  }
  replayOps(ops, obj) {
    const stateOps = new Set([
      'cm',
      'gs',
      'g',
      'G',
      'rg',
      'RG',
      'k',
      'K',
      'cs',
      'CS',
      'sc',
      'scn',
      'SC',
      'SCN',
      'w',
      'J',
      'j',
      'M',
      'd',
      'ri',
      'i',
      'Tc',
      'Tw',
      'Tz',
      'TL',
      'Tf',
      'Tr',
      'Ts',
    ]);
    const pathOps = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
    const paintOps = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
    const stack = [[]];
    let pendingPath = [];
    let pendingClip = null;
    for (let k = 0; k < obj.start; k++) {
      const op = ops[k];
      const name = op.op;
      if (op.deleted) continue;
      const frame = stack[stack.length - 1];
      if (name === 'q') {
        stack.push([]);
        continue;
      }
      if (name === 'Q') {
        if (stack.length > 1) stack.pop();
        continue;
      }
      if (pathOps.has(name)) {
        pendingPath.push(op);
        continue;
      }
      if (name === 'W' || name === 'W*') {
        pendingClip = op;
        continue;
      }
      if (paintOps.has(name)) {
        if (pendingClip) frame.push(...pendingPath, pendingClip, newOp('n'));
        pendingPath = [];
        pendingClip = null;
        continue;
      }
      if (stateOps.has(name)) frame.push(op);
    }
    const objectOps = [];
    for (let k = obj.start; k <= obj.end; k++) if (!ops[k].deleted) objectOps.push(ops[k]);
    return [newOp('q'), ...stack.flat(), ...objectOps, newOp('Q')];
  }
  liftOps(model, ops, obj, matrix) {
    const stateOps = new Set([
      'cm',
      'gs',
      'g',
      'G',
      'rg',
      'RG',
      'k',
      'K',
      'cs',
      'CS',
      'sc',
      'scn',
      'SC',
      'SCN',
      'w',
      'J',
      'j',
      'M',
      'd',
      'ri',
      'i',
      'Tc',
      'Tw',
      'Tz',
      'TL',
      'Tf',
      'Tr',
      'Ts',
    ]);
    const pathOps = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
    const paintOps = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
    let frame = null;
    let pendingPath = [];
    let pendingClip = null;
    let qStart = -1;
    let depth = 0;
    for (let k = obj.start - 1; k >= 0; k--) {
      const opName = ops[k].op;
      if (opName === 'Q') depth++;
      else if (opName === 'q') {
        if (depth === 0) qStart = k;
        else depth--;
      }
    }
    const frames = [];
    for (let k = qStart; k < obj.start; k++) {
      const op = ops[k];
      const opName = op.op;
      if (!op.deleted) {
        if (opName === 'q') {
          frame = [];
          frames.push(frame);
          continue;
        }
        if (opName === 'Q') {
          frames.pop();
          frame = frames[frames.length - 1] || null;
          continue;
        }
        if (frame) {
          if (pathOps.has(opName)) {
            pendingPath.push(op);
            continue;
          }
          if (opName === 'W' || opName === 'W*') {
            pendingClip = op;
            continue;
          }
          if (paintOps.has(opName)) {
            if (pendingClip) frame.push(...pendingPath, pendingClip, newOp('n'));
            pendingPath = [];
            pendingClip = null;
            continue;
          }
          if (stateOps.has(opName)) frame.push(op);
        }
      }
    }
    const qCtm = model.qctm.get(qStart) || [1, 0, 0, 1, 0, 0];
    const out = [];
    for (let k = 0; k < frames.length; k++) out.push(newOp('Q'));
    out.push(newOp('q'), newOp('cm', ...invertMatrix(qCtm)), newOp('cm', ...multiplyMatrix(qCtm, matrix)));
    for (const frameOps of frames) out.push(...frameOps);
    for (let k = obj.start; k <= obj.end; k++) out.push(ops[k]);
    out.push(newOp('Q'));
    for (const frameOps of frames) out.push(newOp('q'), ...frameOps);
    return out;
  }
  /**
   * Ändert die Geometrie von Pfadobjekten: `edits` = [{ obj, subpaths }] mit Teilpfaden im
   * Benutzerraum (wie `obj.geom.subpaths`, geänderte mit `changed: true`). Die Pfadoperatoren des
   * Objekts werden ersetzt; unveränderte Teilpfade behalten ihre Originaloperatoren, Operatoren wie
   * W/W* bleiben vor dem Malbefehl erhalten. Linienbreite und Grafikzustand bleiben unberührt.
   */
  editPaths(index, edits, label = 'Pfad bearbeitet') {
    const page = this.page(index);
    const model = this.model(index);
    const before = this.snap(page);
    const ops = model.ops.slice();
    const pathOps = new Set(['m', 'l', 'c', 'v', 'y', 're', 'h']);
    const sorted = edits
      .filter((e) => e.obj.type === 'path' && e.obj.geom)
      .sort((a, b) => b.obj.start - a.obj.start);
    if (!sorted.length) return false;
    for (const { obj, subpaths } of sorted) {
      const replacement = [];
      let anyChanged = false;
      subpaths.forEach((sp) => {
        const regenerate = sp.changed || (anyChanged && sp.implicit) || !sp.ops.length;
        if (regenerate) {
          anyChanged = true;
          replacement.push(...subpathOps(sp));
        } else replacement.push(...sp.ops.map((k) => model.ops[k]));
      });
      const others = [];
      for (let k = obj.start; k < obj.end; k++) if (!pathOps.has(ops[k].op)) others.push(ops[k]);
      ops.splice(obj.start, obj.end - obj.start, ...replacement, ...others);
    }
    this.setContentSrc(page, this.finalSrc(ops, model.src, null));
    this.push({ kind: 'content', label, before: [before], after: [this.snap(page)], page: index });
    return true;
  }
  /**
   * Skaliert/dreht Pfade über ihre Geometrie (Punkte transformieren statt `cm`): die
   * Strichstärke bleibt dabei erhalten. `matrix` in Seitenkoordinaten.
   */
  transformPaths(index, objects, matrix, label = 'Größe geändert') {
    return this.editPaths(
      index,
      objects.map((obj) => ({
        obj,
        subpaths: transformSubpaths(obj.geom.subpaths, userMatrix(obj.ctm, matrix)).map((sp) => ({
          ...sp,
          ops: sp.ops.slice(),
        })),
      })),
      label,
    );
  }
  async embedImage(bytes, mime) {
    const image = /png/.test(mime) ? await this.doc.embedPng(bytes) : await this.doc.embedJpg(bytes);
    // pdf-lib schreibt das Bildobjekt sonst erst beim Speichern; ein vorher berechnetes Seitenmodell
    // würde das neue Bild nicht kennen und (zwischengespeichert) nie erkennen
    await image.embed();
    return image;
  }
  /**
   * Wie `embedImage`, aber gleiche Bilddaten werden nur einmal eingebettet: Wird dasselbe Bild
   * (z. B. eine Unterschrift) mehrfach eingefügt, verweisen alle Stellen auf dasselbe XObject.
   * Der Zwischenspeicher bleibt über Rückgängig hinweg gültig – unerreichbare Objekte werden beim
   * Speichern nur vorübergehend entfernt (`_save`).
   */
  async embedImageOnce(bytes, mime) {
    let hash = 2166136261;
    for (let i = 0; i < bytes.length; i++) hash = Math.imul(hash ^ bytes[i], 16777619);
    const key = mime + ':' + bytes.length + ':' + (hash >>> 0).toString(16);
    this._imageCache = this._imageCache || new Map();
    const cached = this._imageCache.get(key);
    if (cached && cached.bytes.length === bytes.length && cached.bytes.every((b, i) => b === bytes[i]))
      return cached.image;
    const image = await this.embedImage(bytes, mime);
    this._imageCache.set(key, { bytes: Uint8Array.from(bytes), image });
    return image;
  }
  /**
   * Matrix, die das Einheitsquadrat eines Bildes so auf das PDF-Rechteck `rect` = [x, y, b, h]
   * abbildet, dass es in der Anzeige aufrecht steht – auch auf gedrehten Seiten (/Rotate 90, 180,
   * 270): Das Bild wird um die Seitendrehung zurückgedreht. Bei 90/270 ist `rect` im PDF also so
   * breit, wie das Bild in der Anzeige hoch ist.
   */
  uprightMatrix(index, rect) {
    const [x, y, w, h] = rect;
    const rotate = ((this.pageInfo(index).rotate % 360) + 360) % 360;
    if (rotate === 90) return [0, h, -w, 0, x + w, y];
    if (rotate === 180) return [-w, 0, 0, -h, x + w, y + h];
    if (rotate === 270) return [0, -h, w, 0, x, y + h];
    return [w, 0, 0, h, x, y];
  }
  /**
   * Bettet PNG/JPG ein und hängt `q <cm> /Name Do Q` an den Content-Stream an; `rect` = [x, y, b, h]
   * in pt ist das Rechteck im PDF (auf gedrehten Seiten mit vertauschten Seitenlängen, siehe
   * `uprightMatrix`). Gleiche Bilddaten werden nur einmal eingebettet.
   */
  async insertImage(index, bytes, mime, rect, label = 'Bild eingefügt', matrix = null) {
    const page = this.page(index);
    const before = this.snap(page);
    const image = await this.embedImageOnce(bytes, mime);
    const resName = this.addResource(page, 'XObject', image.ref, 'PEI');
    const src = this.contentSrc(page);
    const ops = parseContentStream(src);
    const cm = matrix || this.uprightMatrix(index, rect);
    this.setContentSrc(
      page,
      this.finalSrc(
        ops,
        src,
        `q
${cm.map(formatNumber).join(' ')} cm
/${resName} Do
Q`,
      ),
    );
    this.push({ kind: 'content', label, before: [before], after: [this.snap(page)], page: index });
    return image;
  }
  async replaceImage(index, obj, bytes, mime) {
    const page = this.page(index);
    const model = this.model(index);
    const before = this.snap(page);
    const image = await this.embedImage(bytes, mime);
    const resName = this.addResource(page, 'XObject', image.ref, 'PEI');
    const ops = model.ops.slice();
    const [boxW, boxH] = [obj.bbox[2] - obj.bbox[0], obj.bbox[3] - obj.bbox[1]];
    const aspect = image.width / image.height;
    let scaleX = 1;
    let scaleY = 1;
    if (boxW / Math.max(boxH, 1e-6) > aspect) scaleX = (aspect * boxH) / boxW;
    else scaleY = boxW / aspect / boxH;
    const fit =
      Math.abs(obj.ctm[1]) < 1e-6 && Math.abs(obj.ctm[2]) < 1e-6
        ? [scaleX, 0, 0, scaleY, (1 - scaleX) / 2, (1 - scaleY) / 2]
        : [1, 0, 0, 1, 0, 0];
    const replacement = [newOp('q'), newOp('cm', ...fit), newOp('Do', new NameToken(resName)), newOp('Q')];
    ops.splice(obj.start, 1, ...replacement);
    this.setContentSrc(page, this.finalSrc(ops, model.src, null));
    this.push({
      kind: 'content',
      label: 'Bild ersetzt',
      before: [before],
      after: [this.snap(page)],
      page: index,
    });
  }
  async moveBlocks(index, blocks, dx, dy) {
    await this.batch(blocks.length > 1 ? 'Text verschoben' : 'Textblock verschoben', async () => {
      for (const block of blocks) {
        const model = this.model(index);
        const current =
          model.blocks.find((block2) => block2.id === block.id && block2.text === block.text) ||
          model.blocks.find(
            (block2) =>
              block2.text === block.text &&
              Math.abs(block2.bbox[0] - block.bbox[0]) < 0.5 &&
              Math.abs(block2.bbox[1] - block.bbox[1]) < 0.5,
          );
        if (current) {
          this.beginEdit(index, current);
          await this.commitEdit(blockToEditLines(current, dx, dy), 'Textblock verschoben');
        }
      }
    });
  }
  deleteBlocks(index, blocks, label = 'Text gelöscht') {
    const page = this.page(index);
    const model = this.model(index);
    const before = this.snap(page);
    const glyphs = new Set();
    blocks.forEach((l) => l.glyphs.forEach((glyph) => glyphs.add(glyph)));
    const ops = this.removeGlyphs(model, glyphs);
    this.setContentSrc(page, this.finalSrc(ops, model.src, null));
    this.push({ kind: 'content', label, before: [before], after: [this.snap(page)], page: index });
  }
  pagesEntry(label, fn) {
    const before = this.pageOrder();
    const beforeSnaps = before.map((o) => this.snap(o));
    const result = fn();
    const after = this.pageOrder();
    const afterSnaps = after.map((o) => this.snap(o));
    this.push({ kind: 'pages', label, before, after, beforeSnaps, afterSnaps });
    return result;
  }
  insertBlankPage(at, likeIndex) {
    const info = this.pageInfo(Math.min(Math.max(0, likeIndex), this.numPages - 1));
    return this.pagesEntry('Leere Seite eingefügt', () =>
      this.doc.insertPage(at, [info.media.width, info.media.height]),
    );
  }
  async insertFromPdf(at, bytes, label = 'Seiten eingefügt') {
    const src = await PDFDocument.load(bytes, { updateMetadata: false });
    repairStreamLengths(src, bytes);
    const pages = await this.doc.copyPages(src, src.getPageIndices());
    for (const [page, k] of this.ctx.enumerateIndirectObjects())
      if (k instanceof PDFDict && nameText(k.get(pdfName('Type'))) === 'Font')
        try {
          this.fonts.family(this.fontCache.get(page, k, null));
        } catch {}
    return this.pagesEntry(
      label,
      () => (pages.forEach((A, s) => this.doc.insertPage(at + s, A)), pages.length),
    );
  }
  async duplicatePage(index) {
    const [copy] = await this.doc.copyPages(this.doc, [index]);
    return this.pagesEntry('Seite dupliziert', () => this.doc.insertPage(index + 1, copy));
  }
  deletePages(indices) {
    return this.pagesEntry(indices.length > 1 ? 'Seiten gelöscht' : 'Seite gelöscht', () => {
      [...indices].sort((t, i) => i - t).forEach((t) => this.removePage(t));
    });
  }
  movePages(indices, to) {
    return this.pagesEntry(indices.length > 1 ? 'Seiten verschoben' : 'Seite verschoben', () => {
      const order = this.pageOrder();
      const moving = indices
        .slice()
        .sort((s, o) => s - o)
        .map((s) => order[s]);
      const rest = order.filter((s) => !moving.includes(s));
      const insertAt = order.slice(0, to).filter((s) => !moving.includes(s)).length;
      rest.splice(insertAt, 0, ...moving);
      this.setPageOrder(rest);
    });
  }
  rotatePages(indices, delta) {
    return this.pagesEntry('Seite gedreht', () => {
      indices.forEach((i) => {
        const page = this.page(i);
        page.setRotation(degrees((((page.getRotation().angle + delta) % 360) + 360) % 360));
      });
    });
  }
  reachable() {
    const seen = new Set();
    const stack = [];
    const trailerInfo = this.ctx.trailerInfo;
    for (
      ['Root', 'Info', 'Encrypt'].forEach((n) => {
        if (trailerInfo[n]) stack.push(trailerInfo[n]);
      });
      stack.length;
    ) {
      const obj = stack.pop();
      if (obj instanceof PDFRef) {
        const key = obj.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        const resolved = this.ctx.lookup(obj);
        if (resolved) stack.push(resolved);
        continue;
      }
      if (obj instanceof PDFDict) for (const [, value] of obj.entries()) stack.push(value);
      else if (obj instanceof PDFArray) for (const item of obj.asArray()) stack.push(item);
      else if (obj instanceof PDFStream) for (const [, value] of obj.dict.entries()) stack.push(value);
    }
    return seen;
  }
  /**
   * Speichert seriell (Sperre gegen parallele Aufrufe und Änderungen, siehe `exclusive`). `clean: true` entfernt vorher
   * unerreichbare Objekte und nutzt Objekt-Streams (für die Datei), `clean: false` dient der
   * internen Neudarstellung.
   */
  save(opts) {
    return this.exclusive(() => this._save(opts));
  }
  /**
   * Führt `fn` exklusiv aus: nacheinander mit allen Speichervorgängen und anderen exklusiven
   * Änderungen, damit pdf-lib nie ein Dokument serialisiert, das sich währenddessen ändert.
   */
  exclusive(fn) {
    const run = () => fn();
    const result = (this._saveLock || Promise.resolve()).then(run, run);
    this._saveLock = result.catch(() => {});
    return result;
  }
  async _save({ clean = true } = {}) {
    await this.doc.flush();
    this.fonts.fixEmbeddedNames();
    if (!clean)
      return this.doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
    const unreachable = [];
    const reachable = this.reachable();
    for (const [ref, obj] of this.ctx.enumerateIndirectObjects())
      if (!reachable.has(ref.toString())) unreachable.push([ref, obj]);
    unreachable.forEach(([n]) => this.ctx.delete(n));
    try {
      return await this.doc.save({
        useObjectStreams: true,
        addDefaultPage: false,
        updateFieldAppearances: false,
      });
    } finally {
      unreachable.forEach(([n, a]) => this.ctx.assign(n, a));
    }
  }
}

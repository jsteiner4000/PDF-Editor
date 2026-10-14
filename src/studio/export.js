/**
 * PDF aus einem Projekt: Die Seiten (SVG) werden als Druckfassung an den Hauptprozess der
 * Desktop-App gegeben, der sie mit Chromium in eine PDF setzt (Vektoren, Schrift eingebettet,
 * Text auswählbar). Danach wird das Projekt selbst unsichtbar in die PDF gelegt – so lässt sich
 * die Dokumentation später in PDFix weiterbearbeiten.
 *
 * Ablage: Katalog-Eintrag /PDFixProject → Datenstrom (Flate) mit dem Projekt als JSON. Kein
 * Dateianhang: „Aktive Inhalte entfernen“ beim Speichern würde Anhänge löschen.
 */
import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFString, decodePDFRawStream } from 'pdf-lib';
import { barlowCss } from './fonts.js';
import { MODEL_VERSION, normalizeProject } from './model.js';
import { PAGE } from './svg.js';

const KEY = 'PDFixProject';
const desktop = typeof window !== 'undefined' ? window.pdfEditorDesktop : undefined;

/**
 * Erzeugt die PDF: in der Desktop-App über den Hauptprozess; `window.__pdfixMakePdf` setzen nur die
 * Tests (Browser ohne Desktop-App).
 */
const maker = () => (desktop && desktop.makePdf) || (typeof window !== 'undefined' && window.__pdfixMakePdf) || null;

/** Kann dieses Programm direkt PDFs erzeugen (Desktop-App)? */
export const canMakePdf = () => !!maker();

/** Vollständige Druckfassung: eine HTML-Seite je Dokumentseite, ohne Skripte. */
export function printHtml(doc, title = '') {
  const fonts = doc.font === 'barlow' ? barlowCss() : '';
  const pages = doc.pages.map((p) => `<div class="p">${p.svg}</div>`).join('');
  return `<!doctype html><html lang="${doc.lang || 'de'}"><head><meta charset="utf-8"><title>${title.replace(/[<&]/g, '')}</title><style>
@page{size:${PAGE.w}pt ${PAGE.h}pt;margin:0}
html,body{margin:0;padding:0;background:#fff}
.p{width:${PAGE.w}pt;height:${PAGE.h}pt;overflow:hidden;break-after:page}
.p:last-child{break-after:auto}
.p svg{display:block;width:${PAGE.w}pt;height:${PAGE.h}pt}
${fonts}
</style></head><body>${pages}</body></html>`;
}

/** Erzeugt die PDF in der Desktop-App (Uint8Array). */
export async function makePdf(html) {
  const make = maker();
  if (!make) throw new Error('PDF-Erzeugung nur in der Desktop-App');
  const bytes = await make(html);
  if (typeof bytes === 'string') return Uint8Array.from(atob(bytes), (c) => c.charCodeAt(0));
  return bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
}

/** Kennzeichen der Seiteninhalte – verrät später, ob die PDF nach dem Erstellen verändert wurde. */
export function contentFingerprint(doc) {
  const ctx = doc.context;
  return doc
    .getPages()
    .map((page) => {
      const contents = ctx.lookup(page.node.get(PDFName.of('Contents')));
      const list = contents && contents.asArray ? contents.asArray().map((r) => ctx.lookup(r)) : [contents];
      return list.reduce((n, s) => n + (s && s.contents ? s.contents.length : 0), 0);
    })
    .join('.');
}

/** Ohne Verweis verwendete Bilder entfernen (Logo und spätere Fotos bleiben). */
function pruneImages(project) {
  const used = new Set();
  const text = JSON.stringify({ ...project, images: undefined });
  for (const id of Object.keys(project.images || {})) if (text.includes(`"${id}"`)) used.add(id);
  const images = {};
  for (const id of used) images[id] = project.images[id];
  return { ...project, images };
}

/**
 * Legt das Projekt in die PDF und setzt die Dokumenteigenschaften. `info`: { title, author,
 * subject, lang }.
 */
export async function embedProject(bytes, project, info) {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const json = JSON.stringify(pruneImages(project));
  const ctx = doc.context;
  const stream = ctx.flateStream(new TextEncoder().encode(json), {
    Type: KEY,
    Version: MODEL_VERSION,
  });
  stream.dict.set(PDFName.of('Pages'), PDFNumber.of(doc.getPageCount()));
  stream.dict.set(PDFName.of('Print'), PDFString.of(contentFingerprint(doc)));
  doc.catalog.set(PDFName.of(KEY), ctx.register(stream));
  if (info.title) doc.setTitle(info.title, { showInWindowTitleBar: true });
  if (info.author) doc.setAuthor(info.author);
  if (info.subject) doc.setSubject(info.subject);
  doc.setCreator('PDFix – Dokumentation erstellen');
  doc.setProducer('PDFix');
  doc.setLanguage(info.lang === 'en' ? 'en' : 'de-DE');
  const now = new Date();
  doc.setCreationDate(now);
  doc.setModificationDate(now);
  return doc.save();
}

/**
 * Projekt aus einer (mit PDFix erstellten) PDF lesen. Ergebnis: { project, changed } oder null.
 * `changed`: Die Seiten wurden nach dem Erstellen verändert (z. B. in PDFix bearbeitet).
 */
export function readProject(doc) {
  try {
    const ref = doc.catalog.get(PDFName.of(KEY));
    const stream = ref && doc.context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) return null;
    const json = new TextDecoder().decode(decodePDFRawStream(stream).decode());
    const project = normalizeProject(JSON.parse(json));
    const print = stream.dict.get(PDFName.of('Print'));
    const changed = !print || print.decodeText?.() !== contentFingerprint(doc);
    return { project, changed };
  } catch {
    return null;
  }
}

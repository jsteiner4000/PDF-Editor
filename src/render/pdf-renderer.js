/**
 * Darstellung der Seiten mit pdf.js (Worker als Blob-URL aus dem eingebetteten Quelltext).
 */
import { AnnotationMode, PDFWorker, getDocument } from 'pdfjs-dist';
import PDFJS_WORKER_SOURCE from 'virtual:pdfjs-worker';

/**
 * Ein gemeinsamer pdf.js-Worker für alle Dokumente; sein Quelltext ist im Build eingebettet
 * (virtuelles Modul „virtual:pdfjs-worker“) und wird als Blob-URL gestartet – so funktioniert die
 * Datei auch über file:// ohne Netzwerk.
 */
let sharedWorker = null;

function getPdfWorker() {
  if (sharedWorker) return sharedWorker;
  const url = URL.createObjectURL(new Blob([PDFJS_WORKER_SOURCE], { type: 'text/javascript' }));
  sharedWorker = new PDFWorker({ port: new Worker(url) });
  return sharedWorker;
}

/**
 * Höchstzahl der Pixel eines Vorschau-Canvas (ganze Seite). Darüber wird die Seite verkleinert
 * gerendert und vom Browser hochskaliert; die Schärfe im sichtbaren Ausschnitt liefert dann der
 * Detail-Canvas (siehe DetailRenderer).
 */
export const PREVIEW_MAX_PX = 4e6;

/**
 * Darstellung mit pdf.js: `load()` lädt die aktuellen PDF-Bytes (veraltete Ladevorgänge werden
 * über `gen` verworfen), `render()` zeichnet eine ganze Seite mit zoom × devicePixelRatio,
 * höchstens `maxPx` Pixel, `renderRegion()` nur einen Ausschnitt in voller Auflösung.
 */
export class PdfRenderer {
  constructor() {
    this.doc = null;
    this.gen = 0;
    this.loading = null;
  }
  async load(bytes) {
    const gen = ++this.gen;
    const doc = await getDocument({
      data: bytes.slice(),
      worker: getPdfWorker(),
      isEvalSupported: false,
      useSystemFonts: true,
      verbosity: 0,
      enableXfa: false,
    }).promise;
    if (gen !== this.gen) {
      doc.destroy();
      return false;
    }
    const previous = this.doc;
    this.doc = doc;
    if (previous) setTimeout(() => previous.destroy(), 1500);
    return true;
  }
  /**
   * Rendert die ganze Seite `index` in `target` (Canvas wird erst nach Abschluss ersetzt, damit
   * während des Renderns das alte Bild stehen bleibt). Liefert false bei Abbruch.
   */
  async render(index, target, scale, opts = {}) {
    const doc = this.doc;
    if (!doc) return false;
    const page = await doc.getPage(index + 1);
    const dpr = opts.dpr || window.devicePixelRatio || 1;
    let viewport = page.getViewport({ scale: scale * dpr });
    const maxPx = opts.maxPx || 16e6;
    if (viewport.width * viewport.height > maxPx)
      viewport = page.getViewport({
        scale: scale * dpr * Math.sqrt(maxPx / (viewport.width * viewport.height)),
      });
    const canvas = await this._paint(page, viewport, viewport.width, viewport.height, opts);
    if (!canvas) return false;
    target.width = canvas.width;
    target.height = canvas.height;
    target.getContext('2d').drawImage(canvas, 0, 0);
    canvas.width = canvas.height = 0;
    return true;
  }
  /**
   * Rendert nur den Ausschnitt `region` ({x, y, width, height} in Geräte-Pixeln der ganzen Seite
   * bei `deviceScale` = Geräte-Pixel je PDF-Punkt) in einen neuen Canvas und gibt ihn zurück
   * (null bei Abbruch oder fehlendem Dokument). pdf.js verschiebt dazu den Viewport; gezeichnet
   * wird nur, was im Canvas liegt – Speicher und Rasterung hängen von der Ausschnittgröße ab,
   * nicht vom Zoom.
   */
  async renderRegion(index, deviceScale, region, opts = {}) {
    const doc = this.doc;
    if (!doc) return null;
    const page = await doc.getPage(index + 1);
    if (opts.isStale && opts.isStale()) return null;
    const viewport = page.getViewport({ scale: deviceScale, offsetX: -region.x, offsetY: -region.y });
    return this._paint(page, viewport, region.width, region.height, opts);
  }
  async _paint(page, viewport, width, height, opts) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(width));
    canvas.height = Math.max(1, Math.floor(height));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = page.render({ canvasContext: ctx, viewport, annotationMode: AnnotationMode.ENABLE });
    if (opts.onTask) opts.onTask(task);
    try {
      await task.promise;
    } catch (err) {
      canvas.width = canvas.height = 0;
      if (err && err.name === 'RenderingCancelledException') return null;
      throw err;
    }
    return canvas;
  }
}

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
 * Darstellung mit pdf.js: `load()` lädt die aktuellen PDF-Bytes (veraltete Ladevorgänge werden
 * über `gen` verworfen), `render()` zeichnet eine Seite mit zoom × devicePixelRatio, höchstens
 * 16 Mio. Pixel (`maxPx`).
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
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const task = page.render({ canvasContext: ctx, viewport, annotationMode: AnnotationMode.ENABLE });
    if (opts.onTask) opts.onTask(task);
    try {
      await task.promise;
    } catch (err) {
      if (err && err.name === 'RenderingCancelledException') return false;
      throw err;
    }
    target.width = canvas.width;
    target.height = canvas.height;
    target.getContext('2d').drawImage(canvas, 0, 0);
    return true;
  }
}

/**
 * Unterschrift erfassen: Bereich einer Seite aufziehen und in hoher Auflösung mit pdf.js rendern,
 * Bilddateien einlesen, RGBA-Bilder als PNG kodieren.
 */
import { AnnotationMode } from 'pdfjs-dist';
import { rotateImage } from './signature-extract.js';

/** Auflösung, mit der ein Seitenbereich für das Freistellen gerendert wird. */
export const CAPTURE_DPI = 600;

/**
 * Obergrenze für die Pixelzahl, die freigestellt wird (gerenderte Bereiche, Bilddateien): große
 * Rahmen und Fotos werden geringer aufgelöst.
 */
export const MAX_PROCESS_PX = 8e6;

/**
 * Rendert den PDF-Bereich `rect` = [x0, y0, x1, y1] (Punkte, PDF-Koordinaten) der Seite `index`
 * mit pdf.js – unabhängig vom aktuellen Zoom – mit `dpi` (Standard 600, bei sehr großen Rahmen
 * weniger). Auf gedrehten Seiten (`rotate` = /Rotate) wird das Ergebnis so gedreht, wie die Seite
 * angezeigt wird. Rückgabe: `{ image, dpi }`.
 */
export async function renderPdfRegion(renderer, index, rect, dpi = CAPTURE_DPI, rotate = 0) {
  const doc = renderer.doc;
  if (!doc) throw new Error('Kein Dokument geladen');
  const page = await doc.getPage(index + 1);
  const widthPt = Math.abs(rect[2] - rect[0]);
  const heightPt = Math.abs(rect[3] - rect[1]);
  let scale = dpi / 72;
  const px = widthPt * heightPt * scale * scale;
  if (px > MAX_PROCESS_PX) scale *= Math.sqrt(MAX_PROCESS_PX / px);
  const base = page.getViewport({ scale, rotation: 0 });
  const [ax, ay] = base.convertToViewportPoint(Math.min(rect[0], rect[2]), Math.max(rect[1], rect[3]));
  const [bx, by] = base.convertToViewportPoint(Math.max(rect[0], rect[2]), Math.min(rect[1], rect[3]));
  const viewport = page.getViewport({
    scale,
    rotation: 0,
    offsetX: -Math.min(ax, bx),
    offsetY: -Math.min(ay, by),
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(Math.abs(bx - ax)));
  canvas.height = Math.max(1, Math.round(Math.abs(by - ay)));
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport, annotationMode: AnnotationMode.ENABLE }).promise;
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  return { image: rotateImage(image, rotate), dpi: scale * 72 };
}

/**
 * Liest eine Bilddatei (PNG, JPG, …) als ImageData; große Fotos werden auf höchstens
 * MAX_PROCESS_PX Pixel verkleinert. Transparente Bereiche werden auf Weiß gelegt.
 * Rückgabe: `{ image, factor }` (factor = Verkleinerung, 1 = Originalgröße).
 */
export async function decodeImageFile(file, maxPx = MAX_PROCESS_PX) {
  const bitmap = await createImageBitmap(file);
  const fit = Math.min(1, Math.sqrt(maxPx / (bitmap.width * bitmap.height)));
  const width = Math.max(1, Math.round(bitmap.width * fit));
  const height = Math.max(1, Math.round(bitmap.height * fit));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close && bitmap.close();
  return { image: ctx.getImageData(0, 0, width, height), factor: fit };
}

/**
 * Verkleinert ein RGBA-Bild auf höchstens `maxPx` Pixel bzw. `maxWidth` Breite (mit Glättung,
 * Alphakanal bleibt erhalten). Rückgabe: `{ image, factor }`; bei factor = 1 dasselbe Bild.
 */
export function downscaleImage(img, { maxPx = Infinity, maxWidth = Infinity } = {}) {
  const factor = Math.min(1, Math.sqrt(maxPx / (img.width * img.height)), maxWidth / img.width);
  if (factor >= 1) return { image: img, factor: 1 };
  const width = Math.max(1, Math.round(img.width * factor));
  const height = Math.max(1, Math.round(img.height * factor));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(imageToCanvas(img), 0, 0, width, height);
  return { image: ctx.getImageData(0, 0, width, height), factor: width / img.width };
}

/** RGBA-Bild → Canvas. */
export function imageToCanvas(img, canvas = document.createElement('canvas')) {
  canvas.width = img.width;
  canvas.height = img.height;
  const data = img instanceof ImageData ? img : new ImageData(img.data, img.width, img.height);
  canvas.getContext('2d').putImageData(data, 0, 0);
  return canvas;
}

/** RGBA-Bild → PNG-Bytes (mit Alphakanal). */
export async function encodePng(img) {
  const canvas = imageToCanvas(img);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Lässt den Nutzer auf einer Seite einen Rahmen aufziehen. Während der Auswahl werden Zeiger-
 * ereignisse auf den Seiten abgefangen (Capture-Phase am Fenster), damit der Bearbeiten-Modus
 * nichts auswählt oder verschiebt. Esc bricht ab.
 * @returns {{ promise: Promise<null | { pv, rect: number[] }>, cancel: () => void }}
 *   `rect` in PDF-Koordinaten [x0, y0, x1, y1]
 */
export function pickPageRegion(app, { onStart } = {}) {
  const pages = document.getElementById('pages');
  let finish;
  const promise = new Promise((resolve) => (finish = resolve));
  let drag = null;
  pages.classList.add('sig-capture');

  const pvOf = (target) => {
    const pageEl = target && target.closest && target.closest('#pages .page');
    return pageEl ? app.pvByKey.get(pageEl.dataset.key) : null;
  };
  const layerPoint = (pv, ev) => {
    const [x, y] = pv.clientToLayer(ev.clientX, ev.clientY);
    return [Math.max(0, Math.min(pv.W, x)), Math.max(0, Math.min(pv.H, y))];
  };
  const drawBox = () => {
    const [ax, ay] = drag.start;
    const [bx, by] = drag.end;
    Object.assign(drag.el.style, {
      left: Math.min(ax, bx) + 'px',
      top: Math.min(ay, by) + 'px',
      width: Math.abs(bx - ax) + 'px',
      height: Math.abs(by - ay) + 'px',
    });
  };
  const onDown = (ev) => {
    if (ev.button !== 0 || (app.gestures && app.gestures.spaceDown)) return; // Leertaste = Hand (Pan)
    const pv = pvOf(ev.target);
    if (!pv) return;
    ev.preventDefault();
    ev.stopPropagation();
    const start = layerPoint(pv, ev);
    const el = document.createElement('div');
    el.className = 'sig-marq';
    pv.layer.appendChild(el);
    drag = { pv, start, end: start, el };
    drawBox();
    if (onStart) onStart();
  };
  const onMove = (ev) => {
    if (drag) {
      ev.preventDefault();
      ev.stopPropagation();
      drag.end = layerPoint(drag.pv, ev);
      drawBox();
    } else if (pvOf(ev.target)) ev.stopPropagation(); // keine Hover-Rahmen des Bearbeiten-Modus
  };
  const onUp = (ev) => {
    if (!drag) return;
    ev.preventDefault();
    ev.stopPropagation();
    const { pv, start, end, el } = drag;
    drag = null;
    el.remove();
    if (Math.abs(end[0] - start[0]) < 6 || Math.abs(end[1] - start[1]) < 6) return; // nur ein Klick
    const [x0, y0] = pv.layerToPdf(Math.min(start[0], end[0]), Math.max(start[1], end[1]));
    const [x1, y1] = pv.layerToPdf(Math.max(start[0], end[0]), Math.min(start[1], end[1]));
    done({ pv, rect: [x0, y0, x1, y1] });
  };
  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      done(null);
    }
  };
  const swallow = (ev) => {
    if (pvOf(ev.target)) {
      ev.preventDefault();
      ev.stopPropagation();
    }
  };
  window.addEventListener('pointerdown', onDown, true);
  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('dblclick', swallow, true);
  window.addEventListener('contextmenu', swallow, true);
  function done(result) {
    window.removeEventListener('pointerdown', onDown, true);
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('dblclick', swallow, true);
    window.removeEventListener('contextmenu', swallow, true);
    pages.classList.remove('sig-capture');
    if (drag) drag.el.remove();
    drag = null;
    finish(result);
  }
  return { promise, cancel: () => done(null) };
}

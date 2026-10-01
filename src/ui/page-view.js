/**
 * Seitenansicht: Canvas + Ebene, Koordinatenumrechnung Client <-> Ebene <-> PDF.
 */
import { PREVIEW_MAX_PX } from '../render/pdf-renderer.js';

/**
 * Höchstzahl gemerkter Seitenbilder (`remember()`) über alle Seiten zusammen.
 */
const MAX_REMEMBERED = 3;

/** Gemerkte Seitenbilder aller Seiten, neueste zuerst: { pv, sig, scale, canvas }. */
let remembered = [];

/**
 * Darstellung einer Seite: `el` (div.page) mit Vorschau-Canvas `canvas` (ganze Seite, höchstens
 * PREVIEW_MAX_PX Pixel, per CSS auf Seitengröße gestreckt), Detail-Canvas `detail` (nur der
 * sichtbare Ausschnitt in voller Auflösung, siehe DetailRenderer) und Ebene `layer` für Overlays.
 *
 * Koordinatensysteme:
 *   - PDF: Punkte (pt), Ursprung unten links (Crop-Box `info.x/y/w/h`)
 *   - Ebene (layer): CSS-Pixel der ungedrehten Seite, Ursprung oben links; `scale` = zoom × 96/72
 *   - Client: Bildschirmkoordinaten; bei gedrehten Seiten (rot = 90/180/270) ist die Ebene per
 *     CSS-Transformation gedreht – `clientToLayer()`/`layerToClient()` rechnen das um.
 */
export class PageView {
  constructor(key) {
    this.key = key;
    this.el = document.createElement('div');
    this.el.className = 'page';
    this.el.dataset.key = key;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'pc';
    this.layer = document.createElement('div');
    this.layer.className = 'layer';
    this.detail = document.createElement('canvas');
    this.detail.className = 'pd';
    this.detail.hidden = true;
    /** Lage des Detail-Canvas: { sig, scale, dpr, res, x, y, w, h } (x…h in CSS-px bei `scale`). */
    this.detailInfo = null;
    this.el.append(this.canvas, this.detail, this.layer);
    this.index = -1;
    this.info = null;
    this.scale = 1;
    this.sig = null;
    this.rendered = null;
    this.visible = false;
  }
  setGeometry(info, scale) {
    this.info = info;
    this.scale = scale;
    const width = info.w * scale;
    const height = info.h * scale;
    const rotation = ((info.rotate % 360) + 360) % 360;
    this.rot = rotation;
    const displayWidth = rotation % 180 ? height : width;
    const displayHeight = rotation % 180 ? width : height;
    this.dw = displayWidth;
    this.dh = displayHeight;
    this.W = width;
    this.H = height;
    this.el.style.width = displayWidth + 'px';
    this.el.style.height = displayHeight + 'px';
    this.layer.style.width = width + 'px';
    this.layer.style.height = height + 'px';
    this.layer.style.transform =
      rotation === 90
        ? `rotate(90deg) translate(0,${-height}px)`
        : rotation === 180
          ? `rotate(180deg) translate(${-width}px,${-height}px)`
          : rotation === 270
            ? `rotate(270deg) translate(${-width}px,0)`
            : '';
    this.placeDetail();
  }
  /**
   * Pixelgröße des Vorschau-Canvas für den aktuellen Zoom und `dpr` sowie die erreichte Dichte
   * (Geräte-Pixel je CSS-Pixel); `capped` = Vorschau ist unschärfer als der Bildschirm.
   */
  previewSize(dpr = window.devicePixelRatio || 1) {
    const px = this.dw * this.dh * dpr * dpr;
    const k = px > PREVIEW_MAX_PX ? Math.sqrt(PREVIEW_MAX_PX / px) : 1;
    return {
      key: Math.round(this.dw * dpr * k) + 'x' + Math.round(this.dh * dpr * k),
      density: dpr * k,
      capped: k < 1,
    };
  }
  /** Übernimmt einen fertig gerenderten Detail-Canvas (ersetzt den bisherigen). */
  setDetail(canvas, info) {
    canvas.className = 'pd';
    const old = this.detail;
    old.replaceWith(canvas);
    old.width = old.height = 0;
    this.detail = canvas;
    this.detailInfo = info;
    this.placeDetail();
  }
  /** Gibt den Detail-Canvas frei. */
  clearDetail() {
    if (!this.detailInfo && this.detail.hidden) return;
    this.detail.width = this.detail.height = 0;
    this.detail.hidden = true;
    this.detailInfo = null;
  }
  /** Positioniert den Detail-Canvas passend zum aktuellen Zoom (während Gesten gestreckt). */
  placeDetail() {
    const info = this.detailInfo;
    if (!info) return;
    const k = this.scale / info.scale;
    Object.assign(this.detail.style, {
      left: info.x * k + 'px',
      top: info.y * k + 'px',
      width: info.w * k + 'px',
      height: info.h * k + 'px',
    });
    this.detail.hidden = false;
  }
  /** Gibt Vorschau und Detail frei (Seite außer Sicht); beim nächsten Anzeigen wird neu gerendert. */
  release() {
    this.canvas.width = this.canvas.height = 0;
    this.rendered = null;
    this.clearDetail();
  }
  /**
   * Kopie des angezeigten Seitenbilds im Ebenen-Rechteck (CSS-px, ungedrehte Seite) – Vorschau,
   * darüber der Detail-Canvas, soweit er den Bereich abdeckt. Höchstens `maxPx` Pixel.
   */
  snapshot(left, top, width, height, maxPx = 4e6) {
    const dpr = window.devicePixelRatio || 1;
    const k = Math.min(dpr, Math.sqrt(maxPx / Math.max(1, width * height)));
    const out = document.createElement('canvas');
    out.width = Math.max(1, Math.round(width * k));
    out.height = Math.max(1, Math.round(height * k));
    const ctx = out.getContext('2d');
    const draw = (src, sx, sy, sw, sh) => {
      if (!src.width || !src.height || sw <= 0 || sh <= 0) return;
      const fx = src.width / sw;
      const fy = src.height / sh;
      ctx.drawImage(
        src,
        (left - sx) * fx,
        (top - sy) * fy,
        width * fx,
        height * fy,
        0,
        0,
        out.width,
        out.height,
      );
    };
    try {
      draw(this.canvas, 0, 0, this.dw, this.dh);
      const info = this.detailInfo;
      if (info && !this.detail.hidden) {
        const s = this.scale / info.scale;
        ctx.save();
        ctx.beginPath();
        ctx.rect((info.x * s - left) * k, (info.y * s - top) * k, info.w * s * k, info.h * s * k);
        ctx.clip();
        draw(this.detail, info.x * s, info.y * s, info.w * s, info.h * s);
        ctx.restore();
      }
    } catch {}
    return out;
  }
  pdfToLayer(x, y) {
    return [(x - this.info.x) * this.scale, (this.info.y + this.info.h - y) * this.scale];
  }
  layerToPdf(x, y) {
    return [this.info.x + x / this.scale, this.info.y + this.info.h - y / this.scale];
  }
  clientToLayer(clientX, clientY) {
    const rect = this.el.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const width = this.W;
    const height = this.H;
    switch (this.rot) {
      case 90:
        return [y, height - x];
      case 180:
        return [width - x, height - y];
      case 270:
        return [width - y, x];
      default:
        return [x, y];
    }
  }
  layerToClient(x, y) {
    const rect = this.el.getBoundingClientRect();
    const width = this.W;
    const height = this.H;
    let dx;
    let dy;
    switch (this.rot) {
      case 90:
        dx = height - y;
        dy = x;
        break;
      case 180:
        dx = width - x;
        dy = height - y;
        break;
      case 270:
        dx = y;
        dy = width - x;
        break;
      default:
        dx = x;
        dy = y;
    }
    return [rect.left + dx, rect.top + dy];
  }
  clientDeltaToLayer(dx, dy) {
    switch (this.rot) {
      case 90:
        return [dy, -dx];
      case 180:
        return [-dx, -dy];
      case 270:
        return [-dy, dx];
      default:
        return [dx, dy];
    }
  }
  clientToLayerRect(rect) {
    const topLeft = this.clientToLayer(rect.left, rect.top);
    const bottomRight = this.clientToLayer(rect.right, rect.bottom);
    return [
      Math.min(topLeft[0], bottomRight[0]),
      Math.min(topLeft[1], bottomRight[1]),
      Math.max(topLeft[0], bottomRight[0]),
      Math.max(topLeft[1], bottomRight[1]),
    ];
  }
  clientToPdf(clientX, clientY) {
    const [x, y] = this.clientToLayer(clientX, clientY);
    return this.layerToPdf(x, y);
  }
  boxOf(bbox) {
    const [left, top] = this.pdfToLayer(bbox[0], bbox[3]);
    const [right, bottom] = this.pdfToLayer(bbox[2], bbox[1]);
    return { left, top, width: right - left, height: bottom - top };
  }
  /**
   * Merkt sich das aktuelle Seitenbild (z. B. vor einer Textbearbeitung), um es bei unveränderter
   * Seite ohne Neurendern wiederherzustellen. Über alle Seiten höchstens MAX_REMEMBERED Kopien.
   */
  remember(sig, scale) {
    if (!this.canvas.width) return;
    const canvas = document.createElement('canvas');
    canvas.width = this.canvas.width;
    canvas.height = this.canvas.height;
    canvas.getContext('2d').drawImage(this.canvas, 0, 0);
    const keep = [];
    for (const entry of remembered)
      if (entry.pv === this && entry.sig === sig) entry.canvas.width = entry.canvas.height = 0;
      else keep.push(entry);
    remembered = [{ pv: this, sig, scale, canvas }, ...keep];
    for (const entry of remembered.splice(MAX_REMEMBERED)) entry.canvas.width = entry.canvas.height = 0;
  }
  get bitmaps() {
    return remembered.filter((entry) => entry.pv === this);
  }
  restoreFrom(sig, scale) {
    const cached = remembered.find(
      (entry) => entry.pv === this && entry.sig === sig && entry.scale === scale,
    );
    if (!cached) return false;
    this.canvas.width = cached.canvas.width;
    this.canvas.height = cached.canvas.height;
    this.canvas.getContext('2d').drawImage(cached.canvas, 0, 0);
    this.rendered = { sig, scale, key: this.previewSize().key };
    return true;
  }
}

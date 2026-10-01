/**
 * Zeichenfläche für eine Unterschrift (Maus, Stift, Touch).
 *
 * Striche werden als Punktfolgen { x, y, w } in CSS-Pixeln der Fläche gespeichert und bei jeder
 * Änderung neu gezeichnet – geglättet über quadratische Kurven durch die Mittelpunkte. Die
 * Strichbreite folgt dem Andruck (Stift) bzw. bei Maus/Touch der Geschwindigkeit (schneller =
 * dünner) und wird geglättet. Export in 4-facher Auflösung mit transparentem Hintergrund.
 */
import { cropToAlpha, INK_COLORS } from './signature-extract.js';

const BASE_WIDTH = 2.6; // CSS-Pixel
const EXPORT_SCALE = 4;

export class SignaturePad {
  /** @param {HTMLCanvasElement} canvas  sichtbare Zeichenfläche (Größe per CSS) */
  constructor(canvas, { onChange } = {}) {
    this.canvas = canvas;
    this.strokes = [];
    this.color = 'black';
    this.onChange = onChange || (() => {});
    this.current = null;
    canvas.style.touchAction = 'none';
    canvas.addEventListener('pointerdown', (ev) => this.down(ev));
    canvas.addEventListener('pointermove', (ev) => this.move(ev));
    canvas.addEventListener('pointerup', (ev) => this.up(ev));
    canvas.addEventListener('pointercancel', (ev) => this.up(ev));
    this.resize();
  }
  /** Passt die Pixelgröße an die angezeigte Größe an (scharf bei hoher Bildschirmauflösung). */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.cssW = rect.width || this.canvas.width;
    this.cssH = rect.height || this.canvas.height;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.cssW * dpr);
    this.canvas.height = Math.round(this.cssH * dpr);
    this.redraw();
  }
  point(ev) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: ev.clientX - rect.left, y: ev.clientY - rect.top, t: ev.timeStamp };
  }
  widthFor(ev, prev, p) {
    if (ev.pointerType === 'pen' && ev.pressure > 0) return BASE_WIDTH * (0.35 + ev.pressure * 1.15);
    if (!prev) return BASE_WIDTH;
    const dt = Math.max(1, p.t - prev.t);
    const speed = Math.hypot(p.x - prev.x, p.y - prev.y) / dt; // px/ms
    const target = BASE_WIDTH * Math.max(0.55, Math.min(1.25, 1.3 - speed * 0.35));
    return prev.w * 0.7 + target * 0.3;
  }
  down(ev) {
    if (ev.button !== 0) return;
    ev.preventDefault();
    this.canvas.setPointerCapture(ev.pointerId);
    const p = this.point(ev);
    p.w = this.widthFor(ev, null, p);
    this.current = [p];
    this.strokes.push(this.current);
    this.redraw();
  }
  move(ev) {
    if (!this.current) return;
    ev.preventDefault();
    const events = ev.getCoalescedEvents ? ev.getCoalescedEvents() : [ev];
    for (const e of events.length ? events : [ev]) {
      const p = this.point(e);
      const prev = this.current[this.current.length - 1];
      if (Math.hypot(p.x - prev.x, p.y - prev.y) < 0.8) continue;
      p.w = this.widthFor(e, prev, p);
      this.current.push(p);
    }
    this.redraw();
  }
  up() {
    if (!this.current) return;
    this.current = null;
    this.onChange();
  }
  undo() {
    this.strokes.pop();
    this.redraw();
    this.onChange();
  }
  clear() {
    this.strokes = [];
    this.redraw();
    this.onChange();
  }
  isEmpty() {
    return !this.strokes.length;
  }
  setColor(color) {
    this.color = color;
    this.redraw();
  }
  inkRgb() {
    return INK_COLORS[this.color] || INK_COLORS.black;
  }
  /** Zeichnet alle Striche in `ctx` mit Faktor `scale`. */
  paint(ctx, scale) {
    const [r, g, b] = this.inkRgb();
    ctx.fillStyle = ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (const stroke of this.strokes) {
      if (stroke.length === 1) {
        const p = stroke[0];
        ctx.beginPath();
        ctx.arc(p.x * scale, p.y * scale, (p.w * scale) / 2, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      // Segmente zwischen den Mittelpunkten mit dem Punkt als Kontrollpunkt (glatte Kurve)
      for (let i = 1; i < stroke.length; i++) {
        const a = stroke[i - 1];
        const b2 = stroke[i];
        const c = stroke[i + 1];
        const start = i === 1 ? a : { x: (a.x + b2.x) / 2, y: (a.y + b2.y) / 2 };
        const end = c ? { x: (b2.x + c.x) / 2, y: (b2.y + c.y) / 2 } : b2;
        ctx.beginPath();
        ctx.lineWidth = ((a.w + b2.w) / 2) * scale;
        ctx.moveTo(start.x * scale, start.y * scale);
        ctx.quadraticCurveTo(b2.x * scale, b2.y * scale, end.x * scale, end.y * scale);
        ctx.stroke();
      }
    }
  }
  redraw() {
    const ctx = this.canvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.paint(ctx, this.canvas.width / (this.cssW || this.canvas.width));
  }
  /** Export: transparentes RGBA-Bild, auf die Striche zugeschnitten (oder `null`, wenn leer). */
  exportImage() {
    if (this.isEmpty()) return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(this.cssW * EXPORT_SCALE);
    canvas.height = Math.round(this.cssH * EXPORT_SCALE);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.paint(ctx, EXPORT_SCALE);
    const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const cropped = cropToAlpha(img, EXPORT_SCALE * 4);
    return cropped ? cropped.image : null;
  }
}

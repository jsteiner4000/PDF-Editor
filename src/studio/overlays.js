/**
 * Freie Elemente auf jeder Seite: Bilder und QR-Codes (z. B. Seriennummer für die P2P-Einwahl per
 * App). Sie liegen über dem Inhalt, gehören zu einer Seite eines Abschnitts und lassen sich frei
 * verschieben und in der Größe ändern. Maße in pt auf der Seite.
 */
import qrcode from 'qrcode-generator';
import { C, esc, n, text } from './svg.js';

/** Geräte mit Seriennummer (Zugangsdaten): Quelle für QR-Codes. */
export function serialSources(project, lang = 'de') {
  const out = [];
  for (const s of project.sections)
    if (s.type === 'access')
      for (const d of s.devices) {
        const serial = String(d.serial || '').trim();
        if (serial) out.push({ id: d.id, name: (d.name && (d.name[lang] || d.name.de)) || '', serial });
      }
  return out;
}

/** Inhalt eines QR-Codes: Seriennummer des verknüpften Geräts, sonst der eingegebene Text. */
export function qrText(project, o) {
  if (o.src) {
    const dev = serialSources(project).find((d) => d.id === o.src);
    if (dev) return dev.serial;
  }
  return String(o.text || '').trim();
}

/** Beschriftung unter dem QR-Code: „SN 12345“ bzw. der Text (gekürzt). */
export function qrCaption(project, o) {
  const value = qrText(project, o);
  if (!value) return '';
  const short = value.length > 34 ? value.slice(0, 33) + '…' : value;
  return o.src ? `SN ${short}` : short;
}

/** QR-Code als Vektor (ein Pfad, schwarze Module), quadratisch in (x, y, size). */
export function qrSvg(value, x, y, size) {
  if (!value) return '';
  const qr = qrcode(0, 'M');
  qr.addData(unescape(encodeURIComponent(value)), 'Byte');
  qr.make();
  const count = qr.getModuleCount();
  const quiet = 2; // Ruhezone in Modulen
  const m = size / (count + 2 * quiet);
  let d = '';
  for (let r = 0; r < count; r++)
    for (let c = 0; c < count; c++)
      if (qr.isDark(r, c)) d += `M${n(x + (c + quiet) * m)} ${n(y + (r + quiet) * m)}h${n(m)}v${n(m)}h${n(-m)}z`;
  return `<rect x="${n(x)}" y="${n(y)}" width="${n(size)}" height="${n(size)}" fill="#fff"/><path d="${d}" fill="#000" shape-rendering="crispEdges"/>`;
}

/** Höhe der Beschriftung unter einem QR-Code. */
export const QR_CAPTION_H = 13;

/** SVG eines freien Elements (Bild oder QR-Code mit Beschriftung). */
export function overlaySvg(project, o) {
  if (o.kind === 'image') {
    const img = project.images[o.image];
    if (!img || !img.data) return '';
    return `<image href="${esc(img.data)}" x="${n(o.x)}" y="${n(o.y)}" width="${n(o.w)}" height="${n(o.h)}" preserveAspectRatio="xMidYMid meet"/>`;
  }
  const size = Math.min(o.w, o.h - (o.caption ? QR_CAPTION_H : 0));
  const value = qrText(project, o);
  if (!value)
    return `<rect x="${n(o.x)}" y="${n(o.y)}" width="${n(size)}" height="${n(size)}" fill="#f4f7f9" stroke="${C.rule}" stroke-dasharray="3 2"/>`;
  let s = qrSvg(value, o.x, o.y, size);
  if (o.caption) {
    // Beschriftung passt in die Breite des Codes (lange Seriennummern: kleiner, mindestens 5 pt)
    const cap = qrCaption(project, o);
    const fs = Math.max(5, Math.min(7.5, size / (cap.length * 0.56)));
    s += text(o.x + size / 2, o.y + size + 9.5, cap, { size: Math.round(fs * 10) / 10, fill: C.navy, anchor: 'middle' });
  }
  return s;
}

/** Elemente einer Seite: `secPage` = Seite im Abschnitt; was dahinter liegt, landet auf der letzten Seite. */
export function overlaysOf(project, section, secPage, last) {
  return (project.overlays || []).filter((o) => o.section === section && (o.page === secPage || (last && o.page > secPage)));
}

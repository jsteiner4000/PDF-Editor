#!/usr/bin/env node
// Erzeugt das Symbol für PDF-Dateien (Explorer, Desktop), wenn PDFix das Standardprogramm ist.
//
//   node assets/icon/build-document-icon.mjs
//
// Ein Blatt mit Eselsohr, darauf das Programmsymbol und „PDF“ – so unterscheiden sich Dokumente
// auf einen Blick vom Programm selbst (das nur das Symbol zeigt). Bei 16/24 px entfällt die
// Schrift, das Symbol wird größer, damit es lesbar bleibt.
// Quelle:   png/icon-256.png (von build-icons.mjs)
// Ausgabe:  document.ico (16 … 256), png/document-<n>.png (Vorschau)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIco, loadPlaywright } from './ico.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SIZES = [16, 24, 32, 48, 64, 128, 256];

const { chromium } = loadPlaywright();
const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
const page = await browser.newPage();
const logo = fs.readFileSync(path.join(DIR, 'png', 'icon-256.png')).toString('base64');
const result = await page.evaluate(
  async ({ logo, sizes }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + logo;
    await img.decode();
    // Symbol stufenweise verkleinern (gute Glättung)
    const scaled = (size) => {
      let canvas = document.createElement('canvas');
      canvas.width = canvas.height = img.width;
      canvas.getContext('2d').drawImage(img, 0, 0);
      while (canvas.width / 2 >= size) {
        const half = document.createElement('canvas');
        half.width = half.height = Math.round(canvas.width / 2);
        const g = half.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(canvas, 0, 0, half.width, half.height);
        canvas = half;
      }
      return canvas;
    };
    const out = {};
    for (const S of sizes) {
      const c = document.createElement('canvas');
      c.width = c.height = S;
      const g = c.getContext('2d');
      const tiny = S < 32;
      // Blatt: Breite ~ 2/3, oben rechts gefaltet, Ecken leicht gerundet (auf ganze Pixel gesetzt)
      const px = (v) => Math.round(v * S) + (S >= 32 ? 0.5 : 0);
      const x0 = px(tiny ? 0.13 : 0.16);
      const x1 = px(tiny ? 0.87 : 0.84);
      const y0 = px(0.05);
      const y1 = px(0.95);
      const f = Math.round(S * (tiny ? 0.26 : 0.22));
      const r = Math.max(1, S * 0.045);
      const sheet = () => {
        g.beginPath();
        g.moveTo(x0 + r, y0);
        g.lineTo(x1 - f, y0);
        g.lineTo(x1, y0 + f);
        g.lineTo(x1, y1 - r);
        g.quadraticCurveTo(x1, y1, x1 - r, y1);
        g.lineTo(x0 + r, y1);
        g.quadraticCurveTo(x0, y1, x0, y1 - r);
        g.lineTo(x0, y0 + r);
        g.quadraticCurveTo(x0, y0, x0 + r, y0);
        g.closePath();
      };
      const line = Math.max(1, S / 100);
      g.save();
      if (S >= 48) {
        g.shadowColor = 'rgba(27,30,69,0.18)';
        g.shadowBlur = S / 32;
        g.shadowOffsetY = S / 96;
      }
      sheet();
      g.fillStyle = '#ffffff';
      g.fill();
      g.restore();
      sheet();
      g.lineWidth = line;
      g.strokeStyle = '#b9bdcc';
      g.stroke();
      // Eselsohr
      g.beginPath();
      g.moveTo(x1 - f, y0);
      g.lineTo(x1 - f, y0 + f - r);
      g.quadraticCurveTo(x1 - f, y0 + f, x1 - f + r, y0 + f);
      g.lineTo(x1, y0 + f);
      g.closePath();
      g.fillStyle = '#e4e6ef';
      g.fill();
      g.lineWidth = line;
      g.strokeStyle = '#b9bdcc';
      g.lineJoin = 'round';
      g.stroke();
      // Programmsymbol und Beschriftung
      const iconSize = Math.round(S * (tiny ? 0.5 : 0.4));
      const cx = (x0 + x1) / 2;
      const iconY = Math.round(tiny ? y1 - iconSize - S * 0.08 : S * 0.3);
      g.imageSmoothingQuality = 'high';
      g.drawImage(scaled(iconSize), Math.round(cx - iconSize / 2), iconY, iconSize, iconSize);
      if (!tiny) {
        g.fillStyle = '#1b1e45';
        g.font = `700 ${Math.round(S * 0.15)}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'alphabetic';
        g.fillText('PDF', cx, Math.round(S * 0.86));
      }
      out[S] = c.toDataURL('image/png').split(',')[1];
    }
    return out;
  },
  { logo, sizes: SIZES },
);
await browser.close();

const pngs = new Map(SIZES.map((size) => [size, Buffer.from(result[size], 'base64')]));
for (const [size, data] of pngs) fs.writeFileSync(path.join(DIR, 'png', `document-${size}.png`), data);
fs.writeFileSync(path.join(DIR, 'document.ico'), buildIco(pngs, SIZES));
console.log(`Fertig: document.ico (${SIZES.join('/')})`);

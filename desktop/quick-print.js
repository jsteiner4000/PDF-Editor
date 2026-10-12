/**
 * Schnelldruck: eine PDF ohne Dialog auf dem Standarddrucker (oder einem genannten Drucker)
 * ausgeben – für das Windows-Verb „Drucken“ (Outlook-Schnelldruck, Explorer-Kontextmenü).
 *
 * Ablauf: Die Web-App rendert die Seiten mit pdf.js zu Bildern (Druckauflösung, Anmerkungen wie
 * beim Drucken), der Hauptprozess stellt sie als Druckseite unter app://pdf-editor/print/<Kennung>/
 * bereit und druckt diese in einem unsichtbaren Fenster (ohne JavaScript). Jede Seite wird
 * seitenfüllend und unverzerrt auf das Papier des Druckers gesetzt; Querformat-Seiten sind von der
 * Web-App bereits gedreht.
 */
import { BrowserWindow } from 'electron';
import { randomUUID } from 'node:crypto';

/** Kennung → { pages: Uint8Array[] } der gerade laufenden Druckaufträge. */
const jobs = new Map();

const PRINT_CSP = "default-src 'none'; img-src app:; style-src 'unsafe-inline'";

/** Antwort des app://-Protokolls für /print/<Kennung>/… oder null (nicht zuständig). */
export function printResponse(url) {
  const match = /^\/print\/([0-9a-f-]{36})\/(?:(\d+)\.png)?$/.exec(url.pathname);
  if (!match) return null;
  const job = jobs.get(match[1]);
  if (!job) return new Response('Nicht gefunden', { status: 404 });
  if (match[2] !== undefined) {
    const png = job.pages[Number(match[2])];
    if (!png) return new Response('Nicht gefunden', { status: 404 });
    return new Response(png, {
      headers: { 'content-type': 'image/png', 'x-content-type-options': 'nosniff' },
    });
  }
  const imgs = job.pages.map((_, n) => `<div class="p"><img src="${n}.png" alt=""></div>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
@page{margin:0}
html,body{margin:0;padding:0;background:#fff}
.p{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center;overflow:hidden;break-after:page}
.p:last-child{break-after:auto}
.p img{max-width:100%;max-height:100%;object-fit:contain}
</style></head><body>${imgs}</body></html>`;
  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': PRINT_CSP,
      'x-content-type-options': 'nosniff',
    },
  });
}

/**
 * Druckt die Seitenbilder `pages` (PNG) in den bedruckbaren Bereich des Papiers. `printer` leer =
 * Standarddrucker. Mit `toPdf` (nur für Tests, nicht im ausgelieferten Programm) entsteht statt des Ausdrucks eine PDF-Datei (Bytes als Ergebnis).
 */
export async function printPages(origin, pages, { printer = '', toPdf = false } = {}) {
  const token = randomUUID();
  jobs.set(token, { pages });
  const win = new BrowserWindow({
    show: false,
    width: 800,
    height: 1100,
    webPreferences: {
      javascript: false,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      devTools: false,
      spellcheck: false,
    },
  });
  try {
    await win.loadURL(`${origin}/print/${token}/`);
    if (toPdf)
      return await win.webContents.printToPDF({
        printBackground: true,
        margins: { marginType: 'none' },
        pageSize: 'A4',
      });
    await new Promise((resolve, reject) =>
      win.webContents.print(
        {
          silent: true,
          printBackground: true,
          deviceName: printer || undefined,
          // nur den bedruckbaren Bereich nutzen – sonst schneidet der Drucker die Ränder ab
          margins: { marginType: 'printableArea' },
        },
        (success, failureReason) =>
          success ? resolve() : reject(new Error(failureReason || 'Drucken fehlgeschlagen')),
      ),
    );
    return null;
  } finally {
    jobs.delete(token);
    if (!win.isDestroyed()) win.destroy();
  }
}

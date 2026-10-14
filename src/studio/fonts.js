/**
 * Schrift „Barlow“ für die Dokumente: aus den mitgelieferten Schriften (gzip, base64) entpackt,
 * für die Vorschau als FontFace angemeldet und für die PDF als @font-face (data:-URL) bereitgestellt.
 * Helvetica braucht nichts davon (Systemschrift, unter Windows Arial mit gleichen Breiten).
 */
import BUNDLED_FONTS from 'virtual:bundled-fonts';
import { resetMeasure } from './measure.js';

const FACES = [
  ['Barlow-Regular.ttf', 400, 'normal'],
  ['Barlow-Italic.ttf', 400, 'italic'],
  ['Barlow-Medium.ttf', 500, 'normal'],
  ['Barlow-SemiBold.ttf', 600, 'normal'],
  ['Barlow-Bold.ttf', 700, 'normal'],
];

let ready = null;
const css = [];

async function gunzip(b64) {
  const gz = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Lädt Barlow einmal (Vorschau und Messung); danach gelten neue Textbreiten. */
export function ensureBarlow() {
  if (!ready)
    ready = (async () => {
      for (const [file, weight, style] of FACES) {
        const entry = BUNDLED_FONTS.find((f) => f.name === file);
        if (!entry) continue;
        const bytes = await gunzip(entry.data);
        const face = new FontFace('PDFix Barlow', bytes, { weight: String(weight), style });
        await face.load();
        document.fonts.add(face);
        css.push(
          `@font-face{font-family:"PDFix Barlow";src:url(data:font/ttf;base64,${toBase64(bytes)}) format("truetype");font-weight:${weight};font-style:${style}}`,
        );
      }
      resetMeasure();
    })().catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
}

/** @font-face-Regeln für die Druckfassung (leer, solange Barlow nicht geladen ist). */
export const barlowCss = () => css.join('\n');

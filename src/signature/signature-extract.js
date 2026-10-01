/**
 * Freistellen einer Unterschrift: Papier/Scan-Hintergrund → transparent, Tinte → deckend.
 *
 * Reine Rechenfunktionen ohne DOM (laufen im Browser und in Node für die Tests). Eingabe und
 * Ausgabe sind ImageData-artige Objekte `{ width, height, data: Uint8ClampedArray (RGBA) }`.
 *
 * Ablauf von `extractSignature()`:
 *   1. Helligkeit je Pixel; Papierhelligkeit lokal geschätzt (Kacheln, hohes Perzentil, geglättet)
 *      – so bleiben Fotos mit Helligkeitsverlauf und graue Scans beherrschbar.
 *   2. „Dunkelheit“ d = (Papier − Pixel) / Papier ∈ [0, 1].
 *   3. Schwelle nach Otsu auf d, nach unten begrenzt durch das Rauschen des Papiers und
 *      verschoben durch die Empfindlichkeit (0 … 100, Standard 50).
 *   4. Optional: lange, dünne waagerechte/senkrechte Linien (Formularlinien, Kästchen) entfernen –
 *      dort, wo ein Strich die Linie kreuzt, bleibt die Linie stehen, damit der Strich nicht reißt.
 *   5. Kleine Flecken (Staub, Rauschen) entfernen; nur Pixel in der Nähe echter Tinte behalten.
 *   6. Deckkraft (Alpha) aus der Dunkelheit mit weicher Kante (Abdeckungsmodell), Farbe je nach
 *      Option original (aus dem Papier herausgerechnet), schwarz oder dunkelblau.
 *   7. Auf die Tinte zuschneiden (mit kleinem Rand).
 */

/** Farben für die Option „Farbe“. */
export const INK_COLORS = {
  black: [0, 0, 0],
  blue: [22, 42, 122],
};

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

const smoothstep = (lo, hi, v) => {
  if (hi <= lo) return v >= hi ? 1 : 0;
  const t = clamp01((v - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
};

/** Helligkeit (0 … 255) je Pixel; transparente Pixel der Eingabe gelten als Papier (weiß). */
export function luminanceOf(img) {
  const { width, height, data } = img;
  const n = width * height;
  const lum = new Float32Array(n);
  for (let i = 0, p = 0; i < n; i++, p += 4) {
    const a = data[p + 3] / 255;
    const l = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    lum[i] = l * a + 255 * (1 - a);
  }
  return lum;
}

/** Perzentil aus einem Histogramm mit 256 Klassen. */
function histPercentile(hist, total, q) {
  const target = total * q;
  let sum = 0;
  for (let i = 0; i < 256; i++) {
    sum += hist[i];
    if (sum >= target) return i;
  }
  return 255;
}

/**
 * Papierhelligkeit je Pixel: Kacheln von ca. 1/6 der kürzeren Seite, darin das 90%-Perzentil,
 * Ausreißer (Kacheln voller Tinte) durch Median der Nachbarn ersetzt, bilinear interpoliert.
 */
export function estimateBackground(lum, width, height) {
  const cell = Math.max(24, Math.round(Math.min(width, height) / 6));
  const cols = Math.max(1, Math.ceil(width / cell));
  const rows = Math.max(1, Math.ceil(height / cell));
  const grid = new Float32Array(cols * rows);
  const hist = new Uint32Array(256);
  const globalHist = new Uint32Array(256);
  for (let i = 0; i < lum.length; i++) globalHist[lum[i] | 0]++;
  const globalBg = Math.max(histPercentile(globalHist, lum.length, 0.9), 1);
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      hist.fill(0);
      const x0 = cx * cell;
      const y0 = cy * cell;
      const x1 = Math.min(width, x0 + cell);
      const y1 = Math.min(height, y0 + cell);
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) hist[lum[y * width + x] | 0]++;
      grid[cy * cols + cx] = histPercentile(hist, (x1 - x0) * (y1 - y0), 0.9);
    }
  // Kacheln, die deutlich dunkler sind als das Papier insgesamt, enthalten v. a. Tinte.
  const fixed = new Float32Array(grid.length);
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      const v = grid[cy * cols + cx];
      if (v >= globalBg * 0.8) {
        fixed[cy * cols + cx] = v;
        continue;
      }
      const around = [];
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = cx + dx;
          const ny = cy + dy;
          if (nx >= 0 && ny >= 0 && nx < cols && ny < rows) {
            const w = grid[ny * cols + nx];
            if (w >= globalBg * 0.8) around.push(w);
          }
        }
      around.sort((a, b) => a - b);
      fixed[cy * cols + cx] = around.length ? around[around.length >> 1] : globalBg;
    }
  const bg = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(rows - 1, Math.max(0, (y + 0.5) / cell - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(rows - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < width; x++) {
      const gx = Math.min(cols - 1, Math.max(0, (x + 0.5) / cell - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(cols - 1, x0 + 1);
      const fx = gx - x0;
      const top = fixed[y0 * cols + x0] * (1 - fx) + fixed[y0 * cols + x1] * fx;
      const bottom = fixed[y1 * cols + x0] * (1 - fx) + fixed[y1 * cols + x1] * fx;
      bg[y * width + x] = Math.max(1, top * (1 - fy) + bottom * fy);
    }
  }
  return bg;
}

/** Schwelle nach Otsu für Werte in [0, 1] (256 Klassen). Rückgabe ebenfalls in [0, 1]. */
export function otsuThreshold(values) {
  const hist = new Float64Array(256);
  for (let i = 0; i < values.length; i++) hist[Math.min(255, (values[i] * 255) | 0)]++;
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < 256; i++) sumAll += i * hist[i];
  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let bestT = 0;
  for (let t = 0; t < 256; t++) {
    weightB += hist[t];
    if (!weightB) continue;
    const weightF = total - weightB;
    if (!weightF) break;
    sumB += t * hist[t];
    const meanB = sumB / weightB;
    const meanF = (sumAll - sumB) / weightF;
    const between = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return (bestT + 0.5) / 255;
}

/**
 * Entfernt lange, dünne Linien aus der Maske `core` (Uint8Array, 1 = Tinte). `horizontal` wählt
 * die Richtung. Eine Linie ist eine Folge von Tintenpixeln einer Zeile, die mindestens `minRun`
 * lang ist; senkrecht dazu darf das Band höchstens `maxThick` Pixel dick sein. Grenzt in einer
 * Spalte weitere Tinte an das Band (ein Strich kreuzt oder berührt die Linie), bleibt die Linie
 * dort stehen – so reißt der Strich nicht.
 * Gibt die Anzahl entfernter Pixel zurück.
 */
export function removeLines(core, width, height, { horizontal = true, minRun, maxThick }) {
  const len = horizontal ? width : height; // Länge in Laufrichtung
  const across = horizontal ? height : width;
  const idx = horizontal ? (i, j) => j * width + i : (i, j) => i * width + j; // i = längs, j = quer
  const line = new Uint8Array(width * height);
  let any = false;
  for (let j = 0; j < across; j++) {
    let start = -1;
    for (let i = 0; i <= len; i++) {
      const on = i < len && core[idx(i, j)];
      if (on && start < 0) start = i;
      else if (!on && start >= 0) {
        if (i - start >= minRun) {
          for (let k = start; k < i; k++) line[idx(k, j)] = 1;
          any = true;
        }
        start = -1;
      }
    }
  }
  if (!any) return 0;
  let removed = 0;
  for (let i = 0; i < len; i++) {
    let j = 0;
    while (j < across) {
      if (!line[idx(i, j)]) {
        j++;
        continue;
      }
      // Linienband an dieser Stelle (nur Linienpixel) …
      let j0 = j;
      let j1 = j;
      while (j1 + 1 < across && line[idx(i, j1 + 1)]) j1++;
      const lineThick = j1 - j0 + 1;
      j = j1 + 1;
      if (lineThick > maxThick) continue; // breiter Balken, keine Linie
      // … und mit angrenzender Tinte: Ist es dicker, kreuzt oder berührt ein Strich die Linie.
      let e0 = j0;
      let e1 = j1;
      while (e0 - 1 >= 0 && core[idx(i, e0 - 1)] && j1 - e0 < maxThick * 3) e0--;
      while (e1 + 1 < across && core[idx(i, e1 + 1)] && e1 - j0 < maxThick * 3) e1++;
      if (e1 - e0 + 1 > lineThick + 1) continue;
      for (let k = j0; k <= j1; k++) {
        const p = idx(i, k);
        if (core[p]) {
          core[p] = 0;
          removed++;
        }
      }
    }
  }
  return removed;
}

/**
 * Zusammenhangskomponenten (8er-Nachbarschaft) der Maske; Komponenten mit weniger als `minArea`
 * Pixeln werden entfernt. Rückgabe: Anzahl verbliebener Komponenten.
 */
export function removeSpecks(mask, width, height, minArea) {
  const label = new Int32Array(width * height);
  const stack = new Int32Array(width * height);
  let kept = 0;
  let next = 0;
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start]) continue;
    next++;
    let sp = 0;
    let count = 0;
    stack[sp++] = start;
    label[start] = next;
    const members = [];
    while (sp) {
      const p = stack[--sp];
      members.push(p);
      count++;
      const x = p % width;
      const y = (p - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if (nx < 0 || nx >= width || (!dx && !dy)) continue;
          const q = ny * width + nx;
          if (mask[q] && !label[q]) {
            label[q] = next;
            stack[sp++] = q;
          }
        }
      }
    }
    if (count < minArea) for (const p of members) mask[p] = 0;
    else kept++;
  }
  return kept;
}

/** Dilatation einer 0/1-Maske um `radius` Pixel (quadratisches Fenster, getrennt je Achse). */
function dilate(mask, width, height, radius) {
  const tmp = new Uint8Array(mask.length);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) {
      let on = 0;
      for (let k = Math.max(0, x - radius), e = Math.min(width - 1, x + radius); k <= e && !on; k++)
        on = mask[row + k];
      tmp[row + x] = on;
    }
  }
  for (let x = 0; x < width; x++)
    for (let y = 0; y < height; y++) {
      let on = 0;
      for (let k = Math.max(0, y - radius), e = Math.min(height - 1, y + radius); k <= e && !on; k++)
        on = tmp[k * width + x];
      out[y * width + x] = on;
    }
  return out;
}

/**
 * Stellt die Unterschrift in `img` frei.
 * @param {{width:number,height:number,data:Uint8ClampedArray}} img  Quellbild (RGBA)
 * @param {object} [opts]
 * @param {number} [opts.sensitivity=50]  0 … 100; höher = auch blasse Striche übernehmen
 * @param {'original'|'black'|'blue'} [opts.color='original']
 * @param {boolean} [opts.removeLines=true]  Formularlinien entfernen
 * @param {number} [opts.dpi=600]  Auflösung der Quelle (für Größen von Flecken/Linien/Rand)
 * @param {boolean} [opts.crop=true]  auf die Tinte zuschneiden
 * @returns {null | { image, bbox:[x0,y0,x1,y1], threshold:number, inkPixels:number }}
 *   `image` ist das freigestellte RGBA-Bild, `bbox` der Ausschnitt in Pixeln der Quelle
 *   (x1/y1 exklusiv). `null`, wenn keine Tinte gefunden wurde.
 */
export function extractSignature(img, opts = {}) {
  const { width, height, data } = img;
  const sensitivity = opts.sensitivity == null ? 50 : opts.sensitivity;
  const dpi = opts.dpi || 600;
  const color = opts.color || 'original';
  const n = width * height;
  if (!n) return null;
  const lum = luminanceOf(img);
  const bg = estimateBackground(lum, width, height);
  const dark = new Float32Array(n);
  for (let i = 0; i < n; i++) dark[i] = clamp01((bg[i] - lum[i]) / Math.max(bg[i], 40));

  // Schwelle: Otsu, nicht unter dem Rauschpegel des Papiers, verschoben durch die Empfindlichkeit.
  const otsu = otsuThreshold(dark);
  let noiseSum = 0;
  let noiseCount = 0;
  for (let i = 0; i < n; i++)
    if (dark[i] < otsu) {
      noiseSum += dark[i] * dark[i];
      noiseCount++;
    }
  const noise = noiseCount ? Math.sqrt(noiseSum / noiseCount) : 0;
  const factor = Math.pow(1.8, (50 - sensitivity) / 50); // 100 → 0,56 · 50 → 1 · 0 → 1,8
  const floor = Math.max(0.04, 4 * noise) * Math.min(1, factor * 1.25);
  const threshold = Math.min(0.9, Math.max(floor, Math.min(otsu, 0.5) * factor));

  const core = new Uint8Array(n);
  let coreCount = 0;
  for (let i = 0; i < n; i++)
    if (dark[i] >= threshold) {
      core[i] = 1;
      coreCount++;
    }
  if (!coreCount) return null;

  const px = dpi / 25.4; // Pixel je mm
  if (opts.removeLines !== false) {
    const maxThick = Math.max(3, Math.round(px * 0.9)); // Linien bis ca. 0,9 mm (≈ 2,5 pt)
    removeLines(core, width, height, {
      horizontal: true,
      minRun: Math.max(Math.round(px * 25), Math.round(width * 0.45)),
      maxThick,
    });
    removeLines(core, width, height, {
      horizontal: false,
      minRun: Math.max(Math.round(px * 12), Math.round(height * 0.6)),
      maxThick,
    });
  }
  const minArea = Math.max(4, Math.round(px * px * 0.05)); // ≈ 0,05 mm² – i-Punkte bleiben
  removeSpecks(core, width, height, minArea);

  // Typische Dunkelheit voller Tinte (Median der Kernpixel) für das Abdeckungsmodell.
  const hist = new Uint32Array(256);
  let kept = 0;
  for (let i = 0; i < n; i++)
    if (core[i]) {
      hist[Math.min(255, (dark[i] * 255) | 0)]++;
      kept++;
    }
  if (!kept) return null;
  const inkLevel = Math.max(threshold * 1.15, histPercentile(hist, kept, 0.5) / 255);
  const near = dilate(core, width, height, Math.max(1, Math.round(px * 0.12)));

  // Alpha: Abdeckung d / Tinte, unterhalb der Schwelle weich ausgeblendet; Farbe je nach Option.
  const alpha = new Float32Array(n);
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let sumW = 0;
  for (let i = 0; i < n; i++) {
    if (!near[i]) continue;
    const d = dark[i];
    const a = clamp01(d / inkLevel) * smoothstep(threshold * 0.5, threshold, d);
    alpha[i] = a;
    if (core[i] && a > 0.9) {
      const p = i * 4;
      sumR += data[p];
      sumG += data[p + 1];
      sumB += data[p + 2];
      sumW++;
    }
  }
  const meanInk = sumW ? [sumR / sumW, sumG / sumW, sumB / sumW] : [0, 0, 0];

  // Zuschnitt
  let x0 = 0;
  let y0 = 0;
  let x1 = width;
  let y1 = height;
  if (opts.crop !== false) {
    x0 = width;
    y0 = height;
    x1 = -1;
    y1 = -1;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++)
        if (alpha[y * width + x] > 0.03) {
          if (x < x0) x0 = x;
          if (x > x1) x1 = x;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    if (x1 < 0) return null;
    const pad = Math.max(2, Math.round(px * 0.8));
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(width, x1 + pad + 1);
    y1 = Math.min(height, y1 + pad + 1);
  }
  const outW = x1 - x0;
  const outH = y1 - y0;
  const out = new Uint8ClampedArray(outW * outH * 4);
  const fixedColor = INK_COLORS[color] || null;
  let inkPixels = 0;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) {
      const i = y * width + x;
      const o = ((y - y0) * outW + (x - x0)) * 4;
      const a = alpha[i];
      if (a <= 0.004) continue;
      if (a > 0.5) inkPixels++;
      let rgb = fixedColor;
      if (!rgb) {
        // Originalfarbe: Papieranteil herausrechnen (C = a·I + (1−a)·P); am Rand Mittelwert der Tinte.
        if (a < 0.6) rgb = meanInk;
        else {
          const p = i * 4;
          const paper = bg[i];
          rgb = [0, 1, 2].map((c) => Math.max(0, Math.min(255, (data[p + c] - (1 - a) * paper) / a)));
        }
      }
      out[o] = rgb[0];
      out[o + 1] = rgb[1];
      out[o + 2] = rgb[2];
      out[o + 3] = Math.round(a * 255);
    }
  return {
    image: { width: outW, height: outH, data: out },
    bbox: [x0, y0, x1, y1],
    threshold,
    inkPixels,
  };
}

/** Schneidet ein RGBA-Bild auf seine nicht transparenten Pixel zu (für gezeichnete Unterschriften). */
export function cropToAlpha(img, pad = 0) {
  const { width, height, data } = img;
  let x0 = width;
  let y0 = height;
  let x1 = -1;
  let y1 = -1;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++)
      if (data[(y * width + x) * 4 + 3] > 6) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (x1 < 0) return null;
  x0 = Math.max(0, x0 - pad);
  y0 = Math.max(0, y0 - pad);
  x1 = Math.min(width, x1 + pad + 1);
  y1 = Math.min(height, y1 + pad + 1);
  const outW = x1 - x0;
  const outH = y1 - y0;
  const out = new Uint8ClampedArray(outW * outH * 4);
  for (let y = 0; y < outH; y++)
    out.set(data.subarray(((y + y0) * width + x0) * 4, ((y + y0) * width + x1) * 4), y * outW * 4);
  return { image: { width: outW, height: outH, data: out }, bbox: [x0, y0, x1, y1] };
}

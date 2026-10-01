/**
 * Einheiten-, Farb- und Rechteck-Hilfen für die Oberfläche.
 */

export const ptToMm = (pt) => (pt / 72) * 25.4;

export const mmToPt = (mm) => (mm / 25.4) * 72;

export const rgbToHex = (rgb) =>
  '#' +
  rgb
    .map((e) =>
      Math.round(e * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('');

export const hexToRgb = (hex) => [1, 3, 5].map((e) => parseInt(hex.substr(e, 2), 16) / 255);

export const boxInside = (inner, outer) =>
  inner[0] >= outer[0] - 0.5 &&
  inner[1] >= outer[1] - 0.5 &&
  inner[2] <= outer[2] + 0.5 &&
  inner[3] <= outer[3] + 0.5;

export const boxContains = (box, x, y, tolerance = 0) =>
  x >= box[0] - tolerance && x <= box[2] + tolerance && y >= box[1] - tolerance && y <= box[3] + tolerance;

export const unionBoxes = (boxes) =>
  boxes.reduce(
    (e, t) => [Math.min(e[0], t[0]), Math.min(e[1], t[1]), Math.max(e[2], t[2]), Math.max(e[3], t[3])],
    [Infinity, Infinity, -Infinity, -Infinity],
  );

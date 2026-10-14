/**
 * Kleine Vorschaubilder für Listen (Fotos): Die Originale sind groß; als 34-px-Vorschau würden sie bei
 * jedem Neuaufbau der Liste voll dekodiert. Je Bild einmal verkleinert und gemerkt.
 */
const cache = new WeakMap();

/** Vorschau (JPEG, längste Seite `max` px) als Data-URL; leer, wenn das Bild nicht lesbar ist. */
export function thumbOf(image, max = 96) {
  if (!image || !image.data) return Promise.resolve('');
  let job = cache.get(image);
  if (!job) {
    job = (async () => {
      const el = new Image();
      el.src = image.data;
      await el.decode();
      const scale = Math.min(1, max / Math.max(el.naturalWidth, el.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(el.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(el.naturalHeight * scale));
      const g = canvas.getContext('2d');
      g.fillStyle = '#fff';
      g.fillRect(0, 0, canvas.width, canvas.height);
      g.drawImage(el, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', 0.72);
    })().catch(() => '');
    cache.set(image, job);
  }
  return job;
}

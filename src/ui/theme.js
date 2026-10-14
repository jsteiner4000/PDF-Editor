/**
 * Darstellung: Hell, Dunkel oder wie das System. Die Wahl liegt in localStorage; `data-theme` am
 * Wurzelelement ist immer der aufgelöste Wert („light“ / „dark“) – die Farben hängen im Stylesheet daran.
 */
const KEY = 'pdfix.theme';

export const THEMES = [
  ['light', 'Hell'],
  ['dark', 'Dunkel'],
  ['system', 'Wie System'],
];

const query = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: dark)') : null;

/** Gespeicherte Wahl: 'light' | 'dark' | 'system' (Standard). */
export function readTheme() {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** Darstellung setzen (ohne zu speichern). */
export function applyTheme(mode = readTheme()) {
  const dark = mode === 'dark' || (mode === 'system' && !!query && query.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** Wahl speichern und sofort anwenden. */
export function setTheme(mode) {
  try {
    if (mode === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {}
  applyTheme(mode);
}

// „Wie System“: Wechsel des Systems zur Laufzeit übernehmen
if (query) query.addEventListener('change', () => readTheme() === 'system' && applyTheme('system'));

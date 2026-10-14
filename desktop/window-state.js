/**
 * Fenstergröße, -position und Darstellung (Hell/Dunkel) merken (userData/window-state.json).
 */
import { app, screen } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_SIZE = { width: 1280, height: 860 };
export const MIN_SIZE = { width: 900, height: 600 };

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');
const THEMES = ['light', 'dark', 'system'];
let theme = 'system';

/** Darstellung der App (für Titelleiste und Fensterhintergrund schon beim nächsten Start). */
export function rememberTheme(value) {
  if (THEMES.includes(value)) theme = value;
}

/**
 * Gespeicherte Fenstergrenzen – nur, wenn sie noch auf einem vorhandenen Bildschirm liegen – und
 * die zuletzt gewählte Darstellung.
 */
export function loadWindowState() {
  let s = null;
  try {
    s = JSON.parse(readFileSync(stateFile(), 'utf8'));
  } catch {}
  rememberTheme(s && s.theme);
  return { ...bounds(s), theme };
}

function bounds(s) {
  try {
    const bounds = {
      x: Math.round(s.x),
      y: Math.round(s.y),
      width: Math.max(MIN_SIZE.width, Math.round(s.width)),
      height: Math.max(MIN_SIZE.height, Math.round(s.height)),
    };
    if (Object.values(bounds).some((v) => !Number.isFinite(v))) throw new Error();
    const area = screen.getDisplayMatching(bounds).workArea;
    const visible =
      bounds.x < area.x + area.width - 100 &&
      bounds.x + bounds.width > area.x + 100 &&
      bounds.y >= area.y - 10 &&
      bounds.y < area.y + area.height - 100;
    return visible ? bounds : { ...DEFAULT_SIZE };
  } catch {
    return { ...DEFAULT_SIZE };
  }
}

/** Speichert die Grenzen beim Schließen (im maximierten Zustand die „normalen“ Grenzen für „Verkleinern“). */
export function trackWindowState(win) {
  const save = () => {
    try {
      const b = win.getNormalBounds();
      mkdirSync(path.dirname(stateFile()), { recursive: true });
      writeFileSync(stateFile(), JSON.stringify({ ...b, theme }));
    } catch {}
  };
  win.on('close', save);
}

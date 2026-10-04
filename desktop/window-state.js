/**
 * Fenstergröße und -position merken (userData/window-state.json).
 */
import { app, screen } from 'electron';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_SIZE = { width: 1280, height: 860 };
export const MIN_SIZE = { width: 900, height: 600 };

const stateFile = () => path.join(app.getPath('userData'), 'window-state.json');

/** Gespeicherte Fenstergrenzen – nur, wenn sie noch auf einem vorhandenen Bildschirm liegen. */
export function loadWindowState() {
  try {
    const s = JSON.parse(readFileSync(stateFile(), 'utf8'));
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
    return visible ? { ...bounds, maximized: !!s.maximized } : { ...DEFAULT_SIZE, maximized: !!s.maximized };
  } catch {
    return { ...DEFAULT_SIZE, maximized: false };
  }
}

/** Speichert die Grenzen beim Schließen (im maximierten Zustand die „normalen“ Grenzen). */
export function trackWindowState(win) {
  const save = () => {
    try {
      const b = win.getNormalBounds();
      mkdirSync(path.dirname(stateFile()), { recursive: true });
      writeFileSync(stateFile(), JSON.stringify({ ...b, maximized: win.isMaximized() }));
    } catch {}
  };
  win.on('close', save);
}

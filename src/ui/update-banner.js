/**
 * Hinweis „Update verfügbar“ (Desktop-App): unten rechts, nicht blockierend. „Jetzt aktualisieren“
 * lädt im Hauptprozess (Fortschritt hier und in der Taskleiste), prüft die Datei und startet neu;
 * „Später“ blendet den Hinweis aus (beim nächsten Start bzw. über „Hilfe › Nach Updates suchen …“
 * wieder).
 */
import { escapeHtml, htmlToElement } from './dom.js';
import { icon } from './icons.js';

let el = null;

export function showUpdate({ version, current } = {}, install) {
  el?.remove();
  el = htmlToElement(
    `<div class="upd" role="status" aria-live="polite">
      <span class="upd-ic">${icon('download')}</span>
      <div class="upd-tx"><b>PlantPDF ${escapeHtml(String(version || ''))} ist verfügbar</b><small>Installiert: ${escapeHtml(String(current || ''))}</small>
        <div class="upd-bar" hidden><i></i></div></div>
      <div class="upd-act"><button type="button" class="btn" data-a="later">Später</button><button type="button" class="btn primary" data-a="go">Jetzt aktualisieren</button></div>
    </div>`,
  );
  el.querySelector('[data-a="later"]').addEventListener('click', () => {
    el.remove();
    el = null;
  });
  el.querySelector('[data-a="go"]').addEventListener('click', async () => {
    updateProgress(0);
    try {
      await install();
    } catch {
      updateProgress(-1);
    }
  });
  el.dataset.current = String(current || '');
  document.body.appendChild(el);
}

/** Fortschritt 0…1; −1 = abgebrochen (Knöpfe wieder bereit). */
export function updateProgress(p) {
  if (!el) return;
  const busy = typeof p === 'number' && p >= 0;
  const bar = el.querySelector('.upd-bar');
  bar.hidden = !busy;
  bar.firstElementChild.style.width = busy ? Math.round(Math.min(1, p) * 100) + '%' : '0';
  el.querySelector('small').textContent = busy
    ? p >= 1
      ? 'Geprüft – PlantPDF startet neu …'
      : `Wird geladen … ${Math.round(p * 100)} %`
    : `Installiert: ${el.dataset.current}`;
  for (const b of el.querySelectorAll('button')) b.disabled = busy;
}

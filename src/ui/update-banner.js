/**
 * Update in der Desktop-App: Hinweis „Update verfügbar“ unten rechts (nicht blockierend) und – sobald
 * geladen wird – eine eigene Ladeanzeige mittig: Fortschrittsring mit Prozent und Megabyte, kurzes
 * Prüfen (Ring dreht), zum Schluss ein Häkchen „PlantPDF startet neu …“. Laden lässt sich abbrechen.
 * Der Hauptprozess meldet den Stand über `updateProgress({ p, total, version, phase })`.
 */
import { escapeHtml, htmlToElement } from './dom.js';
import { icon } from './icons.js';

let banner = null;
let overlay = null;
let cancel = null;

const R = 52;
/** Haken (Koordinaten im Ring) und kleine Lichtpunkte, die am Ende kurz auffunkeln. */
const CHECK = 'M42 61l12 12 25-26';
const TWINKLES = [
  [80.5, 44, 1.8, '#ffffff'],
  [74, 41, 1.3, '#bae6fd'],
  [84, 51, 1.2, '#e0f2fe'],
  [57, 77, 1.3, '#bae6fd'],
  [39, 57, 1.1, '#ffffff'],
];
const LEN = 2 * Math.PI * R;
const mb = (bytes) => (bytes / 1048576).toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 });

export function showUpdate({ version, current } = {}, install, abort = null) {
  banner?.remove();
  cancel = abort;
  banner = htmlToElement(
    `<div class="upd" role="status" aria-live="polite">
      <span class="upd-ic">${icon('download')}</span>
      <div class="upd-tx"><b>PlantPDF ${escapeHtml(String(version || ''))} ist verfügbar</b><small>Installiert: ${escapeHtml(String(current || ''))}</small></div>
      <div class="upd-act"><button type="button" class="btn" data-a="later">Später</button><button type="button" class="btn primary" data-a="go">Jetzt aktualisieren</button></div>
    </div>`,
  );
  banner.querySelector('[data-a="later"]').addEventListener('click', () => {
    banner.remove();
    banner = null;
  });
  banner.querySelector('[data-a="go"]').addEventListener('click', async () => {
    updateProgress({ p: 0, version });
    let ok = false;
    try {
      ok = await install();
    } catch {}
    // nicht gestartet (z. B. läuft schon in einem anderen Tab) oder abgebrochen: Anzeige schließen
    if (!ok) updateProgress({ p: -1 });
  });
  document.body.appendChild(banner);
}

/** Merkt sich die Abbruch-Funktion (auch ohne Hinweis, z. B. über „Hilfe › Nach Updates suchen …“). */
export const setUpdateCancel = (fn) => (cancel = fn);

function ensureOverlay(version) {
  if (overlay) return overlay;
  overlay = htmlToElement(
    `<div class="updx" role="dialog" aria-modal="true" aria-label="Update wird geladen">
      <div class="updx-card">
        <div class="updx-ring">
          <svg viewBox="0 0 120 120" aria-hidden="true">
            <defs>
              <linearGradient id="updxGrad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="var(--acc)"/><stop offset="1" stop-color="var(--acc-line)"/></linearGradient>
              <linearGradient id="updxCheckGrad" gradientUnits="userSpaceOnUse" x1="42" y1="73" x2="79" y2="47"><stop offset="0" stop-color="#1d4ed8"/><stop offset="0.55" stop-color="var(--acc)"/><stop offset="1" stop-color="#7dd3fc"/></linearGradient>
            </defs>
            <circle class="updx-track" cx="60" cy="60" r="${R}"/>
            <circle class="updx-arc" cx="60" cy="60" r="${R}" stroke-dasharray="${LEN}" stroke-dashoffset="${LEN}"/>
            <circle class="updx-sheen" cx="60" cy="60" r="${R}" stroke-dasharray="14 ${LEN}"/>
            <g class="updx-checkg" transform="rotate(90 60 60)">
              <path class="updx-check" d="${CHECK}"/>
              <path class="updx-shine" d="${CHECK}"/>
              <circle class="updx-tip" r="3.6"><animateMotion dur="0.6s" begin="indefinite" fill="freeze" path="${CHECK}" calcMode="spline" keyPoints="0;1" keyTimes="0;1" keySplines="0.65 0 0.35 1"/></circle>
              ${TWINKLES.map(([x, y, r, c], i) => `<circle class="updx-tw" cx="${x}" cy="${y}" r="${r}" fill="${c}" style="animation-delay:${0.62 + i * 0.05}s"/>`).join('')}
            </g>
          </svg>
          <div class="updx-pct"><b>0</b><span>%</span></div>
        </div>
        <h3>PlantPDF ${escapeHtml(String(version || ''))} wird geladen</h3>
        <p class="updx-sub" aria-live="polite">Verbindung wird aufgebaut …</p>
        <button type="button" class="btn updx-cancel">Abbrechen</button>
      </div>
    </div>`,
  );
  overlay.querySelector('.updx-cancel').addEventListener('click', () => {
    overlay.querySelector('.updx-cancel').disabled = true;
    overlay.querySelector('.updx-sub').textContent = 'Wird abgebrochen …';
    if (cancel) cancel();
  });
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay && overlay.classList.add('in'));
  return overlay;
}

function closeOverlay() {
  if (!overlay) return;
  const el = overlay;
  overlay = null;
  el.classList.remove('in');
  setTimeout(() => el.remove(), 220);
}

/**
 * Stand des Updates: `p` 0…1 beim Laden (mit `total` Bytes), `phase: 'install'` nach dem Prüfen,
 * `p: -1` abgebrochen/fehlgeschlagen (Anzeige schließt, Hinweis wieder bedienbar).
 */
export function updateProgress(data = {}) {
  const { p = 0, total = 0, version = '', phase = '' } = typeof data === 'number' ? { p: data } : data || {};
  if (p < 0 && !phase) {
    closeOverlay();
    if (banner) for (const b of banner.querySelectorAll('button')) b.disabled = false;
    return;
  }
  if (banner) for (const b of banner.querySelectorAll('button')) b.disabled = true;
  const el = ensureOverlay(version);
  const arc = el.querySelector('.updx-arc');
  const pct = el.querySelector('.updx-pct b');
  const sub = el.querySelector('.updx-sub');
  if (phase === 'install') {
    if (el.classList.contains('done')) return;
    el.classList.remove('verify');
    // erst den Ring vollaufen lassen, dann Haken zeichnen und „Hurra“-Glitzer
    arc.style.strokeDashoffset = '0';
    el.querySelector('.updx-cancel').hidden = true;
    setTimeout(() => {
      if (!el.isConnected) return;
      el.classList.add('done');
      el.querySelector('h3').textContent = 'Update bereit';
      sub.textContent = 'PlantPDF startet neu …';
      // leuchtende Stiftspitze fährt den Haken entlang
      if (!matchMedia('(prefers-reduced-motion: reduce)').matches) el.querySelector('.updx-tip animateMotion')?.beginElement();
    }, 380);
    return;
  }
  const f = Math.max(0, Math.min(1, p));
  arc.style.strokeDashoffset = String(LEN * (1 - f));
  pct.textContent = String(Math.floor(f * 100));
  if (f >= 1) {
    el.classList.add('verify');
    sub.textContent = 'Wird geprüft …';
    el.querySelector('.updx-cancel').disabled = true;
  } else if (total > 0) sub.textContent = `${mb(f * total)} von ${mb(total)} MB`;
}


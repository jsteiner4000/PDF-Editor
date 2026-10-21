/**
 * Eigene Titelleiste der Desktop-App (Windows/Linux): Die Menüs „Datei“ bis „Hilfe“ stehen in der
 * Kopfzeile der App, die zugleich das Fenster zieht; die Fenstertasten legt das System rechts darüber.
 * Die Menüs selbst sind die nativen (desktop/menu.js) – gleiche Befehle, Kürzel und Zustände.
 *
 * Tastatur wie unter Windows: Alt allein oder F10 setzt den Fokus in die Menüleiste, Pfeiltasten
 * wechseln, Eingabe/Leertaste/Pfeil nach unten öffnen, Esc kehrt zurück.
 */
import { icon } from '../ui/icons.js';
import { htmlToElement } from '../ui/dom.js';

/** Reihenfolge wie im nativen Menü (desktop/menu.js). */
export const MENUS = ['Datei', 'Bearbeiten', 'Ansicht', 'Werkzeuge', 'Fenster', 'Hilfe'];

export function installTitleBar(desktop) {
  const top = document.getElementById('top');
  if (!top || !desktop.popupMenu) return;
  document.documentElement.classList.add('frame');
  const bar = htmlToElement(
    `<nav class="menubar" role="menubar" aria-label="Menü">${MENUS.map(
      (label, i) => `<button type="button" class="mb" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-i="${i}" tabindex="-1">${label}</button>`,
    ).join('')}<button type="button" class="mb mb-all" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-i="-1" tabindex="-1" title="Menü" aria-label="Menü">${icon('menu')}</button></nav>`,
  );
  const sep = htmlToElement('<div class="sep mb-sep"></div>');
  top.querySelector('.brand').after(bar, sep);

  const items = [...bar.querySelectorAll('.mb')];
  const visible = () => items.filter((b) => b.offsetParent);
  let back = null;

  const open = async (button) => {
    if (button.getAttribute('aria-expanded') === 'true') return;
    const r = button.getBoundingClientRect();
    button.setAttribute('aria-expanded', 'true');
    try {
      await desktop.popupMenu(Number(button.dataset.i), r.left, r.bottom + 4);
    } finally {
      button.setAttribute('aria-expanded', 'false');
    }
  };
  const focusBar = (button = visible()[0]) => {
    if (!button) return;
    if (!bar.contains(document.activeElement)) back = document.activeElement;
    for (const b of items) b.tabIndex = b === button ? 0 : -1;
    button.focus();
  };
  const leave = () => {
    const target = back && back.isConnected ? back : null;
    back = null;
    for (const b of items) b.tabIndex = -1;
    if (target && target !== document.body) target.focus();
    else document.activeElement.blur();
  };

  for (const b of items) {
    b.addEventListener('click', () => open(b));
    // Fokus nicht in die Leiste ziehen: Ausschneiden/Kopieren wirkt weiter auf das Textfeld
    b.addEventListener('mousedown', (ev) => ev.preventDefault());
  }
  bar.addEventListener('keydown', (ev) => {
    const list = visible();
    const at = list.indexOf(document.activeElement);
    if (at < 0) return;
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      ev.preventDefault();
      focusBar(list[(at + (ev.key === 'ArrowRight' ? 1 : -1) + list.length) % list.length]);
    } else if (ev.key === 'Enter' || ev.key === ' ' || ev.key === 'ArrowDown') {
      ev.preventDefault();
      open(list[at]);
    } else if (ev.key === 'Escape' || ev.key === 'Tab') {
      ev.preventDefault();
      leave();
    }
  });
  bar.addEventListener('focusout', (ev) => {
    if (!bar.contains(ev.relatedTarget)) for (const b of items) b.tabIndex = -1;
  });

  // Alt allein bzw. F10: Menüleiste. Alt zusammen mit anderen Tasten oder der Maus (Alt+Klick im
  // Editor) zählt nicht – das Loslassen nach Mausbenutzung hält schon der Hauptprozess zurück.
  let altAlone = false;
  window.addEventListener(
    'keydown',
    (ev) => {
      altAlone = ev.key === 'Alt' && !ev.repeat ? !ev.ctrlKey && !ev.shiftKey && !ev.metaKey : false;
      if (ev.key === 'F10' && !ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey && !document.querySelector('.backdrop')) {
        ev.preventDefault();
        bar.contains(document.activeElement) ? leave() : focusBar();
      }
    },
    true,
  );
  window.addEventListener('pointerdown', () => (altAlone = false), true);
  window.addEventListener(
    'keyup',
    (ev) => {
      if (ev.key !== 'Alt' || !altAlone) return;
      altAlone = false;
      if (document.querySelector('.backdrop')) return;
      ev.preventDefault();
      bar.contains(document.activeElement) ? leave() : focusBar();
    },
    true,
  );
  window.addEventListener('blur', () => (altAlone = false));
}

/**
 * Kopfzeile passend halten: Reicht der Platz nicht für die geöffneten Reiter (lange Titel,
 * schmales Fenster), stehen zuerst die Menüs „Datei“ bis „Hilfe“ in einem Menüknopf; reicht es
 * dann noch nicht, entfällt der Schriftzug neben dem Logo und der Bereichsumschalter wird schmaler;
 * ganz zuletzt zeigen die Reiter nur noch Symbol und Schließen.
 * Gemessen wird bei jeder Größen- oder Inhaltsänderung der Kopfzeile.
 */
export function keepTopBarFitting(top) {
  const tabs = top.querySelector('#tabs');
  if (!tabs || !window.ResizeObserver) return;
  const watch = { subtree: true, childList: true, characterData: true, attributeFilter: ['class'] };
  const mo = new MutationObserver(() => fit());
  // zu eng: Reiter laufen über, oder ein Dokumenttitel wird gekürzt und der Reiter ist schmaler
  // als 220 px (darüber bleibt der Titel gut erkennbar und die Menüs bleiben sichtbar)
  const squeezed = () =>
    tabs.scrollWidth > tabs.clientWidth + 1 ||
    [...tabs.querySelectorAll('.doctab:not(.hidden)')].some((t) => {
      const nm = t.querySelector('.nm');
      return nm && nm.scrollWidth > nm.clientWidth + 1 && t.getBoundingClientRect().width < 220;
    });
  const fit = () => {
    // eigene Änderungen nicht wieder als Anlass nehmen
    mo.disconnect();
    const bar = top.querySelector('.menubar');
    top.classList.remove('tight', 'tighter');
    if (bar) bar.classList.remove('compact');
    if (squeezed() && bar) bar.classList.add('compact');
    if (squeezed()) top.classList.add('tight');
    if (tabs.scrollWidth > tabs.clientWidth + 1) top.classList.add('tighter');
    mo.observe(top, watch);
  };
  new ResizeObserver(fit).observe(top);
  mo.observe(top, watch);
}

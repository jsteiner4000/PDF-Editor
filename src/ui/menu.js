/**
 * Kontext- und Dropdown-Menüs.
 */
import { icon } from './icons.js';
import { escapeHtml, htmlToElement } from './dom.js';

let openMenuEl = null;

export function closeMenu() {
  if (openMenuEl) {
    openMenuEl.remove();
    openMenuEl = null;
  }
}

export function showMenu(items, anchor) {
  const menu = htmlToElement('<div class="menu" role="menu"></div>');
  for (const item of items) {
    if (item === '-') {
      menu.appendChild(document.createElement('hr'));
      continue;
    }
    const button = htmlToElement(
      `<button class="mi" role="menuitem">${item.checked ? icon('check', 's') : item.icon ? icon(item.icon, 's') : '<span style="width:16px"></span>'}<span>${escapeHtml(item.label)}</span>${item.key ? `<span class="k">${escapeHtml(item.key)}</span>` : ''}</button>`,
    );
    if (item.checked !== undefined)
      (button.setAttribute('role', 'menuitemcheckbox'),
        button.setAttribute('aria-checked', String(!!item.checked)));
    if (item.disabled) button.disabled = true;
    button.addEventListener('click', () => {
      closeMenu();
      if (item.run) item.run();
    });
    menu.appendChild(button);
  }
  return showPopover(menu, anchor);
}

/**
 * Beliebiges Element als aufklappendes Feld unter `anchor` (Element oder { x, y }) zeigen – z. B.
 * eine Galerie. Schließt bei Klick daneben und mit Esc, wie ein Menü.
 */
export function showPopover(el, anchor) {
  closeMenu();
  document.body.appendChild(el);
  let x;
  let y;
  if (anchor instanceof Element) {
    const anchorRect = anchor.getBoundingClientRect();
    x = anchorRect.left;
    y = anchorRect.bottom + 4;
  } else {
    x = anchor.x;
    y = anchor.y;
  }
  const rect = el.getBoundingClientRect();
  x = Math.min(x, innerWidth - rect.width - 8);
  y = Math.min(y, innerHeight - rect.height - 8);
  el.style.left = Math.max(8, x) + 'px';
  el.style.top = Math.max(8, y) + 'px';
  openMenuEl = el;
  setTimeout(() => {
    const onOutside = (ev) => {
      if (!el.contains(ev.target)) {
        if (openMenuEl === el) closeMenu();
        document.removeEventListener('pointerdown', onOutside, true);
      }
    };
    document.addEventListener('pointerdown', onOutside, true);
  });
  return el;
}

document.addEventListener(
  'keydown',
  (ev) => {
    if (ev.key === 'Escape' && openMenuEl) {
      closeMenu();
      ev.stopPropagation();
    }
  },
  true,
);

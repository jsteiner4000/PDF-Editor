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
  closeMenu();
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
  document.body.appendChild(menu);
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
  const rect = menu.getBoundingClientRect();
  x = Math.min(x, innerWidth - rect.width - 8);
  y = Math.min(y, innerHeight - rect.height - 8);
  menu.style.left = Math.max(8, x) + 'px';
  menu.style.top = Math.max(8, y) + 'px';
  openMenuEl = menu;
  setTimeout(() => {
    const onOutside = (ev) => {
      if (!menu.contains(ev.target)) {
        closeMenu();
        document.removeEventListener('pointerdown', onOutside, true);
      }
    };
    document.addEventListener('pointerdown', onOutside, true);
  });
  return menu;
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

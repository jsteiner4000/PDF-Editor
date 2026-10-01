/**
 * Dialoge, Hinweise (Toasts), Wartesymbol, Datei-Auswahl und Download.
 */
import { icon } from './icons.js';
import { escapeHtml, htmlToElement } from './dom.js';

export function showDialog(opts) {
  return new Promise((resolve) => {
    const backdrop = htmlToElement('<div class="backdrop"></div>');
    const dialog = htmlToElement(
      `<div class="dlg" role="dialog" aria-modal="true"><div class="dh">${opts.icon ? icon(opts.icon) : ''}<span>${escapeHtml(opts.title || '')}</span></div><div class="db"></div><div class="df"></div></div>`,
    );
    const body = dialog.querySelector('.db');
    if (opts.body instanceof Element) body.appendChild(opts.body);
    else body.innerHTML = opts.body || '';
    const footer = dialog.querySelector('.df');
    const close = (l) => {
      backdrop.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(l);
    };
    (opts.buttons || [{ label: 'OK', primary: true, value: true }]).forEach((l) => {
      const el = htmlToElement(
        `<button class="btn ${l.primary ? 'primary' : 'outline'}">${escapeHtml(l.label)}</button>`,
      );
      el.addEventListener('click', () => close(typeof l.value == 'function' ? l.value(body) : l.value));
      footer.appendChild(el);
    });
    const onKey = (l) => {
      if (l.key === 'Escape') {
        l.preventDefault();
        l.stopPropagation();
        close(opts.cancelValue !== undefined ? opts.cancelValue : null);
      }
      if (
        l.key === 'Enter' &&
        !(l.target instanceof HTMLTextAreaElement) &&
        !(l.target instanceof HTMLSelectElement)
      ) {
        const primaryBtn = (opts.buttons || []).find((h) => h.primary);
        if (primaryBtn) {
          l.preventDefault();
          l.stopPropagation();
          close(typeof primaryBtn.value == 'function' ? primaryBtn.value(body) : primaryBtn.value);
        }
      }
    };
    document.addEventListener('keydown', onKey, true);
    backdrop.addEventListener('pointerdown', (ev) => {
      if (ev.target === backdrop && opts.dismiss !== false)
        close(opts.cancelValue !== undefined ? opts.cancelValue : null);
    });
    backdrop.appendChild(dialog);
    document.body.appendChild(backdrop);
    const primary = dialog.querySelector('.btn.primary');
    if (primary) primary.focus();
  });
}

export function toast(message, kind = '', duration = 2600) {
  const el = htmlToElement(
    `<div class="toast ${kind}">${kind === 'warn' || kind === 'err' ? icon('warn', 's') : icon('check', 's')}<span></span></div>`,
  );
  el.querySelector('span').textContent = message;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity .25s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 260);
  }, duration);
}

let busyCount = 0;

let busyEl = null;

export async function withBusy(fn, delay = 250) {
  busyCount++;
  const timer = setTimeout(() => {
    if (!busyEl) {
      busyEl = htmlToElement('<div id="busy"><div class="spin"></div></div>');
      document.body.appendChild(busyEl);
    }
  }, delay);
  try {
    return await fn();
  } finally {
    clearTimeout(timer);
    if (--busyCount === 0 && busyEl) {
      busyEl.remove();
      busyEl = null;
    }
  }
}

export function pickFiles(accept, multiple = false) {
  return new Promise((t) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.addEventListener('change', () => t(multiple ? [...input.files] : input.files[0] || null));
    input.addEventListener('cancel', () => t(multiple ? [] : null));
    input.click();
  });
}

export function downloadBytes(bytes, filename, mime = 'application/pdf') {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

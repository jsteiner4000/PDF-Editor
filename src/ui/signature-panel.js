/**
 * Werkzeug „Unterschrift“.
 *
 * - Schaltflächen in der Werkzeugleiste (#ctx), der Seitenleiste des Bearbeiten-Modus, in „Alle
 *   Werkzeuge“ und auf der Startseite öffnen ein Popover mit den gespeicherten Unterschriften und
 *   den Wegen, eine neue anzulegen. Die Wege stehen sofort bereit – unabhängig davon, ob die
 *   Datenbank (noch) erreichbar ist.
 * - Erfassen: aus dem geöffneten Dokument (Rahmen aufziehen → 600 dpi rendern → freistellen),
 *   aus einer Bilddatei (gleiche Pipeline) oder gezeichnet. Das Vorschau-Sheet zeigt das Ergebnis
 *   (auf reduzierter Auflösung, damit die Regler flüssig bleiben) mit Zuschnittrahmen,
 *   Empfindlichkeit, Farbe, Linienentfernung, Art und Name; „Sichern“ rechnet in voller Auflösung.
 * - Einsetzen: Unterschrift wählen (oder Taste U für die Standard-Unterschrift), die Vorschau folgt
 *   dem Zeiger, ein Klick setzt sie als normales Bild (PNG mit Alpha → Image-XObject mit SMask)
 *   über `PdfSession.insertImage` ein – aufrecht auch auf gedrehten Seiten, rückgängig machbar,
 *   danach wie jedes Bild verschieb- und skalierbar. Dieselbe Unterschrift wird pro Dokument nur
 *   einmal eingebettet.
 *
 * Eingriffe in EditMode beschränken sich auf `mountToolbar()`, `mountPanel()` und `cancel()`.
 * Zeigerereignisse beim Erfassen/Platzieren werden in der Capture-Phase am Fenster abgefangen, so
 * dass EditMode davon nichts sieht.
 */
import SIGNATURE_CSS from '../signature/signature.css';
import { icon } from './icons.js';
import { escapeHtml, htmlToElement } from './dom.js';
import { pickFiles, showDialog, toast, withBusy } from './dialogs.js';
import { mmToPt } from './geometry.js';
import { IDB_BLOCKED_MESSAGE, onIdbBlocked } from '../storage/idb.js';
import { cropToAlpha, cutImage, extractSignature } from '../signature/signature-extract.js';
import {
  decodeImageFile,
  downscaleImage,
  encodePng,
  imageToCanvas,
  pickPageRegion,
  renderPdfRegion,
} from '../signature/signature-capture.js';
import { SignaturePad } from '../signature/signature-draw.js';
import {
  addSignature,
  deleteSignature,
  getDefaultSignature,
  listSignatures,
  onSignaturesChanged,
  renameSignature,
  setDefaultSignature,
} from '../signature/signature-store.js';

/** Standardbreite und größte Höhe beim Einsetzen (mm); das Seitenverhältnis bleibt fest. */
const PLACE_SIZE_MM = {
  signature: { width: 50, maxHeight: 25 },
  initials: { width: 20, maxHeight: 15 },
};

/**
 * Auflösung des gespeicherten PNG: höchstens 300 dpi bezogen auf das 1,6-Fache der Einsetzbreite
 * (Spielraum zum Vergrößern) – und nie mehr als die Quelle hergibt.
 */
const STORE_DPI = 300;
const STORE_WIDTH_FACTOR = 1.6;

/** Pixelzahl der Vorschau im Sheet (reduziert, damit Regler ohne Verzögerung reagieren). */
const PREVIEW_PX = 1.2e6;

const KIND_LABEL = { signature: 'Unterschrift', initials: 'Initialen' };

let stylesInjected = false;

function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.id = 'signature-styles';
  style.textContent = SIGNATURE_CSS;
  document.head.appendChild(style);
}

// Blockiert ein anderes Fenster (ältere Version) die Umstellung der Datenbank, einmal deutlich melden.
onIdbBlocked((isBlocked) => {
  if (isBlocked) toast(IDB_BLOCKED_MESSAGE, 'warn', 9000);
});

const pngUrl = (record) => URL.createObjectURL(new Blob([record.png], { type: 'image/png' }));

const formatMm = (mm) => String(Math.round(mm));

const maxStoreWidth = (kind) =>
  Math.round(
    (STORE_DPI / 25.4) * (PLACE_SIZE_MM[kind] || PLACE_SIZE_MM.signature).width * STORE_WIDTH_FACTOR,
  );

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Sheet im Stil der vorhandenen Dialoge, aber mit eigener Kontrolle über das Schließen
 * (z. B. bleibt es offen, wenn noch keine Tinte erkannt wurde).
 * - `buttons`: [{ label, primary, run(close) }] – `run` entscheidet selbst, ob `close()` aufgerufen wird.
 * - `confirmDismiss`: optionale Rückfrage (Promise<boolean>) vor dem Schließen per Esc/Klick daneben.
 * - Fokus: beim Öffnen ins Sheet (`initialFocus` oder erstes Bedienelement), Tab bleibt im Sheet,
 *   beim Schließen zurück zum vorher fokussierten Element.
 */
function openSheet({ title, iconName, body, buttons, onClose, confirmDismiss, initialFocus }) {
  const previousFocus = document.activeElement;
  const backdrop = htmlToElement('<div class="backdrop"></div>');
  const titleId = 'sigSheetTitle' + Math.floor(Math.random() * 1e9);
  const dialog = htmlToElement(
    `<div class="dlg sig-sheet" role="dialog" aria-modal="true" aria-labelledby="${titleId}"><div class="dh">${iconName ? icon(iconName) : ''}<span id="${titleId}">${escapeHtml(title)}</span></div><div class="db"></div><div class="df"></div></div>`,
  );
  dialog.querySelector('.db').appendChild(body);
  const footer = dialog.querySelector('.df');
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    document.removeEventListener('keydown', onKey, true);
    backdrop.remove();
    if (onClose) onClose();
    if (previousFocus && previousFocus.isConnected && previousFocus.focus) previousFocus.focus();
  };
  let asking = false;
  const dismiss = async () => {
    if (asking) return;
    if (confirmDismiss) {
      asking = true;
      const ok = await confirmDismiss();
      asking = false;
      if (!ok) return;
    }
    close();
  };
  const buttonEls = buttons.map((b) => {
    const el = htmlToElement(
      `<button class="btn ${b.primary ? 'primary' : 'outline'}">${escapeHtml(b.label)}</button>`,
    );
    el.addEventListener('click', () => b.run(close));
    footer.appendChild(el);
    return el;
  });
  const isTop = () => {
    const all = document.querySelectorAll('.backdrop');
    return all[all.length - 1] === backdrop;
  };
  const onKey = (ev) => {
    if (!isTop()) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      dismiss();
    } else if (ev.key === 'Tab') {
      // Fokus im Sheet halten
      const items = [...dialog.querySelectorAll(FOCUSABLE)].filter((el) => el.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const inside = dialog.contains(document.activeElement);
      if (ev.shiftKey && (document.activeElement === first || !inside)) {
        ev.preventDefault();
        last.focus();
      } else if (!ev.shiftKey && (document.activeElement === last || !inside)) {
        ev.preventDefault();
        first.focus();
      }
    } else if (
      ev.key === 'Enter' &&
      !(ev.target instanceof HTMLButtonElement) &&
      !(ev.target instanceof HTMLTextAreaElement) &&
      !(ev.target instanceof Element && ev.target.closest('[data-local-enter]'))
    ) {
      const index = buttons.findIndex((b) => b.primary);
      if (index >= 0 && !buttonEls[index].disabled) {
        ev.preventDefault();
        ev.stopPropagation();
        buttons[index].run(close);
      }
    }
    // Übrige Tastenkürzel der App sind gesperrt, solange ein .backdrop offen ist (App.onKey).
  };
  document.addEventListener('keydown', onKey, true);
  backdrop.addEventListener('pointerdown', (ev) => {
    if (ev.target === backdrop) dismiss();
  });
  backdrop.appendChild(dialog);
  document.body.appendChild(backdrop);
  const target = initialFocus || dialog.querySelector(FOCUSABLE);
  if (target) target.focus();
  return { dialog, close, buttons: buttonEls };
}

/** Segmentierte Auswahl (wie die Ausrichtung im Format-Bereich). */
function segmented(options, value, onChange) {
  const seg = htmlToElement('<div class="seg" role="radiogroup"></div>');
  for (const [key, label] of options) {
    const btn = htmlToElement(
      `<button type="button" role="radio" data-v="${key}">${escapeHtml(label)}</button>`,
    );
    btn.addEventListener('click', () => {
      for (const b of seg.children) {
        b.classList.toggle('on', b === btn);
        b.setAttribute('aria-checked', String(b === btn));
      }
      onChange(key);
    });
    btn.classList.toggle('on', key === value);
    btn.setAttribute('aria-checked', String(key === value));
    seg.appendChild(btn);
  }
  return seg;
}

/**
 * Zuschnittrahmen über der Vorschau: acht Griffe und Verschieben im Inneren. Der Rahmen arbeitet
 * in normierten Koordinaten [x0, y0, x1, y1] ∈ [0, 1] der Vorschau. `onChange(frame)` meldet jede
 * Änderung durch den Nutzer.
 */
function cropFrame(stage, onChange) {
  const el = htmlToElement(
    `<div class="sig-crop" aria-label="Zuschnitt">${['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].map((h) => `<i data-h="${h}"></i>`).join('')}</div>`,
  );
  stage.appendChild(el);
  let frame = [0, 0, 1, 1];
  const draw = () => {
    Object.assign(el.style, {
      left: frame[0] * 100 + '%',
      top: frame[1] * 100 + '%',
      width: (frame[2] - frame[0]) * 100 + '%',
      height: (frame[3] - frame[1]) * 100 + '%',
    });
  };
  el.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const handle = ev.target.dataset.h || 'move';
    const rect = stage.getBoundingClientRect();
    const start = frame.slice();
    const sx = ev.clientX;
    const sy = ev.clientY;
    el.setPointerCapture(ev.pointerId);
    const min = 0.04;
    const onMove = (e) => {
      const dx = (e.clientX - sx) / rect.width;
      const dy = (e.clientY - sy) / rect.height;
      let [x0, y0, x1, y1] = start;
      if (handle === 'move') {
        const w = x1 - x0;
        const h = y1 - y0;
        x0 = Math.max(0, Math.min(1 - w, x0 + dx));
        y0 = Math.max(0, Math.min(1 - h, y0 + dy));
        x1 = x0 + w;
        y1 = y0 + h;
      } else {
        if (handle.includes('w')) x0 = Math.max(0, Math.min(x1 - min, x0 + dx));
        if (handle.includes('e')) x1 = Math.min(1, Math.max(x0 + min, x1 + dx));
        if (handle.includes('n')) y0 = Math.max(0, Math.min(y1 - min, y0 + dy));
        if (handle.includes('s')) y1 = Math.min(1, Math.max(y0 + min, y1 + dy));
      }
      frame = [x0, y0, x1, y1];
      draw();
      onChange(frame);
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  });
  return {
    set(next) {
      frame = next.slice();
      draw();
    },
    get: () => frame.slice(),
  };
}

export class SignatureTool {
  /** Das Werkzeug zum Bearbeiten-Modus (wird beim ersten Gebrauch angelegt). */
  static of(edit) {
    return (edit.signature ||= new SignatureTool(edit));
  }
  constructor(edit) {
    this.edit = edit;
    this.app = edit.app;
    this.pop = null;
    this.placing = null;
    this.capture = null;
    this.hintEl = null;
    ensureStyles();
    window.addEventListener('keydown', (ev) => this.onKey(ev), true);
    window.addEventListener('pointerdown', (ev) => this.onOutside(ev), true);
    onSignaturesChanged(() => {
      if (this.pop) this.renderList();
    });
  }

  /* ---------- Einbindung in den Bearbeiten-Modus ---------- */

  /** Schaltfläche „Unterschrift“ in der Werkzeugleiste, direkt nach `after`. */
  mountToolbar(after) {
    if (!after) return;
    const btn = htmlToElement(
      `<button class="btn" id="cAddSig" title="Unterschrift einsetzen (U)">${icon('signature', 's')}Unterschrift</button>`,
    );
    btn.addEventListener('click', () => this.toggle(btn));
    after.after(btn);
    this.syncButtons();
  }
  /** Schaltfläche „Unterschrift“ im Bereich „Hinzufügen“ der Seitenleiste. */
  mountPanel(section) {
    const btn = htmlToElement(
      `<button class="btn big" data-sig-btn title="Unterschrift einsetzen (U)">${icon('signature')}Unterschrift</button>`,
    );
    btn.addEventListener('click', () => this.toggle(btn));
    section.appendChild(btn);
    this.syncButtons();
  }
  syncButtons() {
    const on = !!(this.pop || this.placing || this.capture);
    for (const btn of document.querySelectorAll('#cAddSig,[data-sig-btn]')) btn.classList.toggle('on', on);
  }
  /** Bricht alles ab (Popover, Platzieren, Erfassen) – z. B. beim Verlassen des Modus. */
  cancel() {
    this.closePop();
    this.cancelPlacing();
    if (this.capture) this.capture.cancel();
  }

  /* ---------- Tastatur und Klicks außerhalb ---------- */

  onKey(ev) {
    if (ev.key === 'Escape' && (this.placing || this.pop)) {
      ev.preventDefault();
      ev.stopPropagation();
      if (this.placing) this.cancelPlacing();
      else this.closePop(true);
      return;
    }
    const target = ev.target;
    const inField = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    if (
      (ev.key === 'u' || ev.key === 'U') &&
      !ev.ctrlKey &&
      !ev.metaKey &&
      !ev.altKey &&
      !inField &&
      this.app.tool === 'edit' &&
      this.app.session &&
      !this.edit.editor &&
      !this.capture &&
      !document.querySelector('.backdrop')
    ) {
      ev.preventDefault();
      ev.stopPropagation();
      this.placeDefault();
    }
  }
  onOutside(ev) {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.closest('#cAddSig,[data-sig-btn],.sig-hint')) return;
    if (this.pop && !this.pop.contains(target) && !(this.popAnchor && this.popAnchor.contains(target)))
      this.closePop();
    if (this.placing && !target.closest('#pages .page')) this.cancelPlacing();
  }

  /* ---------- Popover ---------- */

  toggle(anchor) {
    if (this.capture) {
      this.capture.cancel(); // Klick auf „Unterschrift“ beendet das Erfassen
      return;
    }
    if (this.pop || this.placing) {
      this.closePop();
      this.cancelPlacing();
      return;
    }
    this.openPop(anchor);
  }
  /**
   * Öffnet das Popover an `anchor`. Die Erfassen-Knöpfe stehen sofort bereit; die Liste der
   * gespeicherten Unterschriften wird nachgeladen (mit Ladezustand bzw. Fehlermeldung).
   */
  openPop(anchor) {
    this.cancelPlacing();
    this.closePop();
    const pop = htmlToElement(
      `<div class="sig-pop" role="dialog" aria-label="Unterschriften">
        <div class="sig-pop-head"><h5>Unterschriften</h5><span class="k" title="Taste U setzt die Standard-Unterschrift">U = Standard einsetzen</span></div>
        <div class="sig-pop-list"><div class="sig-empty">Gespeicherte Unterschriften werden geladen …</div></div>
        <hr>
      </div>`,
    );
    this.pop = pop;
    this.popAnchor = anchor;
    this.popReturnFocus = document.activeElement;
    const add = (iconName, label, run, attrs = '') => {
      const btn = htmlToElement(
        `<button class="mi" ${attrs}>${icon(iconName, 's')}<span>${escapeHtml(label)}</span></button>`,
      );
      btn.addEventListener('click', () => {
        this.closePop();
        run();
      });
      pop.appendChild(btn);
      return btn;
    };
    add('sigcapture', 'Aus Dokument übernehmen', () => this.captureFromDocument());
    add('image', 'Aus Bilddatei …', () => this.fromImageFile());
    add('pen', 'Zeichnen …', () => this.drawNew());
    pop.appendChild(htmlToElement('<hr data-manage hidden>'));
    add('list', 'Unterschriften verwalten …', () => this.manage(), 'data-manage hidden');
    document.body.appendChild(pop);
    this.syncButtons();
    this.position();
    pop.querySelector('.mi').focus();
    this.renderList();
  }
  position() {
    const pop = this.pop;
    const anchor =
      this.popAnchor && this.popAnchor.isConnected ? this.popAnchor : document.getElementById('cAddSig');
    if (!pop || !anchor) return;
    const rect = anchor.getBoundingClientRect();
    const inSidebar = !!anchor.closest('#left');
    let x = inSidebar ? rect.right + 8 : rect.left;
    let y = inSidebar ? rect.top : rect.bottom + 6;
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
    y = Math.max(8, Math.min(window.innerHeight - h - 8, y));
    pop.style.left = x + 'px';
    pop.style.top = y + 'px';
  }
  async renderList() {
    const pop = this.pop;
    if (!pop) return;
    const box = pop.querySelector('.sig-pop-list');
    let items;
    try {
      items = await listSignatures();
    } catch (err) {
      if (pop !== this.pop) return;
      const msg = htmlToElement(
        `<div class="sig-empty err">${icon('warn', 's')}<span></span><button class="btn outline">Erneut versuchen</button></div>`,
      );
      msg.querySelector('span').textContent =
        err && err.name === 'IdbBlockedError'
          ? IDB_BLOCKED_MESSAGE
          : 'Gespeicherte Unterschriften können gerade nicht geladen werden.';
      msg.querySelector('button').addEventListener('click', () => this.renderList());
      box.replaceChildren(msg);
      this.position();
      return;
    }
    if (pop !== this.pop) return;
    for (const url of this.popUrls || []) URL.revokeObjectURL(url);
    this.popUrls = [];
    if (items.length) {
      const grid = htmlToElement('<div class="sig-grid"></div>');
      for (const record of items) {
        const url = pngUrl(record);
        this.popUrls.push(url);
        const card = htmlToElement(
          `<button class="sig-card" title="Einsetzen: danach auf die gewünschte Stelle klicken"><img alt=""><span class="row"><span class="nm"></span>${record.isDefault ? '<span class="def">Standard</span>' : ''}</span></button>`,
        );
        card.querySelector('img').src = url;
        card.querySelector('.nm').textContent = record.name;
        card.dataset.id = record.id;
        card.addEventListener('click', () => this.startPlacing(record));
        grid.appendChild(card);
      }
      box.replaceChildren(grid);
    } else
      box.replaceChildren(
        htmlToElement(
          '<div class="sig-empty">Noch keine Unterschrift gespeichert. Übernehmen Sie Ihre Unterschrift aus einem unterschriebenen Dokument, aus einem Foto oder zeichnen Sie sie.</div>',
        ),
      );
    for (const el of pop.querySelectorAll('[data-manage]')) el.hidden = !items.length;
    this.position();
  }
  closePop(restoreFocus = false) {
    if (!this.pop) return;
    this.pop.remove();
    this.pop = null;
    for (const url of this.popUrls || []) URL.revokeObjectURL(url);
    this.popUrls = [];
    if (restoreFocus && this.popReturnFocus && this.popReturnFocus.isConnected) this.popReturnFocus.focus();
    this.syncButtons();
  }

  /* ---------- Hinweisleiste ---------- */

  showHint(text, onCancel) {
    this.hideHint();
    const el = htmlToElement(
      `<div class="sig-hint" role="status"><span></span><button class="btn outline">Abbrechen</button></div>`,
    );
    el.querySelector('span').textContent = text;
    el.querySelector('button').addEventListener('click', onCancel);
    (document.getElementById('center') || document.body).appendChild(el);
    this.hintEl = el;
  }
  hideHint() {
    if (this.hintEl) this.hintEl.remove();
    this.hintEl = null;
  }

  /* ---------- Einsetzen ---------- */

  async placeDefault() {
    const record = await getDefaultSignature();
    if (record) this.startPlacing(record);
    else this.openPop(document.getElementById('cAddSig'));
  }
  /** Größe in pt beim Einsetzen (aufrecht, wie angezeigt): Standardbreite, Höhe begrenzt. */
  sizeFor(record) {
    const spec = PLACE_SIZE_MM[record.kind] || PLACE_SIZE_MM.signature;
    let width = mmToPt(spec.width);
    let height = width / record.aspect;
    const maxHeight = mmToPt(spec.maxHeight);
    if (height > maxHeight) {
      height = maxHeight;
      width = height * record.aspect;
    }
    return { width, height };
  }
  /**
   * PDF-Rechteck [x, y, b, h] für den Mittelpunkt `point`, innerhalb der Seite gehalten. Auf um
   * 90°/270° gedrehten Seiten sind Breite und Höhe im PDF vertauscht (das Bild wird von
   * `PdfSession.insertImage` zurückgedreht und steht in der Anzeige aufrecht).
   */
  rectAt(pv, point, size) {
    const info = pv.infoRaw;
    const swap = info.rotate % 180 !== 0;
    const fullW = swap ? size.height : size.width;
    const fullH = swap ? size.width : size.height;
    const fit = Math.min(1, (info.w * 0.9) / fullW, (info.h * 0.9) / fullH);
    const width = fullW * fit;
    const height = fullH * fit;
    const x = Math.max(info.x, Math.min(info.x + info.w - width, point[0] - width / 2));
    const y = Math.max(info.y, Math.min(info.y + info.h - height, point[1] - height / 2));
    return [x, y, width, height];
  }
  async startPlacing(record) {
    this.closePop();
    this.cancelPlacing();
    if (!this.app.session) {
      toast(
        'Öffnen Sie zuerst ein PDF – dann die Unterschrift wählen und auf die Seite klicken.',
        'warn',
        4200,
      );
      return;
    }
    if (this.app.tool !== 'edit') await this.app.setTool('edit');
    if (this.edit.editor) await this.edit.finishEdit();
    this.edit.arm(null);
    const url = pngUrl(record);
    // Vorschau: Rahmen in Seitenkoordinaten, darin das Bild gegen die Seitendrehung gedreht
    const ghost = htmlToElement('<div class="sig-ghost"><img alt=""></div>');
    const ghostImg = ghost.firstChild;
    ghostImg.src = url;
    const size = this.sizeFor(record);
    const pages = document.getElementById('pages');
    pages.classList.add('sig-placing');
    const pvOf = (target) => {
      const pageEl = target instanceof Element && target.closest('#pages .page');
      return pageEl ? this.app.pvByKey.get(pageEl.dataset.key) : null;
    };
    const onMove = (ev) => {
      const pv = pvOf(ev.target);
      if (!pv || !pv.infoRaw) {
        ghost.remove();
        return;
      }
      ev.stopPropagation(); // keine Hover-Rahmen des Bearbeiten-Modus
      if (ghost.parentNode !== pv.layer) pv.layer.appendChild(ghost);
      const [x, y, w, h] = this.rectAt(pv, pv.clientToPdf(ev.clientX, ev.clientY), size);
      const box = pv.boxOf([x, y, x + w, y + h]);
      const rotate = ((pv.infoRaw.rotate % 360) + 360) % 360;
      const swap = rotate % 180 !== 0;
      const imgW = swap ? box.height : box.width;
      const imgH = swap ? box.width : box.height;
      Object.assign(ghost.style, {
        left: box.left + 'px',
        top: box.top + 'px',
        width: box.width + 'px',
        height: box.height + 'px',
      });
      Object.assign(ghostImg.style, {
        width: imgW + 'px',
        height: imgH + 'px',
        left: (box.width - imgW) / 2 + 'px',
        top: (box.height - imgH) / 2 + 'px',
        transform: rotate ? `rotate(${-rotate}deg)` : '',
      });
    };
    const onDown = (ev) => {
      const pv = pvOf(ev.target);
      if (!pv || ev.button !== 0) return;
      ev.preventDefault();
      ev.stopPropagation();
      const point = pv.clientToPdf(ev.clientX, ev.clientY);
      this.cancelPlacing();
      this.place(pv, point, record);
    };
    const swallow = (ev) => {
      if (pvOf(ev.target)) {
        ev.preventDefault();
        ev.stopPropagation();
        if (ev.type === 'contextmenu') this.cancelPlacing();
      }
    };
    window.addEventListener('pointermove', onMove, true);
    window.addEventListener('pointerdown', onDown, true);
    window.addEventListener('contextmenu', swallow, true);
    window.addEventListener('dblclick', swallow, true);
    this.placing = {
      record,
      stop: () => {
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerdown', onDown, true);
        window.removeEventListener('contextmenu', swallow, true);
        window.removeEventListener('dblclick', swallow, true);
        pages.classList.remove('sig-placing');
        ghost.remove();
        URL.revokeObjectURL(url);
      },
    };
    this.showHint(`„${record.name}“: Klicken Sie auf die Stelle, an der sie stehen soll.`, () =>
      this.cancelPlacing(),
    );
    this.syncButtons();
  }
  cancelPlacing() {
    if (!this.placing) return;
    this.placing.stop();
    this.placing = null;
    this.hideHint();
    this.syncButtons();
  }
  /** Setzt die Unterschrift als Bild ein (Mittelpunkt bei `point`, PDF-Koordinaten). */
  async place(pv, point, record) {
    const [x, y, width, height] = this.rectAt(pv, point, this.sizeFor(record));
    await withBusy(async () => {
      await this.app.session.insertImage(
        pv.index,
        new Uint8Array(record.png),
        'image/png',
        [x, y, width, height],
        'Unterschrift eingefügt',
      );
      this.edit.pendingReselect = {
        key: pv.key,
        objs: [{ type: 'image', vis: [x, y, x + width, y + height] }],
        blocks: [],
      };
      await this.app.sync();
    });
  }

  /* ---------- Erfassen ---------- */

  async captureFromDocument() {
    this.cancel();
    if (!this.app.session) {
      toast(
        'Öffnen Sie zuerst das unterschriebene PDF, dann „Unterschrift“ > „Aus Dokument übernehmen“.',
        'warn',
        5000,
      );
      this.app.openDialog();
      return;
    }
    if (this.app.tool !== 'edit') await this.app.setTool('edit');
    if (this.edit.editor) await this.edit.finishEdit();
    this.edit.clearSelection();
    this.edit.arm(null);
    this.capture = pickPageRegion(this.app);
    this.showHint(
      'Ziehen Sie einen Rahmen um die Unterschrift.',
      () => this.capture && this.capture.cancel(),
    );
    this.syncButtons();
    const picked = await this.capture.promise;
    this.capture = null;
    this.hideHint();
    this.syncButtons();
    if (!picked) return;
    let rendered = null;
    try {
      rendered = await withBusy(() =>
        renderPdfRegion(this.app.renderer, picked.pv.index, picked.rect, undefined, picked.pv.infoRaw.rotate),
      );
    } catch (err) {
      console.warn('Bereich rendern', err);
      toast('Der Bereich konnte nicht gelesen werden.', 'err');
      return;
    }
    return this.review({ source: 'document', image: rendered.image, dpi: rendered.dpi });
  }
  async fromImageFile() {
    this.cancel();
    const file = await pickFiles('image/png,image/jpeg,image/webp,image/gif,image/bmp');
    if (!file) return;
    let decoded;
    try {
      decoded = await withBusy(() => decodeImageFile(file));
    } catch {
      toast('Dieses Bildformat wird nicht unterstützt (bitte PNG oder JPG).', 'err');
      return;
    }
    // Auflösung unbekannt: Annahme, das Bild zeigt etwa 10 cm Breite (für Fleck-/Liniengrößen).
    const image = decoded.image;
    const dpi = Math.max(150, Math.min(1200, image.width / (100 / 25.4)));
    const name = file.name.replace(/\.[^.]+$/, '');
    return this.review({ source: 'image', image, dpi, name });
  }

  /**
   * Vorschau-Sheet nach dem Erfassen: freigestelltes Ergebnis (reduzierte Auflösung) mit
   * Zuschnittrahmen, Empfindlichkeit, Farbe, Linienentfernung, Art und Name. „Sichern“ stellt in
   * voller Auflösung frei (innerhalb des Rahmens) und speichert.
   */
  review({ source, image, dpi, name = '' }) {
    const state = { sensitivity: 50, color: 'original', removeLines: true, kind: 'signature' };
    const preview = downscaleImage(image, { maxPx: PREVIEW_PX });
    const pImage = preview.image;
    const pDpi = dpi * preview.factor;
    const body = htmlToElement(`<div>
      <div class="sig-preview"><div class="sig-stage"><canvas></canvas></div><div class="msg hidden"></div></div>
      <div class="sig-prevbar">
        <span class="hint">Rahmen anpassen, um Text oder Stempel neben der Unterschrift auszuschließen.</span>
        <button class="btn outline" data-a="reset" hidden>Rahmen zurücksetzen</button>
        ${source === 'document' ? '<button class="btn outline" data-a="again">Bereich neu wählen</button>' : ''}
      </div>
      <div class="sig-form">
        <label for="sigSens">Empfindlichkeit</label>
        <div class="sig-range"><span>weniger</span><input id="sigSens" type="range" min="0" max="100" step="1" value="50"><span>mehr</span></div>
        <label>Farbe</label><div data-slot="color"></div>
        <label>Linien</label><label class="sig-check"><input type="checkbox" id="sigLines" checked>Formularlinien entfernen</label>
        <label>Art</label><div data-slot="kind"></div>
        <label for="sigName">Name</label><input class="fld" id="sigName" maxlength="60" placeholder="z. B. Unterschrift Max Mustermann">
      </div>
      <p class="hint" data-slot="info" style="margin:6px 0 0"></p>
    </div>`);
    const previewBox = body.querySelector('.sig-preview');
    const stage = body.querySelector('.sig-stage');
    const canvas = body.querySelector('canvas');
    const msg = body.querySelector('.msg');
    const info = body.querySelector('[data-slot=info]');
    const nameInput = body.querySelector('#sigName');
    const resetBtn = body.querySelector('[data-a=reset]');
    nameInput.value = name;
    let result = null; // Vorschau-Ergebnis (ganzer Bereich, nicht zugeschnitten)
    let autoFrame = [0, 0, 1, 1];
    let userFrame = null;
    let sheet = null;
    const frame = cropFrame(stage, (f) => {
      userFrame = f;
      resetBtn.hidden = false;
      updateInfo();
    });
    const currentFrame = () => userFrame || autoFrame;
    /** Tinte innerhalb des Rahmens (Vorschau), zugeschnitten – für Größenangabe und „leer?“. */
    const inkInFrame = () => {
      if (!result) return null;
      const [fx0, fy0, fx1, fy1] = currentFrame();
      const w = result.image.width;
      const h = result.image.height;
      return cropToAlpha(cutImage(result.image, [fx0 * w, fy0 * h, fx1 * w, fy1 * h]));
    };
    const fitStage = () => {
      if (!result) return;
      const availW = previewBox.clientWidth - 32;
      const availH = previewBox.clientHeight - 32;
      const s = Math.min(availW / result.image.width, availH / result.image.height, 2);
      stage.style.width = Math.max(1, Math.round(result.image.width * s)) + 'px';
      stage.style.height = Math.max(1, Math.round(result.image.height * s)) + 'px';
    };
    const updateInfo = () => {
      const ink = inkInFrame();
      const ok = !!(ink && ink.image.width > 2);
      if (sheet) sheet.buttons[1].disabled = !ok;
      if (!ok) {
        info.textContent = 'Im Rahmen ist keine Unterschrift erkennbar.';
        return;
      }
      const w = (ink.image.width / pDpi) * 25.4;
      const h = (ink.image.height / pDpi) * 25.4;
      const place = PLACE_SIZE_MM[state.kind].width;
      info.textContent =
        source === 'document'
          ? `Größe im Dokument: ${formatMm(w)} × ${formatMm(h)} mm. Eingesetzt wird sie standardmäßig ${place} mm breit; danach frei skalierbar.`
          : `Der Hintergrund wird transparent. Eingesetzt wird sie standardmäßig ${place} mm breit; danach frei skalierbar.`;
    };
    const run = () => {
      result = extractSignature(pImage, { ...state, dpi: pDpi, crop: false });
      stage.classList.toggle('hidden', !result);
      msg.classList.toggle('hidden', !!result);
      if (result) {
        imageToCanvas(result.image, canvas);
        const trimmed = cropToAlpha(result.image, Math.round((pDpi / 25.4) * 0.8));
        const w = result.image.width;
        const h = result.image.height;
        autoFrame = trimmed
          ? [trimmed.bbox[0] / w, trimmed.bbox[1] / h, trimmed.bbox[2] / w, trimmed.bbox[3] / h]
          : [0, 0, 1, 1];
        frame.set(currentFrame());
        fitStage();
        updateInfo();
      } else {
        msg.textContent =
          'Keine Unterschrift erkannt. Empfindlichkeit erhöhen oder einen anderen Bereich wählen.';
        info.textContent = '';
        if (sheet) sheet.buttons[1].disabled = true;
      }
    };
    let timer = 0;
    const rerun = (delay = 30) => {
      clearTimeout(timer);
      timer = setTimeout(run, delay);
    };
    resetBtn.addEventListener('click', () => {
      userFrame = null;
      resetBtn.hidden = true;
      frame.set(autoFrame);
      updateInfo();
    });
    const againBtn = body.querySelector('[data-a=again]');
    if (againBtn)
      againBtn.addEventListener('click', () => {
        sheet.close();
        this.captureFromDocument();
      });
    body.querySelector('#sigSens').addEventListener('input', (ev) => {
      state.sensitivity = Number(ev.target.value);
      rerun();
    });
    body.querySelector('#sigLines').addEventListener('change', (ev) => {
      state.removeLines = ev.target.checked;
      rerun(0);
    });
    body.querySelector('[data-slot=color]').appendChild(
      segmented(
        [
          ['original', 'Original'],
          ['black', 'Schwarz'],
          ['blue', 'Dunkelblau'],
        ],
        state.color,
        (v) => {
          state.color = v;
          rerun(0);
        },
      ),
    );
    body.querySelector('[data-slot=kind]').appendChild(
      segmented(
        [
          ['signature', 'Unterschrift'],
          ['initials', 'Initialen'],
        ],
        state.kind,
        (v) => {
          state.kind = v;
          updateInfo();
        },
      ),
    );
    let saving = false;
    sheet = openSheet({
      title:
        source === 'document' ? 'Unterschrift aus Dokument übernehmen' : 'Unterschrift aus Bild übernehmen',
      iconName: 'signature',
      body,
      initialFocus: nameInput,
      buttons: [
        { label: 'Abbrechen', run: (close) => close() },
        {
          label: 'Sichern',
          primary: true,
          run: async (close) => {
            if (saving) return;
            clearTimeout(timer);
            saving = true;
            try {
              // volle Auflösung, nur innerhalb des Rahmens
              const final = await withBusy(async () => {
                const [fx0, fy0, fx1, fy1] = currentFrame();
                const cut = cutImage(image, [
                  fx0 * image.width,
                  fy0 * image.height,
                  fx1 * image.width,
                  fy1 * image.height,
                ]);
                return extractSignature(cut, { ...state, dpi });
              });
              if (!final) {
                toast('Im Rahmen ist keine Unterschrift erkennbar.', 'warn');
                return;
              }
              const saved = await this.save({
                image: final.image,
                name: nameInput.value,
                kind: state.kind,
                source,
                widthMm: (final.image.width / dpi) * 25.4,
                heightMm: (final.image.height / dpi) * 25.4,
              });
              if (saved) close();
            } finally {
              saving = false;
            }
          },
        },
      ],
    });
    run();
    return sheet;
  }

  /** Zeichen-Sheet: Maus, Stift oder Touch; Rückgängig und Löschen. */
  drawNew() {
    this.cancel();
    const state = { color: 'black', kind: 'signature' };
    let saving = false;
    const body = htmlToElement(`<div>
      <div class="sig-pad"><canvas aria-label="Zeichenfläche"></canvas><div class="base"></div><div class="ph">Hier unterschreiben</div></div>
      <div class="sig-padbar">
        <button class="btn outline" data-a="undo" disabled>${icon('undo', 's')}Rückgängig</button>
        <button class="btn outline" data-a="clear" disabled>${icon('trash', 's')}Löschen</button>
      </div>
      <div class="sig-form">
        <label>Farbe</label><div data-slot="color"></div>
        <label>Art</label><div data-slot="kind"></div>
        <label for="sigName">Name</label><input class="fld" id="sigName" maxlength="60" placeholder="z. B. Unterschrift Max Mustermann">
      </div>
    </div>`);
    const placeholder = body.querySelector('.ph');
    const undoBtn = body.querySelector('[data-a=undo]');
    const clearBtn = body.querySelector('[data-a=clear]');
    const nameInput = body.querySelector('#sigName');
    let sheet = null;
    const pad = new SignaturePad(body.querySelector('canvas'), {
      onChange: () => {
        const empty = pad.isEmpty();
        undoBtn.disabled = clearBtn.disabled = empty;
        placeholder.classList.toggle('hidden', !empty);
        if (sheet) sheet.buttons[1].disabled = empty;
      },
    });
    body.querySelector('canvas').addEventListener('pointerdown', () => placeholder.classList.add('hidden'));
    undoBtn.addEventListener('click', () => pad.undo());
    clearBtn.addEventListener('click', () => pad.clear());
    body.querySelector('[data-slot=color]').appendChild(
      segmented(
        [
          ['black', 'Schwarz'],
          ['blue', 'Dunkelblau'],
        ],
        state.color,
        (v) => pad.setColor(v),
      ),
    );
    body.querySelector('[data-slot=kind]').appendChild(
      segmented(
        [
          ['signature', 'Unterschrift'],
          ['initials', 'Initialen'],
        ],
        state.kind,
        (v) => (state.kind = v),
      ),
    );
    sheet = openSheet({
      title: 'Unterschrift zeichnen',
      iconName: 'pen',
      body,
      initialFocus: nameInput,
      // Esc oder Klick daneben: eine begonnene Zeichnung nicht stillschweigend verwerfen
      confirmDismiss: () =>
        pad.isEmpty()
          ? Promise.resolve(true)
          : showDialog({
              title: 'Zeichnung verwerfen?',
              icon: 'warn',
              body: 'Die Unterschrift ist noch nicht gesichert.',
              buttons: [
                { label: 'Weiter zeichnen', value: false },
                { label: 'Verwerfen', primary: true, value: true },
              ],
              cancelValue: false,
            }).then((v) => v === true),
      buttons: [
        { label: 'Abbrechen', run: (close) => close() },
        {
          label: 'Sichern',
          primary: true,
          run: async (close) => {
            const image = pad.exportImage();
            if (!image || saving) return;
            saving = true;
            // Natürliche Größe geschätzt: Zeichenfläche ≈ 120 mm breit.
            const mmPerPx = 120 / (pad.cssW * 4);
            const saved = await this.save({
              image,
              name: nameInput.value,
              kind: state.kind,
              source: 'drawn',
              widthMm: image.width * mmPerPx,
              heightMm: image.height * mmPerPx,
            });
            saving = false;
            if (saved) close();
          },
        },
      ],
    });
    sheet.buttons[1].disabled = true;
    requestAnimationFrame(() => pad.resize());
    return sheet;
  }

  /**
   * Speichert das freigestellte Bild (auf höchstens STORE_DPI bezogen auf die Einsetzgröße
   * verkleinert); danach Einsetzen (bei Bild/Zeichnung) oder Hinweis.
   */
  async save({ image, name, kind, source, widthMm, heightMm }) {
    const stored = downscaleImage(image, { maxWidth: maxStoreWidth(kind) }).image;
    const png = await encodePng(stored);
    const record = await addSignature({
      name,
      kind,
      source,
      png: png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength),
      width: stored.width,
      height: stored.height,
      widthMm,
      heightMm,
    });
    if (!record) {
      toast(
        'Die Unterschrift konnte nicht gespeichert werden. Bitte andere Fenster des PDF-Editors schließen und erneut versuchen.',
        'err',
        6000,
      );
      return null;
    }
    if (source === 'document' || !this.app.session)
      toast(`„${record.name}“ gesichert – einsetzen über „Unterschrift“ oder mit der Taste U.`, '', 4200);
    else {
      toast(`„${record.name}“ gesichert.`);
      this.startPlacing(record);
    }
    return record;
  }

  /* ---------- Verwalten ---------- */

  manage() {
    this.cancel();
    const body = htmlToElement(
      '<div><div class="sig-list" data-local-enter></div><p class="hint" style="margin:10px 0 0">Unterschriften werden nur auf diesem Rechner gespeichert (im Browser-Speicher des PDF-Editors).</p></div>',
    );
    const list = body.querySelector('.sig-list');
    let urls = [];
    const render = async () => {
      let items;
      try {
        items = await listSignatures();
      } catch (err) {
        list.replaceChildren(
          htmlToElement(
            `<p class="hint">${escapeHtml(err && err.name === 'IdbBlockedError' ? IDB_BLOCKED_MESSAGE : 'Die gespeicherten Unterschriften können gerade nicht geladen werden.')}</p>`,
          ),
        );
        return;
      }
      for (const url of urls) URL.revokeObjectURL(url);
      urls = [];
      list.replaceChildren();
      if (!items.length)
        list.appendChild(htmlToElement('<p class="hint">Keine Unterschriften gespeichert.</p>'));
      for (const record of items) {
        const url = pngUrl(record);
        urls.push(url);
        const row = htmlToElement(`<div class="sig-row">
          <div class="th"><img alt=""></div>
          <div class="meta"><input class="fld" maxlength="60" aria-label="Name"><small></small></div>
          <div class="def"></div>
          <button class="btn outline ic" data-a="del" title="Löschen" aria-label="Löschen">${icon('trash', 's')}</button>
        </div>`);
        row.querySelector('img').src = url;
        const input = row.querySelector('input');
        input.value = record.name;
        input.addEventListener('change', () => {
          if (input.value.trim()) renameSignature(record.id, input.value);
          else input.value = record.name;
        });
        input.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') {
            ev.preventDefault();
            input.blur();
          }
        });
        const created = new Date(record.created).toLocaleDateString('de-DE', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        });
        row.querySelector('small').textContent =
          `${KIND_LABEL[record.kind] || 'Unterschrift'} · ${formatMm(record.widthMm)} × ${formatMm(record.heightMm)} mm · ${created}`;
        const def = row.querySelector('.def');
        if (record.isDefault)
          def.appendChild(htmlToElement(`<span class="sig-isdef">${icon('check', 's')}Standard</span>`));
        else {
          const btn = htmlToElement('<button class="btn outline">Als Standard</button>');
          btn.addEventListener('click', () => setDefaultSignature(record.id));
          def.appendChild(btn);
        }
        row.querySelector('[data-a=del]').addEventListener('click', async () => {
          const ok = await showDialog({
            title: 'Unterschrift löschen?',
            icon: 'trash',
            body: `„${escapeHtml(record.name)}“ wird von diesem Rechner entfernt. Bereits unterschriebene Dokumente bleiben unverändert.`,
            buttons: [
              { label: 'Abbrechen', value: false },
              { label: 'Löschen', primary: true, value: true },
            ],
          });
          if (ok) await deleteSignature(record.id);
        });
        list.appendChild(row);
      }
    };
    const unsubscribe = onSignaturesChanged(render);
    render();
    return openSheet({
      title: 'Unterschriften verwalten',
      iconName: 'signature',
      body,
      buttons: [{ label: 'Fertig', primary: true, run: (close) => close() }],
      onClose: () => {
        unsubscribe();
        for (const url of urls) URL.revokeObjectURL(url);
      },
    });
  }
}

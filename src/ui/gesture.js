/**
 * Zeigergesten (Drücken – Ziehen – Loslassen) robust verfolgen.
 */

/**
 * Eine Geste ab `pointerdown`: setzt sofort (synchron) Pointer-Capture auf ein dauerhaftes
 * Element und meldet Bewegung und Ende an den Bearbeiter (`attach()`), der auch erst später
 * gesetzt werden kann – etwa wenn vorher noch eine Textbearbeitung abgeschlossen wird.
 *
 * Das Ende ist idempotent und kommt genau einmal: `pointerup` → 'up'; `pointercancel`, Verlust
 * des Captures ohne Loslassen, Fensterwechsel, eine weitere gedrückte Taste (z. B. mittlere
 * Maustaste für das Hand-Werkzeug) oder `cancel()` (Esc) → 'cancel'. Ein
 * `pointermove` ohne gedrückte Taste gilt als verpasstes Loslassen ('up') – so kann nie ein Objekt
 * „an der Maus kleben“ bleiben. Alle Listener hängen an einem AbortController.
 */
export class Gesture {
  constructor(ev, captureEl) {
    this.id = ev.pointerId;
    this.x0 = ev.clientX;
    this.y0 = ev.clientY;
    this.last = ev;
    this.ended = false;
    this.reason = null;
    this.moved = false;
    this.handler = null;
    this.el = captureEl;
    this.ac = new AbortController();
    const opts = { signal: this.ac.signal, capture: true };
    try {
      captureEl.setPointerCapture(ev.pointerId);
    } catch {}
    window.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== this.id) return;
        if ((e.buttons & 1) === 0) return this.end('up', e);
        // zusätzliche Taste (Maus meldet sie als pointermove, z. B. mittlere = Hand-Werkzeug)
        if (e.buttons & ~1) return this.end('cancel', e);
        this.last = e;
        if (!this.moved && Math.hypot(e.clientX - this.x0, e.clientY - this.y0) >= 3) this.moved = true;
        if (this.handler && this.handler.move) this.handler.move(e);
      },
      opts,
    );
    window.addEventListener(
      'pointerup',
      (e) => {
        if (e.pointerId === this.id) this.end('up', e);
      },
      opts,
    );
    window.addEventListener(
      'pointercancel',
      (e) => {
        if (e.pointerId === this.id) this.end('cancel', e);
      },
      opts,
    );
    captureEl.addEventListener(
      'lostpointercapture',
      (e) => {
        // regulär folgt lostpointercapture auf pointerup; vorher bedeutet es einen Abbruch
        if (e.pointerId === this.id) this.end('cancel', e);
      },
      { signal: this.ac.signal },
    );
    window.addEventListener('blur', () => this.end('cancel'), { signal: this.ac.signal });
    // ein weiterer Zeiger (z. B. zweiter Finger) bricht die Geste ab
    window.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerId !== this.id || e.button !== 0) this.end('cancel', e);
      },
      opts,
    );
  }
  /** Bearbeiter setzen: `{ move(e), end(reason, e) }`; die letzte Zeigerposition wird nachgereicht. */
  attach(handler) {
    this.handler = handler;
    if (this.ended) {
      if (handler.end) handler.end(this.reason, this.last);
      return;
    }
    if (handler.move && this.moved) handler.move(this.last);
  }
  end(reason, e) {
    if (this.ended) return;
    this.ended = true;
    this.reason = reason;
    if (e) this.last = e;
    this.ac.abort();
    try {
      if (this.el.hasPointerCapture(this.id)) this.el.releasePointerCapture(this.id);
    } catch {}
    if (this.onDone) this.onDone(this);
    if (this.handler && this.handler.end) this.handler.end(reason, this.last);
  }
  cancel() {
    this.end('cancel');
  }
}

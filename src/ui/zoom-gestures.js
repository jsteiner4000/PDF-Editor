/**
 * Zoom- und Verschiebegesten im Seitenbereich: Strg+Mausrad (stufenweise), Touchpad-Pinch
 * (stufenlos), Leertaste gedrückt halten bzw. mittlere Maustaste = Ausschnitt verschieben.
 */

/** Mausrad-Ausschlag (CSS-px), der einer Zoomstufe entspricht. */
const WHEEL_STEP = 50;

const isField = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

/**
 * Gesten für `app` (App) im Scrollbereich `scroller`.
 *
 * Strg+Rad und Pinch kommen im Browser beide als `wheel` mit `ctrlKey` an. Unterschieden wird über
 * die tatsächlich gedrückte Strg-Taste (Pinch meldet `ctrlKey`, ohne dass ein keydown kam) und die
 * Größe der Ausschläge: Rasten (≥ 50 px, ganzzahlig, oder zeilenweise) zoomen eine Stufe weiter,
 * feine Ausschläge stufenlos um exp(−Δ/100).
 */
export class ZoomGestures {
  constructor(app, scroller) {
    this.app = app;
    this.scroller = scroller;
    this.ctrlDown = false;
    this.wheelAcc = 0;
    this.wheelT = 0;
    this.spaceDown = false;
    this.pan = null;
    scroller.addEventListener('wheel', (ev) => this.onWheel(ev), { passive: false });
    scroller.addEventListener('pointerdown', (ev) => this.onPointerDown(ev), { capture: true });
    scroller.addEventListener('mousedown', (ev) => {
      if (ev.button === 1) ev.preventDefault(); // kein Auto-Scrollen mit der mittleren Taste
    });
    window.addEventListener('keydown', (ev) => this.onKeyDown(ev));
    window.addEventListener('keyup', (ev) => this.onKeyUp(ev));
    window.addEventListener('blur', () => {
      this.ctrlDown = false;
      this.setSpace(false);
    });
  }
  onWheel(ev) {
    if (!ev.ctrlKey) return;
    ev.preventDefault();
    if (!this.app.session) return;
    const anchor = { clientX: ev.clientX, clientY: ev.clientY };
    const dy = ev.deltaY * (ev.deltaMode === 1 ? 33 : ev.deltaMode === 2 ? 800 : 1);
    if (!dy) return;
    const notched =
      this.ctrlDown || ev.deltaMode !== 0 || (Math.abs(dy) >= WHEEL_STEP && Number.isInteger(dy));
    if (!notched) {
      this.app.zoomBy(Math.min(2, Math.max(0.5, Math.exp(-dy / 100))), anchor);
      return;
    }
    // Rasten: eine Stufe je Raste; hochauflösende Räder sammeln die Ausschläge
    clearTimeout(this.wheelT);
    this.wheelT = setTimeout(() => (this.wheelAcc = 0), 300);
    if (Math.sign(dy) !== Math.sign(this.wheelAcc)) this.wheelAcc = 0;
    this.wheelAcc += dy;
    if (Math.abs(this.wheelAcc) < WHEEL_STEP) return;
    const dir = this.wheelAcc < 0 ? 1 : -1;
    this.wheelAcc = 0;
    this.app.zoomStep(dir, anchor);
  }
  /** Darf die Leertaste gerade das Hand-Werkzeug auslösen? */
  canPan(ev) {
    const app = this.app;
    return (
      app.session &&
      !isField(ev.target) &&
      !isField(document.activeElement) &&
      !document.querySelector('.backdrop') &&
      !this.scroller.classList.contains('hidden') &&
      !(app.edit && (app.edit.editor || (app.edit.curReq && !app.edit.curReq.done)))
    );
  }
  onKeyDown(ev) {
    if (ev.key === 'Control') this.ctrlDown = true;
    if (ev.code !== 'Space' && ev.key !== ' ') return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey || !this.canPan(ev)) return;
    ev.preventDefault(); // kein Seitenweise-Scrollen, kein Auslösen fokussierter Schaltflächen
    if (!ev.repeat) this.setSpace(true);
  }
  onKeyUp(ev) {
    if (ev.key === 'Control') this.ctrlDown = false;
    if (ev.code === 'Space' || ev.key === ' ') {
      if (this.spaceDown) ev.preventDefault();
      this.setSpace(false);
    }
  }
  setSpace(on) {
    this.spaceDown = on;
    this.scroller.classList.toggle('pan-ready', on);
  }
  onPointerDown(ev) {
    const middle = ev.button === 1 && ev.pointerType === 'mouse';
    if (!((this.spaceDown && ev.button === 0) || middle) || !this.app.session) return;
    ev.preventDefault();
    ev.stopPropagation();
    const scroller = this.scroller;
    const pan = (this.pan = {
      id: ev.pointerId,
      x: ev.clientX,
      y: ev.clientY,
      left: scroller.scrollLeft,
      top: scroller.scrollTop,
      ctl: new AbortController(),
    });
    try {
      scroller.setPointerCapture(ev.pointerId);
    } catch {}
    scroller.classList.add('panning');
    const opts = { signal: pan.ctl.signal, capture: true };
    const end = () => {
      pan.ctl.abort();
      scroller.classList.remove('panning');
      if (this.pan === pan) this.pan = null;
    };
    scroller.addEventListener(
      'pointermove',
      (e) => {
        if (e.pointerId !== pan.id) return;
        e.stopPropagation();
        if (!e.buttons) return end();
        scroller.scrollLeft = pan.left - (e.clientX - pan.x);
        scroller.scrollTop = pan.top - (e.clientY - pan.y);
      },
      opts,
    );
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture'])
      scroller.addEventListener(
        type,
        (e) => {
          if (e.pointerId !== pan.id) return;
          e.stopPropagation();
          end();
        },
        opts,
      );
  }
}

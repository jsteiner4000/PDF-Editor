/**
 * Scharfe Darstellung bei hohem Zoom: ein Detail-Canvas je sichtbarer Seite, der nur den
 * sichtbaren Ausschnitt (plus Überstand) in voller Bildschirmauflösung zeigt.
 *
 * Warum kein Kachelraster: pdf.js arbeitet bei jedem Renderaufruf die komplette Operatorliste der
 * Seite ab (gezeichnet wird nur, was im Canvas liegt). Kacheln vervielfachen diesen Aufwand mit
 * ihrer Anzahl; ein einziger Ausschnitt je Seite braucht einen Aufruf, sein Speicher ist durch die
 * Fenstergröße begrenzt und ein Abbruch betrifft genau eine Aufgabe.
 */

/** Höchstzahl der Pixel aller Detail-Canvas zusammen. */
export const DETAIL_MAX_PX = 12e6;

/** Überstand je Seite (Anteil der Fenstergröße), damit kurzes Scrollen scharf bleibt. */
const OVERSCAN = [0.5, 0.25, 0];

/** Wartezeit nach Scrollen/Zoomen, bevor neu gerendert wird (ms), und Höchstwartezeit. */
const DEBOUNCE_MS = 90;
const MAX_WAIT_MS = 260;

const intersect = (a, b) => {
  const r = {
    left: Math.max(a.left, b.left),
    top: Math.max(a.top, b.top),
    right: Math.min(a.right, b.right),
    bottom: Math.min(a.bottom, b.bottom),
  };
  return r.right > r.left && r.bottom > r.top ? r : null;
};

const area = (r) => (r ? (r.right - r.left) * (r.bottom - r.top) : 0);

const grow = (r, dx, dy) => ({
  left: r.left - dx,
  top: r.top - dy,
  right: r.right + dx,
  bottom: r.bottom + dy,
});

/**
 * Plant und rendert die Detail-Canvas der Seitenansichten von `app` (`app.pvs`, `app.renderer`,
 * Scrollbereich `#scroller`). `schedule()` nach Scrollen/Zoomen/Änderungen; veraltete
 * Renderaufgaben werden abgebrochen, unsichtbare Seiten freigegeben.
 */
export class DetailRenderer {
  constructor(app, scroller) {
    this.app = app;
    this.scroller = scroller;
    this.timer = 0;
    this.firstAsk = 0;
    this.running = null; // { pv, plan, task }
    this.busy = false;
    this.again = false;
    /** Messwerte der letzten Renderaufgaben (ms), für Tests und Diagnose. */
    this.stats = [];
  }
  /** true, solange geplant oder gerendert wird. */
  get pending() {
    return !!this.timer || this.busy;
  }
  /** Rendern nach kurzer Ruhezeit anstoßen (`delay` = 0: sofort, z. B. nach einer Änderung). */
  schedule(delay = DEBOUNCE_MS) {
    const now = performance.now();
    if (!this.timer) this.firstAsk = now;
    clearTimeout(this.timer);
    const wait = Math.max(0, Math.min(delay, this.firstAsk + MAX_WAIT_MS - now));
    this.timer = setTimeout(() => {
      this.timer = 0;
      this.run();
    }, wait);
    // laufende Aufgabe abbrechen, wenn sie den neuen Ausschnitt nicht mehr abdeckt
    if (this.running) {
      const plans = this.plan();
      const plan = plans && plans.get(this.running.pv);
      if (!plan || !this.covers(this.running.plan, plan)) this.cancelRunning();
    }
  }
  cancelRunning() {
    if (this.running && this.running.task) {
      try {
        this.running.task.cancel();
      } catch {}
    }
  }
  /** Alle Detail-Canvas verwerfen (z. B. Dokument geschlossen). */
  reset() {
    clearTimeout(this.timer);
    this.timer = 0;
    this.cancelRunning();
    for (const pv of this.app.pvs) pv.clearDetail();
  }
  /**
   * Soll-Ausschnitte: Map pv → { sig, scale, dpr, res, X, Y, W, H, core } mit X…H in Geräte-Pixeln
   * der ganzen Seite bei `scale` × `res` und `core` = sichtbarer Teil in CSS-px der Seite.
   * Seiten ohne Bedarf (Vorschau scharf genug, nicht sichtbar) fehlen in der Map.
   */
  plan() {
    const app = this.app;
    const scroller = this.scroller;
    if (!app.session || scroller.classList.contains('hidden') || !scroller.clientWidth) return new Map();
    const dpr = window.devicePixelRatio || 1;
    const sr = scroller.getBoundingClientRect();
    const view = {
      left: sr.left + scroller.clientLeft,
      top: sr.top + scroller.clientTop,
      right: sr.left + scroller.clientLeft + scroller.clientWidth,
      bottom: sr.top + scroller.clientTop + scroller.clientHeight,
    };
    const vw = view.right - view.left;
    const vh = view.bottom - view.top;
    const pages = [];
    for (const pv of app.pvs) {
      if (!pv.visible || !pv.info || !pv.previewSize(dpr).capped) continue;
      const rect = pv.el.getBoundingClientRect();
      const core = intersect(rect, view);
      if (core) pages.push({ pv, rect, core });
    }
    const plans = new Map();
    if (!pages.length) return plans;
    // größten Überstand wählen, der ins Pixelbudget passt; notfalls Auflösung senken
    let regions = null;
    let res = dpr;
    for (const f of OVERSCAN) {
      const ext = grow(view, vw * f, vh * f);
      const list = pages.map((p) => intersect(p.rect, ext));
      const px = list.reduce((sum, r) => sum + area(r), 0) * dpr * dpr;
      if (px <= DETAIL_MAX_PX || f === 0) {
        regions = list;
        if (px > DETAIL_MAX_PX) res = dpr * Math.sqrt(DETAIL_MAX_PX / px);
        break;
      }
    }
    pages.forEach((p, i) => {
      const r = regions[i];
      const { pv, rect } = p;
      const X = Math.max(0, Math.floor((r.left - rect.left) * res));
      const Y = Math.max(0, Math.floor((r.top - rect.top) * res));
      const X1 = Math.min(Math.round(pv.dw * res), Math.ceil((r.right - rect.left) * res));
      const Y1 = Math.min(Math.round(pv.dh * res), Math.ceil((r.bottom - rect.top) * res));
      if (X1 <= X || Y1 <= Y) return;
      plans.set(pv, {
        sig: pv.sig,
        scale: pv.scale,
        dpr,
        res,
        X,
        Y,
        W: X1 - X,
        H: Y1 - Y,
        core: {
          left: p.core.left - rect.left,
          top: p.core.top - rect.top,
          right: p.core.right - rect.left,
          bottom: p.core.bottom - rect.top,
        },
      });
    });
    return plans;
  }
  /** Deckt der vorhandene/laufende Ausschnitt `have` den sichtbaren Teil von `want` ab? */
  covers(have, want) {
    if (!have || have.sig !== want.sig || have.dpr !== want.dpr || Math.abs(have.res - want.res) > 1e-6)
      return false;
    if (Math.abs(have.scale - want.scale) > 1e-9) return false;
    const c = want.core;
    const e = 0.5; // CSS-px Toleranz
    return (
      have.X / have.res <= c.left + e &&
      have.Y / have.res <= c.top + e &&
      (have.X + have.W) / have.res >= c.right - e &&
      (have.Y + have.H) / have.res >= c.bottom - e
    );
  }
  async run() {
    if (this.busy) {
      this.again = true;
      return;
    }
    this.busy = true;
    try {
      do {
        this.again = false;
        const plans = this.plan();
        for (const pv of this.app.pvs) if (!plans.has(pv)) pv.clearDetail();
        // Seite mit dem größten sichtbaren Anteil zuerst
        const todo = [...plans].sort((a, b) => area(b[1].core) - area(a[1].core));
        for (const [pv, plan] of todo) {
          if (this.timer) break; // neue Anforderung kommt gleich – dann mit frischem Plan
          const info = pv.detailInfo;
          const have = info && {
            ...info,
            X: info.x * info.res,
            Y: info.y * info.res,
            W: info.w * info.res,
            H: info.h * info.res,
          };
          if (this.covers(have, plan)) continue;
          await this.renderOne(pv, plan);
        }
      } while (this.again);
    } finally {
      this.busy = false;
    }
  }
  async renderOne(pv, plan) {
    const renderer = this.app.renderer;
    const gen = renderer.gen;
    const job = { pv, plan, task: null };
    this.running = job;
    const t0 = performance.now();
    let canvas = null;
    try {
      canvas = await renderer.renderRegion(
        pv.index,
        plan.scale * plan.res,
        { x: plan.X, y: plan.Y, width: plan.W, height: plan.H },
        {
          onTask: (task) => (job.task = task),
          isStale: () => this.running !== job || job.cancelled,
        },
      );
    } catch (err) {
      console.warn('Detaildarstellung fehlgeschlagen', err);
    } finally {
      if (this.running === job) this.running = null;
    }
    if (!canvas) return;
    // Ergebnis verwerfen, wenn sich Dokument, Zoom oder Seite inzwischen geändert haben
    if (
      gen !== renderer.gen ||
      pv.sig !== plan.sig ||
      Math.abs(pv.scale - plan.scale) > 1e-9 ||
      !pv.visible
    ) {
      canvas.width = canvas.height = 0;
      this.again = true;
      return;
    }
    pv.setDetail(canvas, {
      sig: plan.sig,
      scale: plan.scale,
      dpr: plan.dpr,
      res: plan.res,
      x: plan.X / plan.res,
      y: plan.Y / plan.res,
      w: plan.W / plan.res,
      h: plan.H / plan.res,
    });
    this.stats.push({ ms: Math.round(performance.now() - t0), px: plan.W * plan.H, zoom: this.app.zoom });
    if (this.stats.length > 50) this.stats.shift();
  }
}

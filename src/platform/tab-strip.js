/**
 * Tab-Leiste der Desktop-App (wie Chrome/Edge): ein Tab je geöffnetem Dokument, das Haus-Symbol ist
 * die Startseite. Jeder Tab ist im Hauptprozess eine eigene Programmansicht; diese Leiste zeigt die
 * Tabs des Fensters an und meldet Klicks, Schließen, Umordnen und Herausziehen zurück.
 *
 * Ziehen: waagerecht ordnet um (die Nachbarn rücken weich zur Seite); weiter als 40 px nach unten
 * oder aus dem Fenster heraus löst den Tab – losgelassen über der Tab-Leiste eines anderen
 * Fensters wandert er dorthin, sonst öffnet er ein neues Fenster.
 */
import { escapeHtml, htmlToElement } from '../ui/dom.js';
import { icon } from '../ui/icons.js';

const DETACH = 40;

export function installTabStrip(tabs, app) {
  document.documentElement.classList.add('tabbed');
  const nav = document.getElementById('tabs');
  const home = document.getElementById('tHome');
  let state = { tabs: [], active: 0, self: 0 };
  let drag = null;

  function render(data) {
    if (data) state = data;
    if (drag) return; // während des Ziehens nicht neu aufbauen
    for (const el of nav.querySelectorAll('.xtab')) el.remove();
    const activeTab = state.tabs.find((t) => t.id === state.active);
    home.classList.toggle('on', !activeTab || activeTab.kind === 'home');
    for (const t of state.tabs) {
      if (t.kind === 'home') continue;
      const on = t.id === state.active;
      const el = htmlToElement(
        `<div class="doctab xtab${on ? ' on' : ''}" role="tab" aria-selected="${on}" tabindex="0" data-id="${t.id}" title="${escapeHtml(t.name)}"><span class="ti ${t.kind === 'docs' ? 'c6' : 'c1'}">${icon(t.kind === 'docs' ? 'binder' : 'file', 's')}</span><span class="nm">${escapeHtml(t.name)}</span>${t.dirty ? '<span class="dot" title="Ungespeicherte Änderungen"></span>' : ''}<button class="btn ic" title="Tab schließen (Strg+W)" aria-label="${escapeHtml(t.name)} schließen">${icon('close', 's')}</button></div>`,
      );
      el.querySelector('button').addEventListener('click', (ev) => {
        ev.stopPropagation();
        tabs.close(t.id);
      });
      el.addEventListener('keydown', (ev) => {
        if (ev.target === el && (ev.key === 'Enter' || ev.key === ' ')) {
          ev.preventDefault();
          tabs.activate(t.id);
        }
      });
      // mittlere Maustaste schließt (wie im Browser)
      el.addEventListener('auxclick', (ev) => ev.button === 1 && tabs.close(t.id));
      el.addEventListener('pointerdown', (ev) => startDrag(ev, el, t));
      nav.appendChild(el);
    }
  }

  function startDrag(ev, el, t) {
    if (ev.button !== 0 || ev.target.closest('button')) return;
    ev.preventDefault();
    el.setPointerCapture(ev.pointerId);
    const siblings = [...nav.querySelectorAll('.xtab')];
    drag = { el, t, x0: ev.clientX, y0: ev.clientY, moved: false, detached: false, from: siblings.indexOf(el), to: siblings.indexOf(el), siblings, rects: siblings.map((s) => s.getBoundingClientRect()) };
    const move = (e) => {
      const dx = e.clientX - drag.x0;
      const dy = e.clientY - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      if (!drag.moved) {
        drag.moved = true;
        el.classList.add('dragging');
        nav.classList.add('reordering');
      }
      const strip = nav.getBoundingClientRect();
      const out = e.clientY > strip.bottom + DETACH || e.clientY < -8 || e.clientX < 0 || e.clientX > innerWidth;
      drag.detached = out && state.tabs.length > 1;
      el.classList.toggle('detaching', drag.detached);
      // waagerecht mitgehen (innerhalb der Leiste), Nachbarn rücken zur Seite
      const r = drag.rects[drag.from];
      const min = drag.rects[0].left - r.left;
      const max = drag.rects[drag.rects.length - 1].right - r.right;
      const x = drag.detached ? dx : Math.max(min, Math.min(max, dx));
      el.style.transform = `translate(${x}px, ${drag.detached ? dy : 0}px)`;
      const mid = r.left + r.width / 2 + x;
      let to = drag.siblings.length - 1;
      for (let i = 0; i < drag.rects.length; i++)
        if (mid < drag.rects[i].left + drag.rects[i].width / 2) {
          to = i;
          break;
        }
      drag.to = drag.detached ? drag.from : to;
      drag.siblings.forEach((s, i) => {
        if (s === el) return;
        const shift = drag.to > drag.from && i > drag.from && i <= drag.to ? -r.width - 4 : drag.to < drag.from && i >= drag.to && i < drag.from ? r.width + 4 : 0;
        s.style.transform = shift ? `translateX(${shift}px)` : '';
      });
    };
    const up = (e) => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      const d = drag;
      drag = null;
      nav.classList.remove('reordering');
      for (const s of d.siblings) s.style.transform = '';
      el.classList.remove('dragging', 'detaching');
      if (!d.moved) {
        if (d.t.id !== state.self) tabs.activate(d.t.id);
        return render();
      }
      if (e.type === 'pointerup' && d.detached) tabs.drop(d.t.id, e.screenX, e.screenY);
      else if (d.to !== d.from) tabs.reorder(d.t.id, d.to);
      render();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  return {
    render,
    /** Dokument in neuem Tab öffnen (bzw. den Tab, in dem es schon offen ist). */
    open: (open) => tabs.open(open),
    /** Startseite des Fensters (eigener Tab); `ws`: dort diesen Arbeitsbereich zeigen. */
    home: (ws) => tabs.home(ws),
    /** Dokument dieses Tabs wurde geschlossen: Tab entfernen (der letzte bleibt als Startseite). */
    closedSelf: () => tabs.closedSelf(),
    get self() {
      return state.self;
    },
    app,
  };
}

/**
 * Arbeitsbereich „Dokumentation erstellen“: links die Projektmappe (Abschnitte), in der Mitte die
 * Seiten als Live-Vorschau, rechts die Eigenschaften des Gewählten. Bedienung wie in Office:
 * Werkzeugband oben, Strg+Z/Y, Strg+S = PDF erstellen, Strg+P = Drucken.
 *
 * Jede Änderung läuft über `change()` (Verlauf für Rückgängig, Vorschau, Sicherung als Entwurf).
 * Im Schaltbild lassen sich Baugruppen verschieben (auch auf die andere Seite), in der Höhe ziehen
 * und ihre Leitungen verschieben.
 */
import STUDIO_CSS from './studio.css';
import { icon } from '../ui/icons.js';
import { $, $$, escapeHtml, htmlToElement } from '../ui/dom.js';
import { closeMenu, showMenu, showPopover } from '../ui/menu.js';
import { downloadBytes, pickFiles, showDialog, toast, withBusy } from '../ui/dialogs.js';
import { idbPut } from '../storage/idb.js';
import { notifyDocumentState } from '../platform/desktop-bridge.js';
import {
  ACCESS_BLOCKS,
  BLOCK_TYPES,
  PHOTO_LAYOUTS,
  SYMBOLS,
  newBlock,
  starterChapters,
  newAccess,
  newBox,
  newCustomSymbol,
  newDevice,
  newPhoto,
  newPhotos,
  newSite,
  newSymbol,
  symbolInfo,
  symbolLabels,
  newHint,
  newPin,
  newProject,
  newRemote,
  newWifi,
  newWiring,
  withoutSecrets,
  normalizeProject,
  pruneImages,
  sectionTitle,
  tx,
  uid,
} from './model.js';
import { documentLabel, renderDocument } from './render.js';
import { PAGE, typesetter } from './svg.js';
import { DIAGRAM } from './wiring.js';
import { blockHasData } from './access.js';
import { photoDate } from './exif.js';
import { PdfRenderer } from '../render/pdf-renderer.js';
import { deleteDraft, listDrafts, loadDraft, saveDraft } from './store.js';
import { ensureBarlow } from './fonts.js';
import { TooLargeError, assertPrintable, canMakePdf, embedProject, hasProject, makePdf, printHtml, readProject } from './export.js';
import { PDFDocument } from 'pdf-lib';
import { Inspector } from './inspector.js';
import { symbolIconSvg } from './site.js';

export { deleteDraft, listDrafts };

/** Vorlagen auf der Startseite („Neu“). */
export const STUDIO_TEMPLATES = [
  { id: 'documentation', title: 'Anlagendokumentation', desc: 'Lageplan, Anschlussplan, Zugangsdaten, Fotos' },
  { id: 'manual', title: 'Bedienungsanleitung', desc: 'Kapitel, Schritte, Warnhinweise, Störungen' },
  { id: 'tech', title: 'Technische Beschreibung', desc: 'Aufbau, Funktion, technische Daten' },
  { id: 'wiring', title: 'Anschlussplan', desc: 'Schaltbild, Klemmenplan und Hinweise' },
];

function templateProject(id) {
  return newProject(['wiring', 'manual', 'tech'].includes(id) ? id : 'documentation');
}

const previews = new Map();

/** Vorschaubild einer Vorlage als SVG. */
export function templatePreview(id) {
  if (!previews.has(id)) {
    let svg = '';
    try {
      const doc = renderDocument(newProject(id));
      // Anleitungen: erste Inhaltsseite; sonst Deckblatt bzw. Plan
      const at = id === 'manual' || id === 'tech' ? 2 : 0;
      svg = (doc.pages[at] || doc.pages[0]).svg;
    } catch (err) {
      console.warn('Vorschau der Vorlage', err);
    }
    previews.set(id, svg);
  }
  return previews.get(id);
}

const PX_PER_PT = 96 / 72;
const ZOOMS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

let cssInjected = false;

export class Studio {
  constructor(app) {
    this.app = app;
    this.project = null;
    this.sel = { kind: 'project' };
    this.hist = { undo: [], redo: [] };
    this.snap = '';
    this.zoom = null; // null = Seitenbreite
    this.doc = null;
    this.root = null;
    this.saveTimer = 0;
    this.frame = 0;
  }

  /* ---------- Aufbau ---------- */

  mount() {
    if (this.root) return;
    if (!cssInjected) {
      const style = document.createElement('style');
      style.textContent = STUDIO_CSS;
      document.head.appendChild(style);
      cssInjected = true;
    }
    this.root = htmlToElement(`
<div id="studio" class="hidden">
  <aside class="sd-side" aria-label="Projektmappe">
    <div class="sd-head"><span>Projektmappe</span><button class="btn ic" id="sdAdd" title="Abschnitt hinzufügen">${icon('plus')}</button></div>
    <div class="sd-list">
      <button class="sd-proj" id="sdProj"><span class="ti c6">${icon('binder')}</span><span class="tx"><b></b><small></small></span></button>
      <ol class="sd-secs" id="sdSecs"></ol>
    </div>
  </aside>
  <section class="sd-center">
    <div class="sd-scroll" id="sdScroll" tabindex="-1"><div class="sd-pages" id="sdPages"></div></div>
    <div class="sd-nav">
      <button class="btn ic" id="sdZout" title="Verkleinern (Strg+−)">${icon('zout')}</button>
      <button class="btn zv" id="sdZoom" title="Seitenbreite">100 %</button>
      <button class="btn ic" id="sdZin" title="Vergrößern (Strg++)">${icon('zin')}</button>
      <button class="btn ic" id="sdFit" title="Seitenbreite (Strg+0)">${icon('fitw')}</button>
    </div>
  </section>
  <aside class="sd-insp" aria-label="Eigenschaften"><div class="sd-ihead" id="sdIHead"></div><div class="sd-ibody" id="sdIBody"></div></aside>
</div>`);
    this.app.root.appendChild(this.root);
    this.inspector = new Inspector(this, $('#sdIHead'), $('#sdIBody'));
    $('#sdAdd').addEventListener('click', (ev) => this.addSectionMenu(ev.currentTarget));
    $('#sdProj').addEventListener('click', () => this.select({ kind: 'project' }));
    $('#sdZin').addEventListener('click', () => this.zoomStep(1));
    $('#sdZout').addEventListener('click', () => this.zoomStep(-1));
    $('#sdFit').addEventListener('click', () => this.setZoom(null));
    $('#sdZoom').addEventListener('click', () => this.setZoom(null));
    const scroll = $('#sdScroll');
    scroll.addEventListener(
      'wheel',
      (ev) => {
        if (!ev.ctrlKey && !ev.metaKey) return;
        ev.preventDefault();
        this.zoomStep(ev.deltaY < 0 ? 1 : -1);
      },
      { passive: false },
    );
    scroll.addEventListener('pointerdown', (ev) => this.onPointerDown(ev));
    scroll.addEventListener('pointermove', (ev) => this.onPointerMove(ev));
    scroll.addEventListener('pointerup', (ev) => this.onPointerUp(ev));
    scroll.addEventListener('pointercancel', (ev) => this.onPointerUp(ev, true));
    scroll.addEventListener('pointerleave', () => this.hover(null));
    scroll.addEventListener('dblclick', (ev) => {
      const hit = this.hitAt(ev);
      if (hit && hit.item.kind === 'box') this.inspector.focusFirst();
    });
    new ResizeObserver(() => {
      if (this.visible && this.zoom == null) this.layout();
    }).observe(scroll);
  }

  setVisible(visible) {
    this.visible = visible;
    const tab = $('#prjTab');
    if (tab) {
      tab.classList.toggle('hidden', !this.project);
      tab.classList.toggle('on', visible);
    }
    if (!this.root) {
      if (!visible) return;
      this.mount();
    }
    this.root.classList.toggle('hidden', !visible);
    if (visible && this.project) {
      this.renderPages();
      this.inspector.render();
    }
  }

  /* ---------- Projekt öffnen, schließen, sichern ---------- */

  async create(templateId) {
    const project = templateProject(templateId);
    applyCompany(project);
    await this.open(project);
  }

  async openDraft(id) {
    if (this.project && this.project.id === id) return this.app.setView('studio');
    try {
      const raw = await loadDraft(id);
      if (!raw) throw new Error('fehlt');
      await this.open(normalizeProject(raw));
    } catch {
      toast('Der Entwurf konnte nicht geöffnet werden.', 'err', 5000);
    }
  }

  async open(project, sel = null) {
    if (this.project) await this.flush();
    this.project = project;
    this.hist = { undo: [], redo: [] };
    this.snap = this.serialize();
    this.sel = sel || { kind: 'project' };
    this.zoom = null;
    this.armed = null;
    this.updateArmHint();
    if (project.font === 'barlow') await ensureBarlow().catch(() => {});
    this.mount();
    this.updateTab();
    this.app.setView('studio');
    this.layout();
    this.saveSoon(0);
  }

  async close() {
    await this.flush();
    this.armed = null;
    this.updateArmHint();
    this.project = null;
    this.doc = null;
    if (this.root) $('#sdPages').innerHTML = '';
    $('#prjTab').classList.add('hidden');
    // im Arbeitsbereich „Dokumentation“ bleiben (eine offene PDF läuft im Bereich „PDF“ weiter)
    await this.app.showHome();
    this.app.setView('home');
  }

  /** Stand für den Verlauf: ohne Bilder (getrennt gehalten) und ohne Änderungszeit. */
  serialize() {
    return JSON.stringify({ ...this.project, images: undefined, modified: undefined });
  }

  saveSoon(delay = 700) {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.flush(), delay);
  }

  /** Entwurf sofort sichern (vor dem Schließen, Wechsel auf die Startseite, PDF erstellen). */
  async flush() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    if (!this.project) return;
    try {
      await saveDraft(pruneImages(this.project), { name: documentLabel(this.project), sub: this.subtitle() });
    } catch (err) {
      console.warn('Entwurf nicht gesichert', err);
    }
    rememberCompany(this.project);
  }

  subtitle() {
    const m = this.project.meta;
    return [m.customer, m.site].filter(Boolean).join(' · ');
  }

  /** Titel des Projekts (Reiter, Fenstertitel, Dateiname). */
  title() {
    return this.project ? documentLabel(this.project) : '';
  }

  updateTab() {
    const tab = $('#prjTab');
    if (!tab || !this.project) return;
    tab.classList.remove('hidden');
    const name = documentLabel(this.project);
    $('#prjName').textContent = name;
    tab.title = name;
  }

  /**
   * Nach dem Öffnen einer PDF: enthält sie ein PDFix-Projekt, Weiterbearbeiten anbieten. Entpackt
   * wird das Projekt erst beim Klick (mit Größengrenze).
   */
  offerProject(session) {
    const old = document.getElementById('sdOffer');
    if (old) old.remove();
    if (!hasProject(session.doc)) return;
    const bar = htmlToElement(
      `<div class="sd-offer" id="sdOffer">${icon('binder', 's')}<span>Diese PDF wurde mit <b>Dokumentation erstellen</b> angelegt.</span><button class="btn primary">Weiterbearbeiten</button><button class="btn ic" title="Ausblenden">${icon('x', 's')}</button></div>`,
    );
    const [go, hide] = bar.querySelectorAll('button');
    hide.addEventListener('click', () => bar.remove());
    go.addEventListener('click', async () => {
      if (await this.importFrom(session.doc)) bar.remove();
    });
    $('#center').appendChild(bar);
  }

  /** Projekt aus einer geladenen PDF (pdf-lib) übernehmen – mit den nötigen Rückfragen. */
  async importFrom(doc) {
    const found = readProject(doc);
    if (!found) {
      toast('Die Projektdaten in dieser PDF sind nicht lesbar.', 'err', 5000);
      return false;
    }
    if (found.changed) {
      const ok = await showDialog({
        title: 'Dokumentation weiterbearbeiten',
        icon: 'info',
        body: 'Die PDF wurde nach dem Erstellen verändert. Diese Änderungen sind im Projekt nicht enthalten – sie fehlen, wenn die PDF neu erstellt wird.',
        buttons: [
          { label: 'Abbrechen', value: false },
          { label: 'Weiterbearbeiten', primary: true, value: true },
        ],
      });
      if (!ok) return false;
    }
    if (found.project.sections.some((s) => s.secretsRemoved))
      toast('Diese PDF wurde ohne Passwörter erstellt – sie fehlen im Projekt.', 'warn', 6000);
    return this.openImported(found.project);
  }

  /**
   * „Aus PDF fortsetzen“ (Arbeitsbereich Dokumentation): die Bytes einer PDF prüfen und die darin
   * gespeicherte Dokumentation öffnen. Ergebnis: 'opened', 'cancel' oder 'none' (keine Dokumentation).
   */
  async continueFromPdf(bytes) {
    let doc;
    try {
      doc = await withBusy(() => PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false }));
    } catch {
      return 'none';
    }
    if (!hasProject(doc)) return 'none';
    return (await this.importFrom(doc)) ? 'opened' : 'cancel';
  }

  /**
   * Projekt aus einer PDF öffnen, ohne einen neueren Stand zu überschreiben: Gibt es dasselbe
   * Projekt als Entwurf (oder geöffnet) mit jüngerer Änderung, wird gefragt, welcher Stand gilt –
   * der Stand der PDF öffnet dann als Kopie.
   */
  async openImported(project) {
    let current = this.project && this.project.id === project.id ? this.project : null;
    if (!current)
      try {
        const draft = await loadDraft(project.id);
        current = draft ? normalizeProject(draft) : null;
      } catch {}
    if (current && (current.modified || 0) > (project.modified || 0)) {
      const choice = await showDialog({
        title: 'Neuerer Entwurf vorhanden',
        icon: 'info',
        body: 'Dieses Projekt wurde nach dem Erstellen der PDF weiterbearbeitet. Welchen Stand möchten Sie öffnen?',
        buttons: [
          { label: 'Abbrechen', value: null },
          { label: 'Stand der PDF (als Kopie)', value: 'pdf' },
          { label: 'Neueren Entwurf', primary: true, value: 'draft' },
        ],
      });
      if (!choice) return false;
      if (choice === 'draft') {
        if (current === this.project) this.app.setView('studio');
        else await this.open(current);
        return true;
      }
      project = { ...project, id: uid('prj') };
    }
    await this.open(project);
    return true;
  }

  /* ---------- Änderungen und Verlauf ---------- */

  /**
   * Führt eine Änderung aus: `fn(project)` ändert das Projekt. `key` fasst schnelle Folgeänderungen
   * (Tippen in einem Feld) zu einem Schritt zusammen; `inspector: true` baut die Eigenschaften neu.
   */
  change(label, fn, { key = null, inspector = false } = {}) {
    if (!this.project) return;
    const before = this.snap;
    fn(this.project);
    this.commit(label, before, key);
    if (inspector) this.inspector.render();
  }

  /** Verlaufsschritt für eine bereits ausgeführte Änderung (z. B. nach dem Ziehen). */
  commit(label, before, key = null) {
    const after = this.serialize();
    if (after === before) return;
    const last = this.hist.undo[this.hist.undo.length - 1];
    const now = Date.now();
    if (key && last && last.key === key && now - last.t < 2000) last.t = now;
    else {
      this.hist.undo.push({ label, before, key, t: now });
      if (this.hist.undo.length > 300) this.hist.undo.shift();
    }
    this.hist.redo = [];
    this.snap = after;
    this.project.modified = now;
    this.changed();
  }

  changed() {
    // Werkzeugband hängt an Sprache, Schrift und vorhandenem Anschlussplan
    const p = this.project;
    const ribbonKey = `${p.lang}|${p.font}|${p.sections.some((s) => s.type === 'wiring')}`;
    if (ribbonKey !== this.ribbonKey) {
      this.ribbonKey = ribbonKey;
      if (this.visible) this.app.renderRibbon();
    }
    this.updateTab();
    this.updateHist();
    this.schedule();
    this.saveSoon();
  }

  restore(json) {
    const { images, created } = this.project;
    this.project = { ...JSON.parse(json), images, created };
    this.snap = json;
    if (!this.selected()) this.sel = this.sel.section ? { kind: 'section', id: this.sel.section } : { kind: 'project' };
    this.project.modified = Date.now();
    this.checkArmed();
    this.changed();
    this.inspector.render();
    this.app.renderRibbon();
  }

  undo() {
    const entry = this.hist.undo.pop();
    if (!entry) return;
    this.hist.redo.push({ label: entry.label, before: this.snap });
    this.restore(entry.before);
    toast('Rückgängig: ' + entry.label);
  }

  redo() {
    const entry = this.hist.redo.pop();
    if (!entry) return;
    this.hist.undo.push({ label: entry.label, before: this.snap, t: 0 });
    this.restore(entry.before);
    toast('Wiederholt: ' + entry.label);
  }

  updateHist() {
    notifyDocumentState();
    const { undo, redo } = this.hist;
    $('#bUndo').disabled = !undo.length;
    $('#bRedo').disabled = !redo.length;
    $('#bUndo').title = undo.length ? `Rückgängig: ${undo[undo.length - 1].label} (Strg+Z)` : 'Rückgängig (Strg+Z)';
    $('#bRedo').title = redo.length ? `Wiederholen: ${redo[redo.length - 1].label} (Strg+Y)` : 'Wiederholen (Strg+Y)';
  }

  /* ---------- Auswahl ---------- */

  section(id) {
    return this.project && this.project.sections.find((s) => s.id === id);
  }

  /** Das gewählte Objekt (oder null, wenn es nicht mehr existiert). */
  selected() {
    const { kind, id, section } = this.sel;
    if (kind === 'project') return this.project;
    if (kind === 'section') return this.section(id) || null;
    const s = this.section(section);
    if (!s) return null;
    if (kind === 'box') return s.boxes.find((b) => b.id === id) || null;
    if (kind === 'pin') return s.hub.pins.find((p) => p.id === id) || null;
    if (kind === 'hint') return s.hints.find((h) => h.id === id) || null;
    if (kind === 'hub') return s.hub;
    if (kind === 'device') return s.devices.find((d) => d.id === id) || null;
    if (kind === 'wifi') return s.wifi.find((w) => w.id === id) || null;
    if (kind === 'remote') return s.remote.find((r) => r.id === id) || null;
    if (kind === 'block') return s.blocks.find((b) => b.id === id) || null;
    if (kind === 'sym') return s.symbols.find((y) => y.id === id) || null;
    if (kind === 'photo') return s.items.find((p) => p.id === id) || null;
    return null;
  }

  select(sel, { reveal = false } = {}) {
    this.sel = sel;
    // Werkzeugband passt sich der Art des gewählten Abschnitts an (wie Kontext-Reiter in Office)
    const type = this.currentType();
    if (type !== this.ribbonType) {
      this.ribbonType = type;
      if (this.visible) this.app.renderRibbon();
    }
    this.inspector.render();
    this.renderSelection();
    this.renderSide();
    if (reveal) this.reveal();
  }

  /** Art des gewählten Abschnitts ('wiring', 'access', …) oder null. */
  currentType() {
    const id = this.sel.section || (this.sel.kind === 'section' ? this.sel.id : null);
    const s = id && this.section(id);
    return s ? s.type : null;
  }

  /** Zugangsdaten-Abschnitt für neue Einträge: der gewählte, sonst der erste (oder neu). */
  accessSection() {
    const id = this.sel.section || (this.sel.kind === 'section' ? this.sel.id : null);
    const s = id && this.section(id);
    if (s && s.type === 'access') return s;
    const found = this.project.sections.find((x) => x.type === 'access');
    if (found) return found;
    const section = newAccess();
    this.change('Zugangsdaten hinzugefügt', (p) => p.sections.push(section));
    return section;
  }

  /** Neuer Eintrag in den Zugangsdaten: Gerät, WLAN oder Fernzugriff. */
  addAccessItem(kind) {
    const s = this.accessSection();
    const item = kind === 'device' ? newDevice() : kind === 'wifi' ? newWifi() : newRemote();
    const list = kind === 'device' ? 'devices' : kind;
    const label = { device: 'Gerät', wifi: 'WLAN', remote: 'Fernzugriff' }[kind];
    this.change(`${label} hinzugefügt`, () => {
      s[list].push(item);
      s.blocks[list] = true;
    });
    this.select({ kind, id: item.id, section: s.id }, { reveal: true });
    this.inspector.focusFirst();
  }

  /** Wiring-Abschnitt für neue Baugruppen/Anschlüsse: der gewählte, sonst der erste. */
  wiringSection() {
    const id = this.sel.section || (this.sel.kind === 'section' ? this.sel.id : null);
    const s = id && this.section(id);
    if (s && s.type === 'wiring') return s;
    return this.project.sections.find((x) => x.type === 'wiring') || null;
  }

  /* ---------- Vorschau ---------- */

  schedule() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.renderPages();
    });
  }

  pxPerPt() {
    const scroll = $('#sdScroll');
    if (this.zoom != null) return this.zoom * PX_PER_PT;
    const avail = Math.max(200, scroll.clientWidth - 64);
    return Math.min(1.5 * PX_PER_PT, avail / PAGE.w);
  }

  layout() {
    this.scale = this.pxPerPt();
    $('#sdZoom').textContent = Math.round((this.scale / PX_PER_PT) * 100).toLocaleString('de-DE') + ' %';
    this.renderPages();
  }

  setZoom(zoom) {
    const scroll = $('#sdScroll');
    const rel = scroll.scrollTop / Math.max(1, scroll.scrollHeight);
    this.zoom = zoom == null ? null : Math.max(0.25, Math.min(4, zoom));
    this.layout();
    scroll.scrollTop = rel * scroll.scrollHeight;
  }

  zoomStep(dir) {
    const cur = this.scale / PX_PER_PT;
    const next = dir > 0 ? ZOOMS.find((z) => z > cur + 0.001) : [...ZOOMS].reverse().find((z) => z < cur - 0.001);
    this.setZoom(next ?? cur);
  }

  renderPages() {
    if (!this.project || !this.root || !this.visible) return;
    const host = $('#sdPages');
    let doc;
    try {
      doc = renderDocument(this.project);
    } catch (err) {
      console.error('Dokument setzen', err);
      return;
    }
    this.doc = doc;
    const w = PAGE.w * this.scale;
    const h = PAGE.h * this.scale;
    doc.pages.forEach((page, i) => {
      let el = host.children[i];
      if (!el) {
        el = htmlToElement('<div class="sd-page"><div class="sd-svg"></div><div class="sd-marks"></div><span class="sd-pnum"></span></div>');
        host.appendChild(el);
      }
      el.style.width = w + 'px';
      el.style.height = h + 'px';
      el.dataset.index = i;
      el.dataset.section = page.section;
      if (el._svg !== page.svg) {
        el.firstChild.innerHTML = page.svg;
        el._svg = page.svg;
      }
      el.querySelector('.sd-pnum').textContent = `Seite ${i + 1}`;
    });
    while (host.children.length > doc.pages.length) host.lastChild.remove();
    this.renderStarters(host);
    if (!doc.pages.length) host.innerHTML = '';
    this.renderSelection();
    this.renderSide();
  }

  /** Starthilfe auf einem Schaltbild ohne Baugruppen (nur im Editor, nicht in der PDF). */
  renderStarters(host) {
    for (const el of $$('.sd-page', host)) {
      const page = this.doc.pages[+el.dataset.index];
      const section = page && ['diagram', 'access', 'site', 'photos', 'chapters'].includes(page.kind) ? this.section(page.section) : null;
      const empty =
        !!section &&
        (section.type === 'wiring'
          ? !section.boxes.length
          : section.type === 'site'
            ? !section.symbols.length && !section.bg.image
            : section.type === 'photos'
              ? !section.items.length
              : section.type === 'chapters'
                ? !section.blocks.length
                : !section.devices.length && !section.wifi.length && !section.remote.length && !blockHasData(section, ACCESS_BLOCKS.find((b) => b.id === 'network')));
      let card = el.querySelector('.sd-start');
      if (!empty || (card && card.dataset.type !== section.type)) {
        if (card) card.remove();
        card = null;
        if (!empty) continue;
      }
      if (card) continue;
      if (section.type === 'chapters') {
        card = htmlToElement(
          `<div class="sd-start top" data-type="chapters"><b>Kapitel schreiben</b><span>Bausteine einfügen: Überschrift, Absatz, Handlungsschritte, Warnhinweis, Abbildung, Tabelle … Nummern, Verweise und Seitenumbrüche entstehen von selbst.</span><div><button class="btn primary" data-k="h">${icon('text', 's')}Überschrift</button><button class="btn outline" data-k="p">${icon('al', 's')}Absatz</button><button class="btn outline" data-k="steps">${icon('pnum', 's')}Schritte</button></div></div>`,
        );
        for (const b of card.querySelectorAll('button'))
          b.addEventListener('click', () => {
            this.select({ kind: 'section', id: section.id });
            this.addBlock(section, b.dataset.k);
          });
        for (const type of ['pointerdown', 'dblclick']) card.addEventListener(type, (ev) => ev.stopPropagation());
        el.appendChild(card);
        continue;
      }
      if (section.type === 'site' || section.type === 'photos') {
        const site = section.type === 'site';
        card = htmlToElement(
          `<div class="sd-start top" data-type="${section.type}"><b>${site ? 'Lageplan erstellen' : 'Fotodokumentation'}</b><span>${
            site
              ? 'Zuerst Luftbild, Karte oder Grundriss als Hintergrund laden (Bild oder Seite einer PDF), dann Melder, Kameras und Geräte setzen. Kameras zeigen ihren Erfassungsbereich.'
              : 'Fotos hinzufügen – das Aufnahmedatum wird gelesen. Je Seite 1, 2, 4 oder 6 Fotos, mit Bildunterschrift und Verknüpfung zu Geräten im Lageplan.'
          }</span><div>${
            site
              ? `<button class="btn primary" data-k="image">${icon('image', 's')}Bild wählen</button><button class="btn outline" data-k="pdf">${icon('file', 's')}Aus PDF-Seite</button>`
              : `<button class="btn primary" data-k="photos">${icon('image', 's')}Fotos hinzufügen</button>`
          }</div></div>`,
        );
        for (const b of card.querySelectorAll('button'))
          b.addEventListener('click', () => {
            this.select({ kind: 'section', id: section.id });
            if (b.dataset.k === 'image') this.pickBackground(section);
            else if (b.dataset.k === 'pdf') this.pickBackgroundPdf(section);
            else this.pickPhotos(section);
          });
        for (const type of ['pointerdown', 'dblclick']) card.addEventListener(type, (ev) => ev.stopPropagation());
        el.appendChild(card);
        continue;
      }
      if (section.type === 'access') {
        card = htmlToElement(
          `<div class="sd-start top" data-type="access"><b>Zugangsdaten erfassen</b><span>Geräte mit IP-Adresse und Anmeldung, WLAN und Fernzugriff eintragen. Was in die PDF kommt – Bereiche, Spalten, Passwörter –, wählst du rechts je Kunde.</span><div><button class="btn primary" data-k="device">${icon('device', 's')}Gerät</button><button class="btn outline" data-k="wifi">${icon('wifi', 's')}WLAN</button><button class="btn outline" data-k="remote">${icon('remote', 's')}Fernzugriff</button></div></div>`,
        );
        for (const b of card.querySelectorAll('button'))
          b.addEventListener('click', () => {
            this.select({ kind: 'section', id: section.id });
            this.addAccessItem(b.dataset.k);
          });
        for (const type of ['pointerdown', 'dblclick']) card.addEventListener(type, (ev) => ev.stopPropagation());
        el.appendChild(card);
        continue;
      }
      card = htmlToElement(
        `<div class="sd-start" data-type="wiring"><b>Anschlussplan aufbauen</b><span>Zuerst die Baugruppen anlegen (links, rechts oder unten), dann die Anschlüsse der Steuerung zuordnen – der Plan zeichnet sich selbst.</span><div><button class="btn primary">${icon('module', 's')}Baugruppe</button></div></div>`,
      );
      card.querySelector('button').addEventListener('click', () => {
        this.select({ kind: 'section', id: section.id });
        this.addBox();
      });
      for (const type of ['pointerdown', 'dblclick']) card.addEventListener(type, (ev) => ev.stopPropagation());
      el.appendChild(card);
    }
  }

  /** Markierung der Auswahl auf den Seiten. */
  renderSelection() {
    if (!this.doc || !this.root) return;
    const { kind, id, section } = this.sel;
    const pages = $$('.sd-page', $('#sdPages'));
    pages.forEach((el, i) => {
      const page = this.doc.pages[i];
      const marks = el.querySelector('.sd-marks');
      marks.innerHTML = '';
      const sectionSel =
        (kind === 'section' && page.section === id) || (kind === 'project' && page.kind === 'cover');
      el.classList.toggle('sd-cur', sectionSel);
      if (!page || page.section !== section) return;
      for (const hit of page.hits) {
        const match =
          (kind === 'box' && hit.kind === 'box' && hit.id === id) ||
          (kind === 'pin' && (hit.kind === 'pin' || hit.kind === 'conn') && hit.id === id) ||
          (kind === 'pin' && hit.kind === 'conn' && this.pinInConn(hit, id)) ||
          (kind === 'hint' && hit.kind === 'hint' && hit.id === id) ||
          ((kind === 'device' || kind === 'wifi' || kind === 'remote') && hit.kind === kind && hit.id === id) ||
          (kind === 'block' && hit.kind === 'block' && hit.id === id) ||
          (kind === 'sym' && hit.kind === 'sym' && hit.id === id) ||
          (kind === 'photo' && hit.kind === 'photo' && hit.id === id) ||
          (kind === 'hub' && hit.kind === 'hub');
        if (!match) continue;
        const mark = this.markEl(hit.rect, 'sd-sel');
        if (kind === 'box' && hit.kind === 'box') mark.appendChild(htmlToElement('<span class="sd-grip" title="Höhe ziehen"></span>'));
        marks.appendChild(mark);
      }
      // Griff am Ende des Erfassungsbereichs: ziehen ändert Blickrichtung und Reichweite
      if (kind === 'sym' && page.site) {
        const m = page.site.symbols.find((y) => y.id === id);
        if (m && m.tip) {
          const handle = htmlToElement('<span class="sd-handle" title="Blickrichtung und Reichweite ziehen"></span>');
          handle.style.left = m.tip[0] * this.scale + 'px';
          handle.style.top = m.tip[1] * this.scale + 'px';
          marks.appendChild(handle);
        }
      }
    });
  }

  pinInConn(hit, pinId) {
    const page = this.doc.pages.find((p) => p.layout && p.hits.includes(hit));
    const conn = page && page.layout.conns.find((c) => c.pins[0] === hit.id);
    return !!conn && conn.pins.includes(pinId);
  }

  markEl([x, y, w, h], cls) {
    const s = this.scale;
    const el = document.createElement('div');
    el.className = cls;
    el.style.cssText = `left:${x * s}px;top:${y * s}px;width:${w * s}px;height:${h * s}px`;
    return el;
  }

  reveal() {
    const mark = $('#sdPages .sd-sel') || $('#sdPages .sd-page.sd-cur');
    if (mark) mark.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /** Projektmappe links: Projekt und Abschnitte mit Miniatur der ersten Seite. */
  renderSide() {
    if (!this.root || !this.project) return;
    const proj = $('#sdProj');
    proj.querySelector('b').textContent = typesetter(this.project).inline(this.project.title) || 'Projekt';
    proj.querySelector('small').textContent = this.subtitle() || 'Projektangaben, Logo, Sprache';
    proj.classList.toggle('on', this.sel.kind === 'project');
    const list = $('#sdSecs');
    const sections = this.project.sections;
    const pagesOf = (id) => (this.doc ? this.doc.pages.map((p, i) => [p, i]).filter(([p]) => p.section === id) : []);
    sections.forEach((section, i) => {
      let li = list.children[i];
      if (!li || li.dataset.id !== section.id) {
        li = this.sectionItem(section);
        list.insertBefore(li, list.children[i] || null);
      }
      const pages = pagesOf(section.id);
      const first = pages[0];
      li.querySelector('b').textContent = sectionTitle(section, typesetter(this.project).lang);
      li.querySelector('small').textContent = !pages.length
        ? 'Noch leer'
        : pages.length === 1
          ? `Seite ${first[1] + 1}`
          : `Seite ${first[1] + 1}–${pages[pages.length - 1][1] + 1}`;
      li.setAttribute('aria-label', `${li.querySelector('b').textContent}, ${li.querySelector('small').textContent}`);
      const thumb = li.querySelector('.sd-thumb');
      const svg = first ? first[0].svg : '';
      if (thumb._svg !== svg) {
        thumb.innerHTML = svg;
        thumb._svg = svg;
      }
      const on = (this.sel.kind === 'section' && this.sel.id === section.id) || this.sel.section === section.id;
      li.classList.toggle('on', on);
    });
    while (list.children.length > sections.length) list.lastChild.remove();
    for (const li of [...list.children]) if (!sections.some((s) => s.id === li.dataset.id)) li.remove();
  }

  sectionItem(section) {
    const li = htmlToElement(
      `<li class="sd-sec" draggable="true" tabindex="0" data-id="${escapeHtml(section.id)}"><span class="sd-thumb" aria-hidden="true"></span><span class="tx"><b></b><small></small></span><button class="btn ic" title="Abschnitt-Optionen" aria-label="Abschnitt-Optionen">${icon('more', 's')}</button></li>`,
    );
    li.addEventListener('click', (ev) => {
      if (ev.target.closest('button')) return;
      this.select({ kind: 'section', id: section.id }, { reveal: true });
      const first = $(`#sdPages .sd-page[data-section="${CSS.escape(section.id)}"]`);
      if (first) $('#sdScroll').scrollTop = first.offsetTop - 24;
    });
    li.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter' || ev.key === ' ') {
        ev.preventDefault();
        li.click();
      }
    });
    li.querySelector('button').addEventListener('click', (ev) => this.sectionMenu(section.id, ev.currentTarget));
    li.addEventListener('dragstart', (ev) => {
      ev.dataTransfer.setData('text/x-pdfix-section', section.id);
      ev.dataTransfer.effectAllowed = 'move';
      li.classList.add('dragging');
    });
    li.addEventListener('dragend', () => li.classList.remove('dragging'));
    li.addEventListener('dragover', (ev) => {
      if (!ev.dataTransfer.types.includes('text/x-pdfix-section')) return;
      ev.preventDefault();
      ev.stopPropagation();
      const r = li.getBoundingClientRect();
      li.classList.toggle('drop-before', ev.clientY < r.top + r.height / 2);
      li.classList.toggle('drop-after', ev.clientY >= r.top + r.height / 2);
    });
    li.addEventListener('dragleave', () => li.classList.remove('drop-before', 'drop-after'));
    li.addEventListener('drop', (ev) => {
      const from = ev.dataTransfer.getData('text/x-pdfix-section');
      if (!from) return;
      ev.preventDefault();
      ev.stopPropagation();
      const after = li.classList.contains('drop-after');
      li.classList.remove('drop-before', 'drop-after');
      if (from === section.id) return;
      this.change('Abschnitt verschoben', (p) => {
        const moved = p.sections.find((s) => s.id === from);
        p.sections = p.sections.filter((s) => s.id !== from);
        const at = p.sections.findIndex((s) => s.id === section.id) + (after ? 1 : 0);
        p.sections.splice(at, 0, moved);
      });
    });
    return li;
  }

  sectionMenu(id, anchor) {
    const index = this.project.sections.findIndex((s) => s.id === id);
    const count = this.project.sections.length;
    showMenu(
      [
        { label: 'Nach oben', icon: 'up', disabled: index === 0, run: () => this.moveSection(id, -1) },
        { label: 'Nach unten', icon: 'down', disabled: index === count - 1, run: () => this.moveSection(id, 1) },
        {
          label: 'Duplizieren',
          icon: 'dup',
          disabled: ['cover', 'toc'].includes(this.section(id).type),
          run: () => this.duplicateSection(id),
        },
        '-',
        { label: 'Entfernen', icon: 'trash', run: () => this.removeSection(id) },
      ],
      anchor,
    );
  }

  moveSection(id, dir) {
    this.change('Abschnitt verschoben', (p) => {
      const i = p.sections.findIndex((s) => s.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= p.sections.length) return;
      [p.sections[i], p.sections[j]] = [p.sections[j], p.sections[i]];
    });
  }

  duplicateSection(id) {
    const copy = JSON.parse(JSON.stringify(this.section(id)));
    copy.id = uid('s');
    // eigene Kennungen für alle Einträge (sonst teilen Original und Kopie Verlaufsschritte)
    const remap = new Map();
    const fresh = (item, prefix) => {
      const next = uid(prefix);
      remap.set(item.id, next);
      item.id = next;
    };
    if (copy.type === 'wiring') {
      copy.boxes.forEach((b) => fresh(b, 'b'));
      for (const b of copy.boxes) if (b.parent) b.parent = remap.get(b.parent) || null;
      for (const p of copy.hub.pins) {
        fresh(p, 'p');
        if (p.box) p.box = remap.get(p.box) || null;
      }
      copy.hints.forEach((h) => fresh(h, 'h'));
    } else if (copy.type === 'access') {
      copy.devices.forEach((d) => fresh(d, 'd'));
      copy.wifi.forEach((w) => fresh(w, 'w'));
      copy.remote.forEach((r) => fresh(r, 'r'));
    } else if (copy.type === 'site') {
      copy.custom.forEach((c) => fresh(c, 'u'));
      copy.symbols.forEach((y) => {
        const to = y.kind.startsWith('custom:') && remap.get(y.kind.slice(7));
        fresh(y, 'y');
        if (to) y.kind = 'custom:' + to;
      });
    } else if (copy.type === 'photos') {
      copy.items.forEach((p) => fresh(p, 'f'));
    } else if (copy.type === 'chapters') {
      copy.blocks.forEach((b) => fresh(b, 'k'));
    }
    this.change(
      'Abschnitt dupliziert',
      (p) => p.sections.splice(p.sections.findIndex((s) => s.id === id) + 1, 0, copy),
      { inspector: true },
    );
    this.select({ kind: 'section', id: copy.id });
  }

  removeSection(id) {
    const s = this.section(id);
    if (!s) return;
    this.sel = { kind: 'project' };
    this.change(
      `${sectionTitle(s)} entfernt`,
      (p) => {
        p.sections = p.sections.filter((x) => x.id !== id);
        if (s.type === 'site') this.dropLinks(new Set(s.symbols.map((y) => y.id)));
      },
      { inspector: true },
    );
    this.checkArmed();
  }

  /** Fotos, die auf entfernte Symbole verweisen, lösen die Verknüpfung (im selben Verlaufsschritt). */
  dropLinks(ids) {
    for (const sec of this.project.sections)
      if (sec.type === 'photos') for (const p of sec.items) if (ids.has(p.link)) p.link = null;
  }

  /** Eigenes Symbol samt der damit gesetzten Symbole entfernen. */
  removeCustom(site, id) {
    const kind = 'custom:' + id;
    this.change(
      'Eigenes Symbol entfernt',
      () => {
        this.dropLinks(new Set(site.symbols.filter((y) => y.kind === kind).map((y) => y.id)));
        site.symbols = site.symbols.filter((y) => y.kind !== kind);
        site.custom = site.custom.filter((c) => c.id !== id);
        if (this.sel.kind === 'sym' && !this.selected()) this.sel = { kind: 'section', id: site.id };
      },
      { inspector: true },
    );
    this.checkArmed();
  }

  addSectionMenu(anchor) {
    const has = (type) => this.project.sections.some((s) => s.type === type);
    showMenu(
      [
        { label: 'Deckblatt', icon: 'fitp', disabled: has('cover'), run: () => this.addSection('cover') },
        { label: 'Inhaltsverzeichnis', icon: 'list', disabled: has('toc'), run: () => this.addSection('toc') },
        { label: 'Lageplan', icon: 'map', run: () => this.addSection('site') },
        { label: 'Anschlussplan', icon: 'wiring', run: () => this.addSection('wiring') },
        { label: 'Zugangsdaten', icon: 'key', run: () => this.addSection('access') },
        { label: 'Fotodokumentation', icon: 'camera', run: () => this.addSection('photos') },
        '-',
        { label: 'Bedienungsanleitung (Kapitel)', icon: 'edit', run: () => this.addSection('manual') },
        { label: 'Technische Beschreibung (Kapitel)', icon: 'edit', run: () => this.addSection('tech') },
      ],
      anchor,
    );
  }

  addSection(type) {
    const section =
      type === 'wiring'
        ? newWiring()
        : type === 'access'
          ? newAccess()
          : type === 'site'
            ? newSite()
            : type === 'photos'
              ? newPhotos()
              : type === 'manual' || type === 'tech'
                ? starterChapters(type)
                : { id: uid('s'), type };
    this.change(
      'Abschnitt hinzugefügt',
      (p) => {
        if (type === 'cover') p.sections.unshift(section);
        else if (type === 'toc') p.sections.splice(p.sections[0] && p.sections[0].type === 'cover' ? 1 : 0, 0, section);
        else {
          const at = p.sections.findIndex((s) => s.id === (this.sel.section || this.sel.id));
          p.sections.splice(at >= 0 ? at + 1 : p.sections.length, 0, section);
        }
      },
      { inspector: true },
    );
    this.select({ kind: 'section', id: section.id }, { reveal: true });
  }

  /* ---------- Anlegen im Anschlussplan ---------- */

  addBox(side = 'left') {
    const s = this.wiringSection() || this.ensureWiring();
    const parentBox = this.sel.kind === 'box' && this.sel.section === s.id ? s.boxes.find((b) => b.id === this.sel.id) : null;
    const box = newBox(parentBox ? parentBox.cat : 'sig', parentBox && parentBox.side !== 'bottom' ? parentBox.side : side);
    box.title = { de: 'Neue Baugruppe', en: 'New module' };
    this.change('Baugruppe hinzugefügt', () => s.boxes.push(box));
    this.select({ kind: 'box', id: box.id, section: s.id }, { reveal: true });
    this.inspector.focusFirst();
  }

  addPin(boxId = null) {
    const s = this.wiringSection() || this.ensureWiring();
    const box = boxId || (this.sel.kind === 'box' && this.sel.section === s.id ? this.sel.id : null);
    const pin = newPin(nextPinName(s.hub.pins), box);
    this.change('Anschluss hinzugefügt', () => s.hub.pins.push(pin));
    this.select({ kind: 'pin', id: pin.id, section: s.id }, { reveal: true });
    this.inspector.focusFirst();
  }

  addHint() {
    const s = this.wiringSection() || this.ensureWiring();
    const hint = newHint(s.categories[0] ? s.categories[0].id : 'sig');
    hint.title = { de: 'Hinweis', en: 'Note' };
    this.change('Hinweis hinzugefügt', () => s.hints.push(hint));
    this.select({ kind: 'hint', id: hint.id, section: s.id }, { reveal: true });
    this.inspector.focusFirst();
  }

  ensureWiring() {
    const section = newWiring();
    this.change('Anschlussplan hinzugefügt', (p) => p.sections.push(section));
    return section;
  }

  /** Gewähltes Element löschen (Entf). */
  removeSelected() {
    const { kind, id, section } = this.sel;
    const s = this.section(section);
    if (kind === 'section') return this.removeSection(id);
    if (!s) return;
    if (kind === 'box') {
      this.sel = { kind: 'section', id: section };
      this.change(
        'Baugruppe gelöscht',
        () => {
          s.boxes = s.boxes.filter((b) => b.id !== id);
          for (const b of s.boxes) if (b.parent === id) b.parent = null;
          for (const p of s.hub.pins) if (p.box === id) p.box = null;
        },
        { inspector: true },
      );
    } else if (kind === 'pin') {
      this.sel = { kind: 'section', id: section };
      this.change('Anschluss gelöscht', () => (s.hub.pins = s.hub.pins.filter((p) => p.id !== id)), { inspector: true });
    } else if (kind === 'hint') {
      this.sel = { kind: 'section', id: section };
      this.change('Hinweis gelöscht', () => (s.hints = s.hints.filter((h) => h.id !== id)), { inspector: true });
    } else if (kind === 'block') {
      this.sel = { kind: 'section', id: section };
      this.change('Baustein gelöscht', () => (s.blocks = s.blocks.filter((b) => b.id !== id)), { inspector: true });
    } else if (kind === 'sym') {
      this.sel = { kind: 'section', id: section };
      this.change(
        'Symbol gelöscht',
        () => {
          s.symbols = s.symbols.filter((y) => y.id !== id);
          this.dropLinks(new Set([id]));
        },
        { inspector: true },
      );
    } else if (kind === 'photo') {
      this.sel = { kind: 'section', id: section };
      this.change('Foto entfernt', () => (s.items = s.items.filter((p) => p.id !== id)), { inspector: true });
    } else if (kind === 'device' || kind === 'wifi' || kind === 'remote') {
      const list = kind === 'device' ? 'devices' : kind;
      this.sel = { kind: 'section', id: section };
      this.change('Eintrag gelöscht', () => (s[list] = s[list].filter((x) => x.id !== id)), { inspector: true });
    }
    this.renderSelection();
  }

  /* ---------- Firmenlogo ---------- */

  async pickLogo() {
    const file = await pickFiles('image/png,image/jpeg,image/svg+xml,image/webp');
    if (file) await this.setLogo(file);
  }

  async setLogo(file) {
    try {
      const image = await readImage(file);
      const id = uid('img');
      this.project.images[id] = image;
      this.change('Logo eingesetzt', (p) => (p.company.logo = id), { inspector: true });
    } catch {
      toast('Das Bild konnte nicht gelesen werden (PNG, JPG oder SVG).', 'err', 5000);
    }
  }

  /** Passwörter/Schlüssel eines Zugangsdaten-Abschnitts in der PDF zeigen oder ausblenden. */
  toggleSecrets(section) {
    this.change(
      section.showPasswords ? 'Passwörter ausgeblendet' : 'Passwörter sichtbar',
      () => (section.showPasswords = !section.showPasswords),
      { inspector: true },
    );
    this.app.renderRibbon();
  }

  /* ---------- Sprache und Schrift ---------- */

  setLang(lang) {
    this.change('Sprache geändert', (p) => (p.lang = lang), { inspector: true });
    this.app.renderRibbon();
  }

  async setFont(font) {
    if (font === 'barlow') await ensureBarlow().catch(() => toast('Barlow konnte nicht geladen werden.', 'err'));
    this.change('Schrift geändert', (p) => (p.font = font), { inspector: true });
    this.app.renderRibbon();
  }

  /* ---------- Werkzeugband ---------- */

  /**
   * Werkzeugband: „Abschnitt“ und die Befehle des gewählten Abschnitts. Einstellungen des Dokuments
   * (Sprache, Schrift, Logo) stehen in den Eigenschaften des Projekts – nicht doppelt hier.
   */
  renderRibbon(bar) {
    if (!this.project) return;
    const hasWiring = this.project.sections.some((s) => s.type === 'wiring');
    this.ribbonType = this.currentType();
    const access = this.ribbonType === 'access' ? this.section(this.sel.section || this.sel.id) : null;
    const siteSection = this.ribbonType === 'site' ? this.section(this.sel.section || this.sel.id) : null;
    const photosSection = this.ribbonType === 'photos' ? this.section(this.sel.section || this.sel.id) : null;
    const chaptersSection = this.ribbonType === 'chapters' ? this.section(this.sel.section || this.sel.id) : null;
    const context = chaptersSection
      ? `<button class="rb c1" data-act="block" title="Baustein einfügen">${icon('plus')}Baustein${icon('chev', 's caret')}</button>
<button class="rb c5" data-act="replace" title="Suchen und Ersetzen (Strg+H)">${icon('replace')}Ersetzen</button>`
      : siteSection
      ? `<button class="rb c1${this.armed ? ' on' : ''}" data-act="symbols" title="Symbol wählen und im Plan setzen">${icon('map')}Symbol${icon('chev', 's caret')}</button>
<button class="rb c3" data-act="bg" title="Hintergrund: Luftbild, Karte oder Grundriss">${icon('image')}Hintergrund${icon('chev', 's caret')}</button>`
      : photosSection
        ? `<button class="rb c3" data-act="addphotos" title="Fotos hinzufügen (Aufnahmedatum wird gelesen)">${icon('image')}Fotos hinzufügen</button>`
        : access
      ? `<button class="rb c1" data-act="device" title="Gerät mit Zugang hinzufügen">${icon('device')}Gerät</button>
<button class="rb c6" data-act="wifi" title="WLAN hinzufügen">${icon('wifi')}WLAN</button>
<button class="rb c2" data-act="remote" title="Fernzugriff hinzufügen (DDNS, Cloud, Portfreigabe)">${icon('remote')}Fernzugriff</button>
<button class="rb c4${access.showPasswords ? ' on' : ''}" data-act="secrets" aria-pressed="${!!access.showPasswords}" title="Passwörter und Schlüssel in der PDF zeigen">${icon('key')}Passwörter ${access.showPasswords ? 'sichtbar' : 'ausgeblendet'}</button>`
      : this.ribbonType === 'wiring' || this.onlyWiring()
      ? `<button class="rb c1" data-act="box" title="Baugruppe zum Anschlussplan hinzufügen">${icon('module')}Baugruppe</button>
<button class="rb c2" data-act="pin" title="Anschluss der Steuerung hinzufügen"${hasWiring ? '' : ' disabled'}>${icon('plug')}Anschluss</button>
<button class="rb c5" data-act="hint" title="Hinweis zur Verdrahtung hinzufügen"${hasWiring ? '' : ' disabled'}>${icon('bulb')}Hinweis</button>`
      : `<span class="rb-note">Abschnitt in der Projektmappe wählen – hier erscheinen seine Befehle.</span>`;
    bar.innerHTML = `
<button class="rb c6" data-act="section">${icon('plus')}Abschnitt${icon('chev', 's caret')}</button>
<span class="rb-sep"></span>
${context}
`;
    for (const btn of $$('.rb', bar))
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'section') this.addSectionMenu(btn);
        else if (act === 'box') this.addBox();
        else if (act === 'pin') this.addPin();
        else if (act === 'hint') this.addHint();
        else if (act === 'device' || act === 'wifi' || act === 'remote') this.addAccessItem(act);
        else if (act === 'secrets') this.toggleSecrets(access);
        else if (act === 'block') this.blockMenu(btn, chaptersSection);
        else if (act === 'replace') this.replaceDialog();
        else if (act === 'symbols') this.symbolMenu(btn, siteSection);
        else if (act === 'bg') this.backgroundMenu(btn, siteSection);
        else if (act === 'addphotos') this.pickPhotos(photosSection);
      });
  }

  /** Nur ein Anschlussplan und sonst nichts (Vorlage „Anschlussplan“): seine Befehle sind immer da. */
  onlyWiring() {
    const content = this.project.sections.filter((s) => s.type !== 'cover' && s.type !== 'toc');
    return content.length === 1 && content[0].type === 'wiring';
  }

  /* ---------- Zeiger: Auswahl, Verschieben, Höhe, Leitungen ---------- */

  /** Seite und Bereich unter dem Zeiger: { page, el, item, x, y } (pt) oder null. */
  hitAt(ev) {
    const el = ev.target.closest && ev.target.closest('.sd-page');
    if (!el || !this.doc) return null;
    const page = this.doc.pages[+el.dataset.index];
    if (!page) return null;
    const r = el.getBoundingClientRect();
    const x = ((ev.clientX - r.left) / r.width) * PAGE.w;
    const y = ((ev.clientY - r.top) / r.height) * PAGE.h;
    let item = null;
    for (let i = page.hits.length - 1; i >= 0; i--) {
      const [hx, hy, hw, hh] = page.hits[i].rect;
      const pad = page.hits[i].kind === 'box' ? 3 : 0;
      if (x >= hx - pad && x <= hx + hw + pad && y >= hy - pad && y <= hy + hh + pad) {
        item = page.hits[i];
        break;
      }
    }
    return { page, el, item, x, y };
  }

  hover(hit) {
    const old = $('#sdPages .sd-hov');
    if (old) old.remove();
    if (!hit || !hit.item || this.drag) return;
    const mark = this.markEl(hit.item.rect, 'sd-hov');
    hit.el.querySelector('.sd-marks').appendChild(mark);
  }

  /** Art des Ziehens an dieser Stelle (Verschieben, Höhe, Leitungen) – für Zeiger und Start. */
  dragMode(hit) {
    if (!hit || !hit.item || !hit.page.layout) return null;
    const { kind, rect } = hit.item;
    if (kind === 'box') {
      const bottom = rect[1] + rect[3];
      return hit.y > bottom - 5 ? 'resize' : 'move';
    }
    if (kind === 'conn') return 'pins';
    return null;
  }

  onPointerMove(ev) {
    if (this.drag) return this.dragMove(ev);
    const hit = this.hitAt(ev);
    this.hover(hit);
    if (this.armed) {
      $('#sdScroll').style.cursor = hit && hit.page.site && inArea(hit, hit.page.site.area) ? 'crosshair' : '';
      return;
    }
    const mode = this.dragMode(hit);
    $('#sdScroll').style.cursor = mode === 'resize' || mode === 'pins' ? 'ns-resize' : mode === 'move' ? 'grab' : hit && hit.item ? 'pointer' : '';
  }

  onPointerDown(ev) {
    if (ev.button !== 0) return;
    const hit = this.hitAt(ev);
    if (!hit) return;
    const { page, item } = hit;
    const section = page.section;
    // Erfassungsbereich: Griff ziehen
    if (ev.target.classList && ev.target.classList.contains('sd-handle') && this.sel.kind === 'sym') return this.startSymbolDrag(ev, hit, 'fov');
    // Symbol setzen (Platzieren ist aktiv)
    if (this.armed && page.site && inArea(hit, page.site.area)) {
      ev.preventDefault();
      return this.placeSymbol(hit);
    }
    if (item && item.kind === 'sym' && page.site) {
      this.select({ kind: 'sym', id: item.id, section });
      return this.startSymbolDrag(ev, hit, 'move');
    }
    if (!item) {
      this.select(page.kind === 'cover' ? { kind: 'project' } : { kind: 'section', id: section });
      return;
    }
    if (item.kind === 'box') this.select({ kind: 'box', id: item.id, section });
    else if (item.kind === 'conn') this.select({ kind: 'box', id: item.box, section });
    else if (item.kind === 'pin') this.select({ kind: 'pin', id: item.id, section });
    else if (item.kind === 'hint') this.select({ kind: 'hint', id: item.id, section });
    else if (item.kind === 'hub') this.select({ kind: 'hub', section });
    else if (item.kind === 'device' || item.kind === 'wifi' || item.kind === 'remote')
      this.select({ kind: item.kind, id: item.id, section });
    else if (item.kind === 'sym' || item.kind === 'photo' || item.kind === 'block') this.select({ kind: item.kind, id: item.id, section });
    else if (item.kind === 'section') this.select({ kind: 'section', id: item.id }, { reveal: true });
    else if (item.kind === 'project') this.select({ kind: 'project' });
    else this.select({ kind: 'section', id: section });
    const mode = this.dragMode(hit);
    if (!mode) return;
    const s = this.section(section);
    const boxId = item.kind === 'conn' ? item.box : item.id;
    const box = s.boxes.find((b) => b.id === boxId);
    const laid = page.layout.boxes.find((b) => b.id === boxId);
    const conn = page.layout.conns.find((c) => c.box === boxId);
    if (!box || !laid) return;
    ev.preventDefault();
    hit.el.setPointerCapture(ev.pointerId);
    this.drag = {
      mode,
      box,
      section: s,
      el: hit.el,
      startX: ev.clientX,
      startY: ev.clientY,
      before: this.snap,
      scale: page.layout.scale,
      y: laid.y - DIAGRAM.top,
      h: laid.h,
      pinY: conn ? conn.y - laid.y : 0,
      moved: false,
    };
    $('#sdScroll').classList.add('dragging');
  }

  dragMove(ev) {
    const d = this.drag;
    if (d.site) return this.siteDragMove(ev);
    const perPt = this.scale * d.scale;
    const dy = (ev.clientY - d.startY) / perPt;
    const dx = (ev.clientX - d.startX) / perPt;
    if (!d.moved && Math.hypot(dx, dy) < 2) return;
    d.moved = true;
    const box = d.box;
    if (d.mode === 'move') {
      box.y = Math.max(0, Math.round(d.y + dy));
      if (box.side !== 'bottom' && !box.parent) {
        const r = d.el.getBoundingClientRect();
        const x = ((ev.clientX - r.left) / r.width) * PAGE.w;
        if (x < PAGE.w / 2 - 70) box.side = 'left';
        else if (x > PAGE.w / 2 + 70) box.side = 'right';
      }
    } else if (d.mode === 'resize') box.h = Math.max(20, Math.round(d.h + dy));
    else if (d.mode === 'pins') box.pinY = Math.max(4, Math.min(d.h - 4, Math.round(d.pinY + dy)));
    this.schedule();
  }

  onPointerUp(ev, cancel = false) {
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    $('#sdScroll').classList.remove('dragging');
    if (d.el.hasPointerCapture(ev.pointerId)) d.el.releasePointerCapture(ev.pointerId);
    if (!d.moved) return;
    if (cancel) return this.restore(d.before);
    const label = {
      move: 'Baugruppe verschoben',
      resize: 'Höhe geändert',
      pins: 'Leitungen verschoben',
      sym: 'Symbol verschoben',
      fov: 'Erfassungsbereich geändert',
    }[d.mode];
    this.commit(label, d.before);
    this.inspector.render();
  }

  /* ---------- Lageplan: Symbole setzen und ziehen ---------- */

  /** Platzieren ein-/ausschalten: `kind` = Symbolart (oder null). */
  arm(kind) {
    this.armed = this.armed === kind ? null : kind;
    this.updateArmHint();
    this.app.renderRibbon();
    if (this.inspector && this.visible) this.inspector.render();
  }

  updateArmHint() {
    let chip = $('#sdArm');
    if (!this.armed) return chip && chip.remove();
    const info = this.armedInfo();
    if (!chip) {
      chip = htmlToElement(`<div class="sd-armed" id="sdArm" role="status"><span></span><button class="btn ic" title="Beenden (Esc)">${icon('x', 's')}</button></div>`);
      chip.querySelector('button').addEventListener('click', () => this.arm(this.armed));
      $('.sd-center').appendChild(chip);
    }
    chip.querySelector('span').textContent = `Klicke in den Plan, um „${info ? tx(info.name) : 'Symbol'}“ zu setzen`;
  }

  /** Angaben zur Symbolart, die gerade gesetzt wird (null, wenn es sie nicht mehr gibt). */
  armedInfo() {
    if (!this.armed || !this.project) return null;
    for (const s of this.project.sections) {
      const info = s.type === 'site' && symbolInfo(s, this.armed);
      if (info) return info;
    }
    return null;
  }

  /** Platzieren beenden, wenn die Symbolart verschwunden ist (z. B. nach Rückgängig). */
  checkArmed() {
    if (!this.armed || this.armedInfo()) return;
    this.armed = null;
    this.updateArmHint();
  }

  /** Lageplan-Abschnitt, in den gesetzt wird: der gewählte, sonst der erste. */
  wiringSite() {
    const id = this.sel.section || (this.sel.kind === 'section' ? this.sel.id : null);
    const s = id && this.section(id);
    return s && s.type === 'site' ? s : this.project.sections.find((x) => x.type === 'site') || null;
  }

  placeSymbol(hit) {
    const s = this.section(hit.page.section);
    if (!s || s.type !== 'site' || !this.armed) return;
    if (!symbolInfo(s, this.armed)) return toast('Dieses eigene Symbol gehört zu einem anderen Lageplan.', 'warn', 4000);
    const a = hit.page.site.area;
    const sym = newSymbol(this.armed, Math.max(0, Math.min(1, (hit.x - a.x) / a.w)), Math.max(0, Math.min(1, (hit.y - a.y) / a.h)));
    this.change('Symbol gesetzt', () => s.symbols.push(sym));
    this.select({ kind: 'sym', id: sym.id, section: s.id });
  }

  startSymbolDrag(ev, hit, mode) {
    const s = this.section(hit.page.section);
    const sym = s.symbols.find((y) => y.id === this.sel.id);
    const m = hit.page.site.symbols.find((y) => y.id === this.sel.id);
    if (!sym || !m) return;
    ev.preventDefault();
    hit.el.setPointerCapture(ev.pointerId);
    this.drag = {
      site: true,
      mode: mode === 'move' ? 'sym' : 'fov',
      sym,
      area: hit.page.site.area,
      center: [m.x, m.y],
      grab: [hit.x - m.x, hit.y - m.y],
      el: hit.el,
      startX: ev.clientX,
      startY: ev.clientY,
      before: this.snap,
      moved: false,
    };
    $('#sdScroll').classList.add('dragging');
  }

  siteDragMove(ev) {
    const d = this.drag;
    if (!d.moved && Math.hypot(ev.clientX - d.startX, ev.clientY - d.startY) < 3) return;
    d.moved = true;
    const r = d.el.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * PAGE.w;
    const py = ((ev.clientY - r.top) / r.height) * PAGE.h;
    const sym = d.sym;
    if (d.mode === 'sym') {
      sym.x = Math.max(0, Math.min(1, (px - d.grab[0] - d.area.x) / d.area.w));
      sym.y = Math.max(0, Math.min(1, (py - d.grab[1] - d.area.y) / d.area.h));
    } else {
      const dx = px - d.center[0];
      const dy = py - d.center[1];
      let dir = (Math.atan2(dx, -dy) * 180) / Math.PI;
      if (ev.shiftKey) dir = Math.round(dir / 15) * 15;
      sym.dir = Math.round(((dir % 360) + 360) % 360);
      sym.range = Math.max(10, Math.min(600, Math.round(Math.hypot(dx, dy))));
    }
    this.schedule();
  }

  /* ---------- Lageplan: Hintergrund, eigene Symbole ---------- */

  /** Galerie der Symbole (wie „Formen“ in Office): wählen, dann in den Plan klicken. */
  symbolMenu(anchor, site) {
    if (!site) return;
    const kinds = [...SYMBOLS.map((k) => k.id), ...site.custom.map((c) => 'custom:' + c.id)];
    const el = htmlToElement(
      `<div class="menu sd-gallery" role="dialog" aria-label="Symbol wählen"><div class="sd-symbols"></div><hr><button type="button" class="mi" data-custom>${icon('plus', 's')}<span>Eigenes Symbol hochladen …</span></button></div>`,
    );
    const grid = el.querySelector('.sd-symbols');
    for (const kind of kinds) {
      const info = symbolInfo(site, kind);
      const on = this.armed === kind;
      const b = htmlToElement(
        `<button type="button" class="sd-symbol${on ? ' on' : ''}" aria-pressed="${on}" title="${escapeHtml(tx(info.name, 'de'))}">${symbolIconSvg(info, this.project.images, 22)}<span>${escapeHtml(tx(info.name, 'de'))}</span></button>`,
      );
      b.addEventListener('click', () => {
        closeMenu();
        this.arm(kind);
      });
      grid.appendChild(b);
    }
    el.querySelector('[data-custom]').addEventListener('click', () => {
      closeMenu();
      this.addCustomSymbol(site);
    });
    showPopover(el, anchor);
  }

  backgroundMenu(anchor, site) {
    if (!site) return;
    showMenu(
      [
        { label: 'Bild wählen …', icon: 'image', run: () => this.pickBackground(site) },
        { label: 'Aus PDF-Seite …', icon: 'file', run: () => this.pickBackgroundPdf(site) },
        '-',
        { label: 'Entfernen', icon: 'trash', disabled: !site.bg.image, run: () => this.change('Hintergrund entfernt', () => (site.bg.image = null), { inspector: true }) },
      ],
      anchor,
    );
  }

  setBackground(site, image) {
    const id = uid('img');
    this.project.images[id] = image;
    this.change('Hintergrund gesetzt', () => (site.bg.image = id), { inspector: true });
  }

  async pickBackground(site, file = null) {
    file ||= await pickFiles('image/png,image/jpeg,image/webp');
    if (!file) return;
    try {
      this.setBackground(site, await withBusy(() => readImage(file, { max: 2400, jpeg: true })));
    } catch {
      toast('Das Bild konnte nicht gelesen werden.', 'err', 5000);
    }
  }

  /** Eine Seite einer PDF (Grundriss, Lageplan der Bauzeichnung) als Hintergrund. */
  async pickBackgroundPdf(site) {
    const file = await pickFiles('.pdf,application/pdf');
    if (!file) return;
    const renderer = new PdfRenderer();
    try {
      await withBusy(async () => renderer.load(new Uint8Array(await file.arrayBuffer())), 100);
      let index = 0;
      const count = renderer.doc.numPages;
      if (count > 1) {
        // Auswahl außerhalb der Warteanzeige (sonst läge sie über dem Dialog)
        const body = htmlToElement(
          `<label class="dlg-row">Seite (1–${count}) <input class="fld" type="number" min="1" max="${count}" value="1" style="width:80px"></label>`,
        );
        const choice = await showDialog({
          title: 'Seite der PDF wählen',
          icon: 'file',
          body,
          buttons: [
            { label: 'Abbrechen', value: null },
            { label: 'Übernehmen', primary: true, value: (b) => Number(b.querySelector('input').value) },
          ],
        });
        if (!choice) return;
        index = Math.max(1, Math.min(count, Math.round(choice))) - 1;
      }
      await withBusy(async () => {
        const page = await renderer.doc.getPage(index + 1);
        const vp = page.getViewport({ scale: 1 });
        const scale = 2400 / Math.max(vp.width, vp.height);
        const canvas = document.createElement('canvas');
        await renderer.render(index, canvas, scale, { dpr: 1, maxPx: 8e6 });
        const flat = document.createElement('canvas');
        flat.width = canvas.width;
        flat.height = canvas.height;
        const g = flat.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, flat.width, flat.height);
        g.drawImage(canvas, 0, 0);
        this.setBackground(site, { mime: 'image/jpeg', data: flat.toDataURL('image/jpeg', 0.9), w: flat.width, h: flat.height });
      }, 100);
    } catch (err) {
      console.warn('PDF als Hintergrund', err);
      toast('Die PDF konnte nicht gelesen werden.', 'err', 5000);
    } finally {
      renderer.destroy();
    }
  }

  /** Eigenes Symbol: Bild hochladen, benennen, danach direkt setzen. */
  async addCustomSymbol(site) {
    if (!site) return;
    const file = await pickFiles('image/png,image/jpeg,image/svg+xml,image/webp');
    if (!file) return;
    let image;
    try {
      image = await readImage(file, { max: 256 });
    } catch {
      return toast('Das Bild konnte nicht gelesen werden.', 'err', 5000);
    }
    const body = htmlToElement(`<label class="dlg-row">Name <input class="fld" type="text" value="${escapeHtml(file.name.replace(/\.[^.]+$/, ''))}" style="width:220px"></label>`);
    const name = await showDialog({
      title: 'Eigenes Symbol',
      icon: 'plus',
      body,
      buttons: [
        { label: 'Abbrechen', value: null },
        { label: 'Hinzufügen', primary: true, value: (b) => b.querySelector('input').value.trim() || 'Eigenes Symbol' },
      ],
    });
    if (!name) return;
    const imgId = uid('img');
    this.project.images[imgId] = image;
    const custom = newCustomSymbol(imgId);
    custom.name = { de: name, en: name };
    this.change('Eigenes Symbol hinzugefügt', () => site.custom.push(custom), { inspector: true });
    this.arm('custom:' + custom.id);
  }

  /* ---------- Anleitung: Bausteine, Bilder, Suchen und Ersetzen ---------- */

  blockMenu(anchor, section) {
    if (!section) return;
    const items = BLOCK_TYPES.map((t) => ({ label: t.label, icon: t.icon, run: () => this.addBlock(section, t.id) }));
    showMenu([...items.slice(0, 7), '-', ...items.slice(7)], anchor);
  }

  /** Baustein hinter dem gewählten (sonst am Ende) einfügen. */
  addBlock(section, type) {
    const block = newBlock(type);
    const at = this.sel.kind === 'block' && this.sel.section === section.id ? section.blocks.findIndex((b) => b.id === this.sel.id) + 1 : section.blocks.length;
    this.change('Baustein eingefügt', () => section.blocks.splice(at, 0, block));
    this.select({ kind: 'block', id: block.id, section: section.id }, { reveal: true });
    this.inspector.focusFirst();
  }

  async pickBlockImage(block, file = null) {
    file ||= await pickFiles('image/png,image/jpeg,image/webp');
    if (!file) return;
    try {
      const image = await withBusy(() => readImage(file, { max: 1800, jpeg: file.type !== 'image/png' }));
      const id = uid('img');
      this.project.images[id] = image;
      this.change('Abbildung eingesetzt', () => (block.image = id), { inspector: true });
    } catch {
      toast('Das Bild konnte nicht gelesen werden.', 'err', 5000);
    }
  }

  /** Alle Texte der Kapitel: [{ get, set }] (zweisprachige Texte, Tabellenzellen, Code, Formeln). */
  textSlots() {
    const out = [];
    const field = (obj, key) => out.push({ get: () => obj[key], set: (v) => (obj[key] = v) });
    const bi = (obj, key) => {
      if (obj[key] && typeof obj[key] === 'object') {
        field(obj[key], 'de');
        field(obj[key], 'en');
      }
    };
    for (const s of this.project.sections) {
      if (s.type !== 'chapters') continue;
      bi(s, 'title');
      for (const b of s.blocks) {
        for (const key of ['text', 'title', 'caption']) {
          if (typeof b[key] === 'string') field(b, key);
          else bi(b, key);
        }
        if (b.type === 'table') {
          b.head.forEach((_, i) => field(b.head, i));
          b.rows.forEach((r) => r.forEach((_, i) => field(r, i)));
        }
      }
    }
    return out;
  }

  /** Ersetzt in allen Kapiteln; liefert die Zahl der Ersetzungen (ohne Ändern, wenn `dry`). */
  replaceAll(find, replacement, { matchCase = false, dry = false } = {}) {
    if (!find) return 0;
    const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), matchCase ? 'g' : 'gi');
    let count = 0;
    const run = () => {
      for (const slot of this.textSlots()) {
        const value = slot.get();
        if (typeof value !== 'string') continue;
        const next = value.replace(re, () => (count++, replacement));
        if (!dry && next !== value) slot.set(next);
      }
    };
    if (dry) run();
    else this.change('Ersetzt', run, { inspector: true });
    return count;
  }

  async replaceDialog() {
    if (!this.project) return;
    const body = htmlToElement(`<div class="sd-find">
<label class="dlg-row">Suchen <input class="fld" data-k="find" type="text" autocomplete="off"></label>
<label class="dlg-row">Ersetzen durch <input class="fld" data-k="repl" type="text" autocomplete="off"></label>
<label class="dlg-row ck"><input type="checkbox" data-k="case"> Groß-/Kleinschreibung beachten</label>
<p class="sd-find-n" aria-live="polite"> </p></div>`);
    const find = body.querySelector('[data-k=find]');
    const repl = body.querySelector('[data-k=repl]');
    const matchCase = body.querySelector('[data-k=case]');
    const info = body.querySelector('.sd-find-n');
    const update = () => {
      const n = this.replaceAll(find.value, repl.value, { matchCase: matchCase.checked, dry: true });
      info.textContent = find.value ? `${n} Treffer in den Kapiteln` : ' ';
    };
    for (const el of [find, repl, matchCase]) el.addEventListener('input', update);
    setTimeout(() => find.focus(), 0);
    const ok = await showDialog({
      title: 'Suchen und Ersetzen',
      icon: 'replace',
      body,
      buttons: [
        { label: 'Abbrechen', value: false },
        { label: 'Alle ersetzen', primary: true, value: true },
      ],
    });
    if (!ok || !find.value) return;
    const n = this.replaceAll(find.value, repl.value, { matchCase: matchCase.checked });
    toast(n ? `${n} Stelle${n === 1 ? '' : 'n'} ersetzt` : 'Nichts gefunden');
  }

  /* ---------- Fotos ---------- */

  async pickPhotos(section) {
    const files = await pickFiles('image/jpeg,image/png,image/webp', true);
    if (files && files.length) await this.addPhotos(section, files);
  }

  async addPhotos(section, files) {
    if (!section) return;
    const items = [];
    await withBusy(async () => {
      for (const file of files) {
        try {
          const [image, date] = await Promise.all([readImage(file, { max: 2000, jpeg: true }), photoDate(file)]);
          const id = uid('img');
          this.project.images[id] = image;
          items.push(newPhoto(id, date));
        } catch {
          toast(`„${file.name}“ konnte nicht gelesen werden.`, 'warn', 4000);
        }
      }
    }, 100);
    if (!items.length) return;
    this.change(items.length === 1 ? 'Foto hinzugefügt' : 'Fotos hinzugefügt', () => section.items.push(...items), { inspector: true });
    this.select({ kind: 'photo', id: items[0].id, section: section.id }, { reveal: true });
  }

  /** Bilder aus Drag & Drop: auf Fotodokumentation → Fotos, auf Lageplan → Hintergrund. */
  async dropImages(files) {
    const id = this.sel.section || (this.sel.kind === 'section' ? this.sel.id : null);
    const section = id && this.section(id);
    if (section && section.type === 'photos') return this.addPhotos(section, files);
    if (section && section.type === 'chapters') {
      const block = this.sel.kind === 'block' ? section.blocks.find((b) => b.id === this.sel.id) : null;
      if (block && (block.type === 'figure' || block.type === 'figsteps')) return this.pickBlockImage(block, files[0]);
      const fig = newBlock('figure');
      this.change('Abbildung eingefügt', () => section.blocks.push(fig));
      this.select({ kind: 'block', id: fig.id, section: section.id });
      return this.pickBlockImage(fig, files[0]);
    }
    if (section && section.type === 'site') return this.pickBackground(section, files[0]);
    toast('Bilder auf einen Lageplan (Hintergrund), die Fotodokumentation oder das Feld „Logo“ ziehen.');
  }

  /* ---------- Tastatur ---------- */

  onKey(ev, inField) {
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key.toLowerCase();
    if (mod && key === 's') {
      ev.preventDefault();
      this.exportPdf();
    } else if (mod && key === 'h') {
      ev.preventDefault();
      this.replaceDialog();
    } else if (mod && key === 'p') {
      ev.preventDefault();
      this.print();
    } else if (document.querySelector('.backdrop')) {
      // Dialog offen: nichts weiter
    } else if (mod && !inField && key === 'z' && !ev.shiftKey) {
      ev.preventDefault();
      this.undo();
    } else if (mod && !inField && (key === 'y' || (key === 'z' && ev.shiftKey))) {
      ev.preventDefault();
      this.redo();
    } else if (mod && (key === '+' || key === '=')) {
      ev.preventDefault();
      this.zoomStep(1);
    } else if (mod && key === '-') {
      ev.preventDefault();
      this.zoomStep(-1);
    } else if (mod && key === '0') {
      ev.preventDefault();
      this.setZoom(null);
    } else if (!inField && !mod && (key === 'delete' || key === 'backspace') && this.sel.kind !== 'project') {
      ev.preventDefault();
      this.removeSelected();
    } else if (!inField && key === 'escape' && this.armed) {
      this.arm(this.armed);
    } else if (!inField && key === 'escape') {
      const { kind, section } = this.sel;
      if (section && kind !== 'section') this.select({ kind: 'section', id: section });
    } else if (!inField && this.sel.kind === 'box' && (key === 'arrowup' || key === 'arrowdown')) {
      ev.preventDefault();
      const s = this.section(this.sel.section);
      const page = this.doc.pages.find((p) => p.layout && p.section === s.id);
      const laid = page && page.layout.boxes.find((b) => b.id === this.sel.id);
      if (!laid) return;
      const step = (ev.shiftKey ? 10 : 1) * (key === 'arrowup' ? -1 : 1);
      this.change(
        'Baugruppe verschoben',
        () => {
          const box = s.boxes.find((b) => b.id === this.sel.id);
          box.y = Math.max(0, Math.round(laid.y - DIAGRAM.top + step));
        },
        { key: 'nudge:' + this.sel.id },
      );
    }
  }

  /* ---------- PDF erstellen, drucken ---------- */

  fileName() {
    return (documentLabel(this.project) || 'Dokumentation').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim() + '.pdf';
  }

  /** Enthalten Zugangsdaten Passwörter oder Schlüssel? */
  hasSecrets() {
    return this.project.sections.some(
      (s) =>
        s.type === 'access' &&
        ACCESS_BLOCKS.some(
          (b) =>
            b.columns &&
            s.blocks[b.id] &&
            (s[b.list] || []).some((row) => b.columns.some((c) => c.secret && String(row[c.key] || '').trim())),
        ),
    );
  }

  /** Vor dem Erstellen: Passwörter in diese PDF übernehmen? null = nichts zu entscheiden. */
  async askSecrets() {
    if (!this.hasSecrets()) return null;
    const shown = this.project.sections.some((s) => s.type === 'access' && s.showPasswords);
    const choice = await showDialog({
      title: 'Passwörter in die PDF?',
      icon: 'key',
      body: 'Die Zugangsdaten enthalten Passwörter bzw. WLAN-Schlüssel. <b>Ohne Passwörter</b> erscheinen dort Punkte – und die Passwörter werden auch nicht unsichtbar in der PDF gespeichert.',
      buttons: [
        { label: 'Abbrechen', value: 'cancel' },
        { label: 'Ohne Passwörter', value: 'hide', primary: !shown },
        { label: 'Mit Passwörtern', value: 'show', primary: shown },
      ],
      cancelValue: 'cancel',
    });
    return choice || 'cancel';
  }

  /** Projekt mit Passwörtern sichtbar (`show` = true) bzw. ausgeblendet; null = wie eingestellt. */
  withSecrets(show) {
    if (show == null) return this.project;
    return {
      ...this.project,
      sections: this.project.sections.map((s) => (s.type === 'access' ? { ...s, showPasswords: show } : s)),
    };
  }

  /**
   * Erzeugt die PDF. `showSecrets`: Passwörter zeigen (true/false) oder wie im Abschnitt
   * eingestellt (null). Ausgeblendete Passwörter fehlen auch im eingebetteten Projekt.
   */
  async buildPdf(showSecrets = null) {
    if (this.project.font === 'barlow') await ensureBarlow();
    const source = this.withSecrets(showSecrets);
    const doc = renderDocument(source, { skipEmpty: true });
    if (doc.skipped.length) toast(`Leere Abschnitte nicht aufgenommen: ${doc.skipped.join(', ')}`, '', 5000);
    const ts = typesetter(this.project);
    const html = printHtml({ pages: doc.pages, font: this.project.font, lang: ts.lang }, doc.label);
    assertPrintable(html);
    const raw = await makePdf(html);
    return embedProject(raw, withoutSecrets(source), {
      title: doc.label,
      author: [this.project.company.name, this.project.meta.technician].filter(Boolean).join(', '),
      subject: [this.project.meta.customer, this.project.meta.site].filter(Boolean).join(', '),
      lang: ts.lang,
    });
  }

  /** „PDF erstellen“: Datei speichern (Desktop-App: Speichern-Dialog). Im Browser: Drucken als PDF. */
  async exportPdf() {
    if (!this.project) return false;
    await this.flush();
    if (!canMakePdf()) {
      toast('Im Druckdialog „Als PDF speichern“ wählen.', '', 5000);
      return this.print();
    }
    const secrets = await this.askSecrets();
    if (secrets === 'cancel') return false;
    const show = secrets == null ? null : secrets === 'show';
    const name = this.fileName();
    let handle = null;
    if (window.showSaveFilePicker) {
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: name,
          types: [{ description: 'PDF-Dokument', accept: { 'application/pdf': ['.pdf'] } }],
        });
      } catch (err) {
        if (err && err.name === 'AbortError') return false;
      }
    }
    try {
      const bytes = await withBusy(() => this.buildPdf(show), 100);
      if (handle) {
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        idbPut('recent', handle.name, { name: handle.name, handle, time: Date.now() });
        toast('PDF erstellt: ' + handle.name);
      } else {
        downloadBytes(bytes, name);
        toast('Die PDF wurde in den Download-Ordner gespeichert.');
      }
      return true;
    } catch (err) {
      console.error('PDF erstellen', err);
      toast(failMessage(err), 'err', 6000);
      return false;
    }
  }

  async print() {
    if (!this.project) return;
    await this.flush();
    const secrets = await this.askSecrets();
    if (secrets === 'cancel') return;
    const show = secrets == null ? null : secrets === 'show';
    if (canMakePdf()) {
      try {
        const bytes = await withBusy(() => this.buildPdf(show), 100);
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
        if (!window.open(url, '_blank')) downloadBytes(bytes, this.fileName());
      } catch (err) {
        console.error('Drucken', err);
        toast(failMessage(err), 'err', 6000);
      }
      return;
    }
    // Browser: Druckfassung in einem unsichtbaren Rahmen drucken
    const doc = renderDocument(this.withSecrets(show), { skipEmpty: true });
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:fixed;width:0;height:0;border:0;visibility:hidden';
    frame.sandbox = 'allow-same-origin allow-modals'; // keine Skripte in der Druckfassung
    frame.srcdoc = printHtml({ pages: doc.pages, font: this.project.font, lang: typesetter(this.project).lang }, doc.label);
    frame.addEventListener('load', () => {
      try {
        frame.contentWindow.print();
      } finally {
        setTimeout(() => frame.remove(), 60000);
      }
    });
    document.body.appendChild(frame);
  }
}

/** Liegt der Zeigerpunkt in der Planfläche? */
const inArea = (hit, a) => hit.x >= a.x && hit.x <= a.x + a.w && hit.y >= a.y && hit.y <= a.y + a.h;

/** Nächster freier Pin-Name nach dem letzten (D2 → D3, A0 → A1); sonst leer. */
function nextPinName(pins) {
  const last = pins[pins.length - 1];
  const m = last && /^([A-Za-z]*)(\d+)$/.exec(last.name || '');
  if (!m) return '';
  let n = +m[2] + 1;
  while (pins.some((p) => p.name === m[1] + n)) n++;
  return m[1] + n;
}

/**
 * Bild lesen: Rastergrafiken werden auf höchstens `max` px verkleinert (als PNG bzw. mit `jpeg`
 * als JPEG auf weißem Grund, kleiner für Fotos und Pläne), SVG bleibt unverändert.
 */
/** Meldung, wenn die PDF nicht erzeugt werden konnte. */
const failMessage = (err) =>
  err instanceof TooLargeError ? 'Das Dokument ist zu groß. Bitte weniger oder kleinere Fotos verwenden.' : 'Die PDF konnte nicht erstellt werden.';

async function readImage(file, { max = 1600, jpeg = false } = {}) {
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    const text = await file.text();
    const data = 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(text)));
    const img = new Image();
    img.src = data;
    await img.decode();
    return { mime: 'image/svg+xml', data, w: img.naturalWidth || 300, h: img.naturalHeight || 100 };
  }
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const g = canvas.getContext('2d');
  if (jpeg) {
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
  }
  g.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const mime = jpeg ? 'image/jpeg' : 'image/png';
  return { mime, data: canvas.toDataURL(mime, 0.86), w: canvas.width, h: canvas.height };
}
/* ---------- Firma für neue Projekte merken ---------- */

const COMPANY_KEY = 'pdfix.studio.company';

/** Firmenname, Zusatz und Logo des zuletzt bearbeiteten Projekts für neue Projekte merken. */
function rememberCompany(project) {
  try {
    const { name, tagline, logo } = project.company;
    const image = logo && project.images[logo];
    const value = JSON.stringify({ name, tagline, logo: image || null });
    if (localStorage.getItem(COMPANY_KEY) !== value) localStorage.setItem(COMPANY_KEY, value);
  } catch {}
}

function applyCompany(project) {
  try {
    const saved = JSON.parse(localStorage.getItem(COMPANY_KEY) || 'null');
    if (!saved) return;
    if (typeof saved.name === 'string') project.company.name = saved.name;
    if (saved.tagline && typeof saved.tagline === 'object') project.company.tagline = saved.tagline;
    if (saved.logo && typeof saved.logo.data === 'string' && /^data:image\/(png|jpeg|webp|svg\+xml);base64,/.test(saved.logo.data)) {
      const id = uid('img');
      project.images[id] = saved.logo;
      project.company.logo = id;
    }
  } catch {}
}

/**
 * Hauptanwendung: Oberfläche, Dateien öffnen/speichern, Zoom, Seitenverwaltung, Tastenkürzel.
 */
import { PDFName } from 'pdf-lib';
import BUNDLED_FONTS from 'virtual:bundled-fonts';
import { FontLibrary } from './fonts/font-manager.js';
import { PdfSession } from './pdf/session.js';
import { PdfRenderer, PREVIEW_MAX_PX } from './render/pdf-renderer.js';
import { DetailRenderer } from './render/detail-renderer.js';
import { PageView } from './ui/page-view.js';
import { icon, LOGO_LARGE, LOGO_SMALL } from './ui/icons.js';
import { $, $$, escapeHtml, htmlToElement } from './ui/dom.js';
import { closeMenu, showMenu } from './ui/menu.js';
import { downloadBytes, pickFiles, showDialog, toast, withBusy } from './ui/dialogs.js';
import { idbDelete, idbList, idbPut } from './storage/idb.js';
import { EditMode } from './ui/edit-mode.js';
import { OrganizeMode } from './ui/organize-mode.js';
import { FontsPanel } from './ui/fonts-panel.js';
import { ZoomGestures } from './ui/zoom-gestures.js';

/**
 * Zoomstufen für Strg+Plus/Minus und Strg+Mausrad (1 = 100 %).
 */
const ZOOM_LEVELS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8, 12, 16, 24, 32,
];

/** Grenzen für den Zoom (auch für stufenloses Zoomen und eigene Eingaben). */
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 32;

/** Voreinstellungen im Zoom-Menü. */
const ZOOM_PRESETS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8, 16, 32];

/**
 * Pixelbudget für Vorschau-Canvas von Seiten außer Sicht; darüber werden die am längsten nicht
 * mehr sichtbaren Seiten freigegeben (beim erneuten Anzeigen neu gerendert).
 */
const HIDDEN_PREVIEW_BUDGET_PX = 16e6;

/** Anteil des Fensters, den die Auswahl nach „Auf Auswahl zoomen“ einnimmt (Rest = Rand). */
const SELECTION_FILL = 0.7;

/** Wartezeit (ms) vor dem Neurendern der Vorschau, solange gezoomt wird. */
const ZOOM_RENDER_HOLD_MS = 140;

/** Zoom als Text, z. B. „125 %“, „3.200 %“. */
export const formatZoom = (zoom) => Math.round(zoom * 100).toLocaleString('de-DE') + ' %';

/**
 * CSS-Pixel je PDF-Punkt bei 100 % Zoom.
 */
const CSS_PX_PER_PT = 96 / 72;

const objectIds = new WeakMap();

let objectIdSeq = 0;

const objectId = (obj) =>
  obj == null
    ? '0'
    : typeof obj != 'object'
      ? String(obj)
      : (objectIds.has(obj) || objectIds.set(obj, ++objectIdSeq), objectIds.get(obj));

/**
 * Hauptanwendung: baut die Oberfläche, verwaltet Dokument (`session`), Seitenansichten (`pvs`),
 * Darstellung (`renderer`), Zoom und die Modi `edit` (EditMode), `org` (OrganizeMode) und
 * `fontsPanel`. Erreichbar als `window.pdfEditor` (auch von den Tests genutzt).
 */
export class App {
  constructor(root) {
    this.root = root;
    this.session = null;
    this.renderer = new PdfRenderer();
    this.library = new FontLibrary();
    this.file = null;
    this.pvs = [];
    this.pvByKey = new Map();
    this.zoom = 1;
    this.fit = 'width';
    this.cur = 0;
    this.tool = null;
    this.renderQueue = new Set();
    this.rendering = false;
    this.renderHoldUntil = 0;
    this.previewJob = null;
    this.edit = new EditMode(this);
    this.org = new OrganizeMode(this);
    this.fontsPanel = new FontsPanel(this);
    this.build();
    this.loadFonts();
    this.showHome();
  }
  build() {
    this.root.innerHTML = `
<header id="top">
  <div class="brand"><div class="mark">${LOGO_SMALL}</div><span>PDF-Editor</span></div>
  <button class="btn" id="bFile">Datei ${icon('chev', 's caret')}</button>
  <div class="sep"></div>
  <div class="doctab hidden" id="docTab">${icon('file', 's')}<span class="nm" id="docName"></span><span class="dot hidden" id="dirtyDot" title="Ungespeicherte Änderungen"></span><button class="btn ic" id="bClose" title="Dokument schließen">${icon('close', 's')}</button></div>
  <div class="grow"></div>
  <div class="tb-group" id="histBtns">
    <button class="btn ic" id="bUndo" title="Rückgängig (Strg+Z)" disabled>${icon('undo')}</button>
    <button class="btn ic" id="bRedo" title="Wiederholen (Strg+Y)" disabled>${icon('redo')}</button>
  </div>
  <div class="sep"></div>
  <button class="btn ic" id="bPrint" title="Drucken / im Browser anzeigen" disabled>${icon('print')}</button>
  <button class="btn primary" id="bSave" disabled>${icon('save', 's')}Speichern</button>
</header>
<div id="main">
  <aside id="left" class="collapsed"><div class="lp-head" id="lpHead"></div><div class="lp-body" id="lpBody"></div></aside>
  <section id="center">
    <div id="ctx" class="hidden"></div>
    <div id="scroller" tabindex="-1"><div id="pages"></div></div>
    <div id="org" class="hidden"></div>
    <div id="nav" class="hidden">
      <button class="btn ic" id="bPrev" title="Vorherige Seite">${icon('up')}</button>
      <button class="btn ic" id="bNext" title="Nächste Seite">${icon('down')}</button>
      <div class="pg"><input id="pgIn" inputmode="numeric" aria-label="Seite"> <span>/</span> <span id="pgN">0</span></div>
      <div class="sep"></div>
      <button class="btn ic" id="bZout" title="Verkleinern (Strg+−)">${icon('zout')}</button>
      <button class="btn zv" id="bZoom" title="Zoom">100 %</button>
      <button class="btn ic" id="bZin" title="Vergrößern (Strg++)">${icon('zin')}</button>
      <button class="btn ic" id="bFit" title="Seitenbreite">${icon('fitw')}</button>
    </div>
    <div id="home"></div>
  </section>
  <aside id="right" class="collapsed"><div class="lp-head" style="height:44px;font-size:13px">Seiten</div><div class="thumbs" id="thumbs"></div></aside>
  <nav id="rail" class="hidden">
    <button class="btn ic" id="rThumbs" title="Seitenminiaturen">${icon('thumbs')}</button>
    <button class="btn ic" id="rFonts" title="Schriften im Dokument">${icon('fonts')}</button>
  </nav>
</div>`;
    const on = (id, type, handler) => $('#' + id).addEventListener(type, handler);
    on('bFile', 'click', (n) => this.fileMenu(n.currentTarget));
    on('bClose', 'click', () => this.close());
    on('bUndo', 'click', () => this.undo());
    on('bRedo', 'click', () => this.redo());
    on('bSave', 'click', () => this.save());
    on('bPrint', 'click', () => this.print());
    on('bPrev', 'click', () => this.goto(this.cur - 1));
    on('bNext', 'click', () => this.goto(this.cur + 1));
    on('bZin', 'click', () => this.zoomStep(1));
    on('bZout', 'click', () => this.zoomStep(-1));
    on('bFit', 'click', () => this.setZoom(null, 'width'));
    on('bZoom', 'click', (n) => this.zoomMenu(n.currentTarget));
    on('rThumbs', 'click', () => this.toggleRight());
    on('rFonts', 'click', () => this.setTool(this.tool === 'fonts' ? null : 'fonts'));
    const pageInput = $('#pgIn');
    pageInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        const num = parseInt(pageInput.value, 10);
        if (!isNaN(num)) this.goto(Math.max(1, num) - 1);
        pageInput.value = this.cur + 1;
        pageInput.blur();
      }
      if (ev.key === 'Escape') {
        pageInput.value = this.cur + 1;
        pageInput.blur();
      }
      ev.stopPropagation();
    });
    pageInput.addEventListener('blur', () => {
      pageInput.value = this.cur + 1;
    });
    const scroller = $('#scroller');
    scroller.addEventListener('scroll', () => this.onScroll(), { passive: true });
    this.detail = new DetailRenderer(this, scroller);
    this.gestures = new ZoomGestures(this, scroller);
    this.watchDpr();
    this.io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pv = this.pvByKey.get(entry.target.dataset.key);
          if (pv) {
            pv.visible = entry.isIntersecting;
            if (pv.visible) {
              this.queueRender(pv);
              if (this.edit.active) this.edit.drawBoxes(pv);
            } else {
              pv.lastSeen = performance.now();
              pv.clearDetail();
            }
          }
        }
        this.trimPreviews();
        this.detail.schedule();
      },
      { root: scroller, rootMargin: '600px 0px' },
    );
    this.tio = new IntersectionObserver(
      (n) => {
        for (const entry of n) if (entry.isIntersecting) this.renderThumb(entry.target);
      },
      { root: $('#thumbs'), rootMargin: '300px 0px' },
    );
    window.addEventListener('resize', () => {
      if (this.session && this.fit) this.setZoom(null, this.fit, true);
      this.detail.schedule();
    });
    window.addEventListener('keydown', (ev) => this.onKey(ev));
    window.addEventListener('beforeunload', (n) => {
      if (this.session && this.session.dirty) {
        n.preventDefault();
        n.returnValue = '';
      }
    });
    window.addEventListener('dragover', (ev) => {
      ev.preventDefault();
    });
    window.addEventListener('drop', (ev) => this.onDrop(ev));
  }
  async showHome() {
    const home = $('#home');
    home.classList.remove('hidden');
    home.innerHTML = `
<div class="hcard">
  <div class="hhero"><div class="mark">${LOGO_LARGE}</div><div><h1>PDF-Editor</h1><p>Texte und Bilder in PDF-Dateien bearbeiten, Seiten einfügen und ordnen – direkt im Browser, ohne Internet.</p></div></div>
  <div class="drop" id="dropZone">
    <div class="ficon" style="width:40px;height:50px"></div>
    <div class="dt"><b>PDF-Datei öffnen</b><span>Datei auswählen oder hierher ziehen</span></div>
    <button class="btn primary" id="hOpen">${icon('open', 's')}Datei öffnen</button>
  </div>
  <div class="feats">
    <div class="feat"><div class="ti c1">${icon('edit')}</div><b>Text bearbeiten</b><span>Direkt in den Text klicken und schreiben – in der Originalschrift des Dokuments.</span></div>
    <div class="feat"><div class="ti c3">${icon('image')}</div><b>Bilder &amp; Grafiken</b><span>Verschieben, Größe ändern, ersetzen oder entfernen. Neue Bilder einfügen.</span></div>
    <div class="feat"><div class="ti c2">${icon('pages')}</div><b>Seiten organisieren</b><span>Einfügen, löschen, drehen, sortieren – Seitenzahlen werden angepasst.</span></div>
    <div class="feat"><div class="ti c4">${icon('signature')}</div><b>Unterschrift</b><span>Einmal aus einem Dokument übernehmen und in jedes PDF einsetzen.</span></div>
  </div>
  <div class="recent hidden" id="recent"><h4>Zuletzt geöffnet</h4><div class="rl" id="recentList"></div></div>
</div>`;
    $('#hOpen').addEventListener('click', () => this.openDialog());
    const dropZone = $('#dropZone');
    dropZone.addEventListener('dragenter', () => dropZone.classList.add('over'));
    dropZone.addEventListener('dragleave', (ev) => {
      if (!dropZone.contains(ev.relatedTarget)) dropZone.classList.remove('over');
    });
    dropZone.addEventListener('drop', () => dropZone.classList.remove('over'));
    const recent = (await idbList('recent'))
      .map((n) => n.value)
      .filter((n) => n && n.handle)
      .sort((n, a) => a.time - n.time)
      .slice(0, 6);
    if (recent.length) {
      $('#recent').classList.remove('hidden');
      const list = $('#recentList');
      for (const item of recent) {
        const el = htmlToElement(
          `<div class="ri"><div class="ficon"></div><div class="rn"></div><div class="rd"></div><button class="btn ic" title="Aus Liste entfernen">${icon('x', 's')}</button></div>`,
        );
        el.querySelector('.rn').textContent = item.name;
        el.querySelector('.rd').textContent = new Date(item.time).toLocaleString('de-DE', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
          hour: '2-digit',
          minute: '2-digit',
        });
        el.querySelector('button').addEventListener('click', (ev) => {
          ev.stopPropagation();
          idbDelete('recent', item.name);
          el.remove();
        });
        el.addEventListener('click', () => this.openHandle(item.handle));
        list.appendChild(el);
      }
    }
  }
  async loadFonts() {
    try {
      for (const font of BUNDLED_FONTS) {
        const gz = Uint8Array.from(atob(font.data), (a) => a.charCodeAt(0));
        const stream = new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'));
        const bytes = new Uint8Array(await new Response(stream).arrayBuffer());
        try {
          this.library.add(bytes, 'mitgeliefert');
        } catch {}
      }
    } catch (err) {
      console.warn('Mitgelieferte Schriften nicht geladen', err);
    }
    for (const entry of await idbList('fonts'))
      try {
        this.library.add(new Uint8Array(entry.value), 'eigene');
      } catch {}
  }
  fileMenu(anchor) {
    const hasDoc = !!this.session;
    showMenu(
      [
        { label: 'Öffnen …', icon: 'open', key: 'Strg+O', run: () => this.openDialog() },
        { label: 'Speichern', icon: 'save', key: 'Strg+S', disabled: !hasDoc, run: () => this.save() },
        {
          label: 'Speichern unter …',
          icon: 'saveas',
          key: 'Strg+Umschalt+S',
          disabled: !hasDoc,
          run: () => this.saveAs(),
        },
        '-',
        { label: 'Im Browser anzeigen / Drucken', icon: 'print', disabled: !hasDoc, run: () => this.print() },
        { label: 'Dokumenteigenschaften', icon: 'info', disabled: !hasDoc, run: () => this.props() },
        '-',
        { label: 'Schließen', icon: 'close', disabled: !hasDoc, run: () => this.close() },
      ],
      anchor,
    );
  }
  async openDialog() {
    if (!(await this.confirmDiscard())) return;
    if (window.showOpenFilePicker)
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [{ description: 'PDF-Dokumente', accept: { 'application/pdf': ['.pdf'] } }],
          excludeAcceptAllOption: false,
        });
        if (handle) return this.openHandle(handle);
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    const file = await pickFiles('.pdf,application/pdf');
    if (file) this.openFile(file, null);
  }
  async openHandle(handle) {
    try {
      if (
        handle.queryPermission &&
        (await handle.queryPermission({ mode: 'read' })) !== 'granted' &&
        (await handle.requestPermission({ mode: 'read' })) !== 'granted'
      )
        return;
      const file = await handle.getFile();
      await this.openFile(file, handle);
    } catch {
      toast('Die Datei konnte nicht geöffnet werden.', 'err');
    }
  }
  async openFile(file, handle) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    return this.openBytes(bytes, file.name, handle);
  }
  async openBytes(bytes, name, handle) {
    closeMenu();
    if (this.session && !(await this.confirmDiscard())) return false;
    let failure = null;
    const ok = await withBusy(async () => {
      let session;
      try {
        session = await PdfSession.open(bytes, { library: this.library });
      } catch (err) {
        failure = /encrypt/i.test(String(err && err.message)) ? 'enc' : 'bad';
        return false;
      }
      if (session.doc.isEncrypted) {
        failure = 'enc';
        return false;
      }
      let pages = 0;
      try {
        pages = session.numPages;
      } catch {
        pages = 0;
      }
      if (!pages) {
        failure = 'empty';
        return false;
      }
      try {
        await this.renderer.load(bytes);
      } catch {
        failure = 'bad';
        return false;
      }
      this.closeDoc();
      this.session = session;
      this.file = { name, handle };
      this.origSize = bytes.length;
      this.running = null;
      $('#home').classList.add('hidden');
      $('#docTab').classList.remove('hidden');
      $('#docName').textContent = name;
      $('#docTab').title = name;
      $('#nav').classList.remove('hidden');
      $('#rail').classList.remove('hidden');
      $('#bSave').disabled = false;
      $('#bPrint').disabled = false;
      this.rebuildPages();
      this.setZoom(null, 'width', true);
      this.setTool(null);
      if (handle) idbPut('recent', name, { name, handle, time: Date.now() });
      document.title = name + ' – PDF-Editor';
      return true;
    });
    if (failure) {
      const message = {
        enc: 'Diese PDF-Datei ist verschlüsselt bzw. kennwortgeschützt. Geschützte Dokumente können nicht bearbeitet werden.',
        empty: 'Die Datei enthält keine Seiten – sie ist vermutlich beschädigt oder unvollständig.',
        bad: 'Die Datei ist keine gültige PDF-Datei oder sie ist beschädigt.',
      }[failure];
      await showDialog({
        title: 'Datei kann nicht geöffnet werden',
        icon: 'warn',
        body: escapeHtml(message) + '<br><br><span class="hint">Datei: ' + escapeHtml(name) + '</span>',
      });
    }
    return ok;
  }
  closeDoc() {
    this.lastPin = null;
    this.detail.reset();
    PageView.forgetRemembered();
    this.edit.reset();
    this.org.reset();
    for (const pv of this.pvs) this.io.unobserve(pv.el);
    this.pvs = [];
    this.pvByKey.clear();
    $('#pages').innerHTML = '';
    $('#thumbs').innerHTML = '';
    this.session = null;
    this.file = null;
  }
  async close() {
    if (this.session) {
      await this.edit.finishEdit();
      if (await this.confirmDiscard()) {
        this.closeDoc();
        $('#docTab').classList.add('hidden');
        $('#nav').classList.add('hidden');
        $('#rail').classList.add('hidden');
        $('#left').classList.add('collapsed');
        $('#right').classList.add('collapsed');
        $('#ctx').classList.add('hidden');
        $('#org').classList.add('hidden');
        $('#scroller').classList.remove('hidden');
        $('#bSave').disabled = true;
        $('#bPrint').disabled = true;
        this.updateHist();
        document.title = 'PDF-Editor';
        this.showHome();
      }
    }
  }
  async confirmDiscard() {
    if (!this.session || !this.session.dirty) return true;
    const choice = await showDialog({
      title: 'Änderungen speichern?',
      icon: 'save',
      body: `Das Dokument <b>${escapeHtml(this.file.name)}</b> enthält ungespeicherte Änderungen.`,
      buttons: [
        { label: 'Abbrechen', value: 'cancel' },
        { label: 'Nicht speichern', value: 'discard' },
        { label: 'Speichern', primary: true, value: 'save' },
      ],
      cancelValue: 'cancel',
    });
    return choice === 'cancel' || choice == null ? false : choice === 'save' ? this.save() : true;
  }
  async onDrop(ev) {
    ev.preventDefault();
    const items = [...(ev.dataTransfer.items || [])].filter((s) => s.kind === 'file');
    const files = [...(ev.dataTransfer.files || [])];
    if (!files.length) return;
    const file = files[0];
    const isPdf = /pdf$/i.test(file.type) || /\.pdf$/i.test(file.name);
    const isImage = /^image\//.test(file.type);
    if (this.session && isImage) return this.edit.dropImage(file, ev);
    if (this.session && isPdf && this.tool === 'organize')
      return this.org.insertFiles(
        files.filter((s) => /\.pdf$/i.test(s.name)),
        null,
      );
    if (isPdf) {
      let handle = null;
      try {
        if (items[0] && items[0].getAsFileSystemHandle) handle = await items[0].getAsFileSystemHandle();
      } catch {}
      if (this.session) {
        const choice = await showDialog({
          title: 'PDF-Datei abgelegt',
          icon: 'file',
          body: `Was möchten Sie mit <b>${escapeHtml(file.name)}</b> tun?`,
          buttons: [
            { label: 'Abbrechen', value: null },
            { label: 'Seiten einfügen', value: 'insert' },
            { label: 'Öffnen', primary: true, value: 'open' },
          ],
        });
        if (choice === 'insert') return this.org.insertFiles([file], null);
        if (choice !== 'open') return;
      }
      return handle && handle.kind === 'file' ? this.openHandle(handle) : this.openFile(file, null);
    }
    toast('Nur PDF-Dateien und Bilder (PNG, JPG) können abgelegt werden.', 'warn');
  }
  async bytesForSave() {
    return this.session
      ? (await this.edit.finishEdit(), this._syncP && (await this._syncP), this.session.save({ clean: true }))
      : null;
  }
  async save() {
    if (!this.session) return false;
    if (!this.file.handle) return this.saveAs();
    try {
      return await withBusy(async () => {
        const bytes = await this.bytesForSave();
        const handle = this.file.handle;
        if (
          handle.queryPermission &&
          (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted' &&
          (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted'
        )
          throw new Error('perm');
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        this.markSaved();
        toast('Gespeichert');
        idbPut('recent', this.file.name, { name: this.file.name, handle, time: Date.now() });
        return true;
      }, 100);
    } catch (err) {
      return err && err.message === 'perm'
        ? this.saveAs()
        : (toast('Speichern nicht möglich – bitte „Speichern unter“ verwenden.', 'err', 4000), false);
    }
  }
  async saveAs() {
    if (!this.session) return false;
    const filename = this.file.name.replace(/\.pdf$/i, '') + '.pdf';
    if (window.showSaveFilePicker) {
      let handle;
      try {
        handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'PDF-Dokument', accept: { 'application/pdf': ['.pdf'] } }],
        });
      } catch (err) {
        if (err && err.name === 'AbortError') return false;
        handle = null;
      }
      if (handle)
        return withBusy(async () => {
          const data = await this.bytesForSave();
          const writable = await handle.createWritable();
          await writable.write(data);
          await writable.close();
          this.file = { name: handle.name, handle };
          $('#docName').textContent = handle.name;
          document.title = handle.name + ' – PDF-Editor';
          this.markSaved();
          toast('Gespeichert als ' + handle.name);
          idbPut('recent', handle.name, { name: handle.name, handle, time: Date.now() });
          return true;
        }, 100);
    }
    const bytes = await withBusy(() => this.bytesForSave());
    downloadBytes(bytes, filename);
    this.markSaved();
    toast('Die Datei wurde in den Download-Ordner gespeichert.');
    return true;
  }
  markSaved() {
    this.session.savedVersion = this.session.version;
    this.updateHist();
  }
  async print() {
    if (!this.session) return;
    const bytes = await withBusy(() => this.bytesForSave());
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    if (!window.open(url, '_blank')) downloadBytes(bytes, this.file.name);
  }
  props() {
    const doc = this.session.doc;
    const info = this.session.pageInfo(this.cur);
    const toMm = (pt) => Math.round((pt / 72) * 25.4);
    const rows = [
      ['Datei', this.file.name],
      ['Seiten', this.session.numPages],
      ['Seitenformat', `${toMm(info.w)} × ${toMm(info.h)} mm`],
      ['Titel', doc.getTitle() || '–'],
      ['Autor', doc.getAuthor() || '–'],
      ['Erstellt mit', doc.getCreator() || doc.getProducer() || '–'],
      ['Schriften', this.session.fonts.list().length],
    ];
    showDialog({
      title: 'Dokumenteigenschaften',
      icon: 'info',
      body: `<div class="kv" style="font-size:13px">${rows.map(([a, A]) => `<span>${escapeHtml(a)}</span><span>${escapeHtml(A)}</span>`).join('')}</div>`,
    });
  }
  async undo() {
    if (this.edit.editor) {
      document.execCommand('undo');
      return;
    }
    const entry = this.session && this.session.undo();
    if (entry) {
      this.edit.clearSelection();
      await this.sync();
      toast('Rückgängig: ' + entry.label);
    }
  }
  async redo() {
    if (this.edit.editor) {
      document.execCommand('redo');
      return;
    }
    const entry = this.session && this.session.redo();
    if (entry) {
      this.edit.clearSelection();
      await this.sync();
      toast('Wiederholt: ' + entry.label);
    }
  }
  updateHist() {
    const session = this.session;
    $('#bUndo').disabled = !session || !session.hist.undo.length;
    $('#bRedo').disabled = !session || !session.hist.redo.length;
    $('#bUndo').title =
      session && session.hist.undo.length
        ? 'Rückgängig: ' + session.hist.undo[session.hist.undo.length - 1].label + ' (Strg+Z)'
        : 'Rückgängig (Strg+Z)';
    $('#bRedo').title =
      session && session.hist.redo.length
        ? 'Wiederholen: ' + session.hist.redo[session.hist.redo.length - 1].label + ' (Strg+Y)'
        : 'Wiederholen (Strg+Y)';
    $('#dirtyDot').classList.toggle('hidden', !session || !session.dirty);
  }
  /**
   * Speichert das Dokument intern (ohne Aufräumen), lädt es in pdf.js neu und baut die
   * Seitenansichten nach – nach jeder Änderung.
   */
  async sync() {
    if (this._syncP) {
      this._syncAgain = true;
      return this._syncP;
    }
    this._syncP = (async () => {
      do {
        this._syncAgain = false;
        const bytes = await this.session.save({ clean: false });
        try {
          await this.renderer.load(bytes);
        } catch (err) {
          console.warn('Neuladen der Darstellung', err);
          await this.renderer.load(await this.session.save({ clean: false }));
        }
        this.rebuildPages();
      } while (this._syncAgain);
    })();
    try {
      await this._syncP;
    } finally {
      this._syncP = null;
    }
    this.updateHist();
    this.edit.afterSync();
    this.org.afterSync();
  }
  sigOf(index) {
    const node = this.session.page(index).node;
    const info = this.session.pageInfo(index);
    return [
      objectId(node.get(PDFName.of('Contents'))),
      objectId(node.get(PDFName.of('Resources'))),
      info.rotate,
      info.w,
      info.h,
    ].join('|');
  }
  rebuildPages() {
    const session = this.session;
    const numPages = session.numPages;
    const pagesEl = $('#pages');
    const keys = new Set();
    const views = [];
    for (let k = 0; k < numPages; k++) {
      const key = session.page(k).ref.toString();
      let pv = this.pvByKey.get(key);
      if (!pv) {
        pv = new PageView(key);
        this.pvByKey.set(key, pv);
        this.io.observe(pv.el);
      }
      pv.index = k;
      pv.sig = this.sigOf(k);
      pv.infoRaw = session.pageInfo(k);
      keys.add(key);
      views.push(pv);
    }
    for (const [key, view] of this.pvByKey)
      if (!keys.has(key)) {
        this.io.unobserve(view.el);
        view.el.remove();
        this.pvByKey.delete(key);
      }
    this.pvs = views;
    PageView.forgetRemembered(new Set(views));
    views.forEach((A, s) => {
      if (pagesEl.children[s] !== A.el) pagesEl.insertBefore(A.el, pagesEl.children[s] || null);
    });
    this.layoutPages();
    $('#pgN').textContent = numPages;
    this.cur = Math.max(0, Math.min(this.cur, numPages - 1));
    this.setCur(this.cur);
    this.renderThumbs();
    for (const pv of this.pvs) if (pv.visible) this.queueRender(pv);
    this.detail.schedule(0);
  }
  layoutPages() {
    const scale = this.zoom * CSS_PX_PER_PT;
    for (const pv of this.pvs) pv.setGeometry(pv.infoRaw, scale);
    this.edit.layoutChanged();
  }
  /**
   * Ist die Vorschau von `pv` aktuell? Gleiche Seite und gleiche Pixelgröße genügen – oberhalb von
   * PREVIEW_MAX_PX ist die Vorschau unabhängig vom Zoom gleich groß und muss nicht neu entstehen.
   */
  previewFresh(pv) {
    const rendered = pv.rendered;
    return !!rendered && rendered.sig === pv.sig && rendered.key === pv.previewSize().key;
  }
  /**
   * Prüft die Vorschau; ist sie trotz anderem Zoom gültig (gleiche Pixelgröße), gilt sie als für
   * den aktuellen Zoom gerendert.
   */
  adoptPreview(pv) {
    if (!this.previewFresh(pv)) return false;
    pv.rendered.scale = pv.scale;
    return true;
  }
  queueRender(pv) {
    if (this.session) {
      if (!(
        this.adoptPreview(pv) ||
        (pv.rendered && pv.rendered.sig !== pv.sig && pv.restoreFrom(pv.sig, pv.scale))
      )) {
        this.renderQueue.add(pv);
        this.pumpRender();
      }
    }
  }
  async pumpRender() {
    if (!this.rendering) {
      this.rendering = true;
      try {
        while (this.renderQueue.size) {
          // während einer Zoomgeste nicht jede Zwischenstufe rendern
          for (let wait; (wait = this.renderHoldUntil - performance.now()) > 0;)
            await new Promise((resolve) => setTimeout(resolve, wait));
          const queue = [...this.renderQueue].filter((s) => this.pvByKey.get(s.key) === s);
          this.renderQueue.clear();
          queue.sort((s, o) => Math.abs(s.index - this.cur) - Math.abs(o.index - this.cur));
          const [next, ...rest] = queue;
          rest.forEach((s) => this.renderQueue.add(s));
          if (!next || !next.visible || this.adoptPreview(next)) continue;
          const sig = next.sig;
          const scale = next.scale;
          const key = next.previewSize().key;
          const gen = this.renderer.gen;
          const job = (this.previewJob = { pv: next, key, task: null });
          try {
            if (
              (await this.renderer.render(next.index, next.canvas, scale, {
                maxPx: PREVIEW_MAX_PX,
                onTask: (task) => (job.task = task),
              })) &&
              gen === this.renderer.gen
            )
              next.rendered = { sig, scale, key };
            else if (next.visible) this.renderQueue.add(next);
          } catch (err) {
            console.warn('Darstellung fehlgeschlagen', err);
            next.rendered = { sig, scale, key };
          } finally {
            if (this.previewJob === job) this.previewJob = null;
          }
        }
      } finally {
        this.rendering = false;
      }
    }
  }
  /** Gibt Vorschau-Canvas nicht sichtbarer Seiten frei, sobald sie das Pixelbudget übersteigen. */
  trimPreviews() {
    const hidden = this.pvs
      .filter((pv) => !pv.visible && pv.canvas.width)
      .sort((a, b) => (a.lastSeen || 0) - (b.lastSeen || 0));
    let total = hidden.reduce((sum, pv) => sum + pv.canvas.width * pv.canvas.height, 0);
    for (const pv of hidden) {
      if (total <= HIDDEN_PREVIEW_BUDGET_PX) break;
      total -= pv.canvas.width * pv.canvas.height;
      pv.release();
    }
  }
  /** Summe der Pixel aller Seiten-Canvas (Vorschau + Detail) – für Tests und Diagnose. */
  canvasPixels() {
    let preview = 0;
    let detail = 0;
    for (const pv of this.pvs) {
      preview += pv.canvas.width * pv.canvas.height;
      detail += pv.detail.width * pv.detail.height;
    }
    return { preview, detail, total: preview + detail };
  }
  /** Bei geändertem devicePixelRatio (Fenster auf anderen Bildschirm, Browser-Zoom) neu rendern. */
  watchDpr() {
    const query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    query.addEventListener(
      'change',
      () => {
        if (this.session) {
          for (const pv of this.pvs) if (pv.visible) this.queueRender(pv);
          this.detail.schedule(0);
        }
        this.watchDpr();
      },
      { once: true },
    );
  }
  toggleRight(show) {
    const panel = $('#right');
    const visible = show ?? panel.classList.contains('collapsed');
    panel.classList.toggle('collapsed', !visible);
    $('#rThumbs').classList.toggle('on', visible);
    if (visible) this.renderThumbs();
  }
  renderThumbs() {
    const thumbs = $('#thumbs');
    if ($('#right').classList.contains('collapsed') || !this.session) return;
    const keys = this.pvs.map((pv) => pv.key);
    const existing = new Map($$('.th', thumbs).map((n) => [n.dataset.key, n]));
    for (const [key, el] of existing)
      if (!keys.includes(key)) {
        this.tio.unobserve(el);
        el.remove();
      }
    this.pvs.forEach((pv, index) => {
      let el = existing.get(pv.key);
      if (!el) {
        el = htmlToElement(
          `<div class="th" data-key="${pv.key}"><div class="tc"><canvas></canvas></div><div class="tn"></div></div>`,
        );
        el.addEventListener('click', () => this.goto(this.pvByKey.get(el.dataset.key).index));
        el.addEventListener('contextmenu', (ev) => {
          ev.preventDefault();
          this.org.pageMenu(this.pvByKey.get(el.dataset.key).index, { x: ev.clientX, y: ev.clientY });
        });
        this.tio.observe(el);
      }
      if (thumbs.children[index] !== el) thumbs.insertBefore(el, thumbs.children[index] || null);
      el.querySelector('.tn').textContent = index + 1;
      const infoRaw = pv.infoRaw;
      const rotated = infoRaw.rotate % 180 !== 0;
      const width = 128;
      const height = width * ((rotated ? infoRaw.w : infoRaw.h) / (rotated ? infoRaw.h : infoRaw.w));
      const box = el.querySelector('.tc');
      box.style.width = width + 'px';
      box.style.height = height + 'px';
      el.classList.toggle('cur', index === this.cur);
      if (el.dataset.sig !== pv.sig && el.dataset.vis === '1') this.renderThumb(el);
    });
  }
  async renderThumb(el) {
    el.dataset.vis = '1';
    const pv = this.pvByKey.get(el.dataset.key);
    if (!pv || el.dataset.sig === pv.sig) return;
    const sig = pv.sig;
    el.dataset.sig = sig;
    const canvas = el.querySelector('canvas');
    const infoRaw = pv.infoRaw;
    const rotated = infoRaw.rotate % 180 !== 0;
    const width = 128;
    const scale = width / (rotated ? infoRaw.h : infoRaw.w);
    canvas.style.width = width + 'px';
    this._thumbChain = (this._thumbChain || Promise.resolve())
      .then(() => this.renderer.render(pv.index, canvas, scale, { maxPx: 400000 }))
      .then((l) => {
        if (!l) el.dataset.sig = '';
      })
      .catch(() => {
        el.dataset.sig = '';
      });
  }
  /**
   * Setzt den Zoom (MIN_ZOOM–MAX_ZOOM) oder passt an Seitenbreite (`fit = 'width'`, höchstens
   * 125 %) bzw. ganze Seite an. Die Seitengröße ist info.w × zoom × 96/72 CSS-Pixel. Die Vorschau
   * hat höchstens PREVIEW_MAX_PX Pixel; die Schärfe darüber liefert der Detail-Canvas
   * (DetailRenderer) für den sichtbaren Ausschnitt.
   *
   * `anchor`: Punkt, der beim Zoomen stehen bleibt – { clientX, clientY } (z. B. Mausposition)
   * oder ein Ergebnis von `selectionAnchor()`; ohne Angabe die Mitte des Fensters. Beim Anpassen
   * (`fit`) bleibt wie bisher die relative Lage in der aktuellen Seite erhalten.
   * `opts.live`: Teil einer laufenden Geste – Neurendern erst nach kurzer Ruhepause.
   */
  setZoom(zoom, fit, force, anchor, opts = {}) {
    if (!this.session) return;
    const scroller = $('#scroller');
    const cur = this.cur;
    const curPv = this.pvs[cur];
    const relScroll = curPv
      ? (scroller.scrollTop - curPv.el.offsetTop) / Math.max(1, curPv.el.offsetHeight)
      : 0;
    this.fit = fit || null;
    if (fit) {
      const maxWidth = Math.max(
        ...this.pvs.map((pv) => (pv.infoRaw.rotate % 180 ? pv.infoRaw.h : pv.infoRaw.w)),
      );
      const availWidth = scroller.clientWidth - 80;
      if (fit === 'width') zoom = Math.min(1.25, availWidth / (maxWidth * CSS_PX_PER_PT));
      else {
        const pv = this.pvs[this.cur] || this.pvs[0];
        const pageHeight = pv.infoRaw.rotate % 180 ? pv.infoRaw.w : pv.infoRaw.h;
        zoom = Math.min(
          availWidth / (maxWidth * CSS_PX_PER_PT),
          (scroller.clientHeight - 60) / (pageHeight * CSS_PX_PER_PT),
        );
      }
    }
    zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom));
    if (!(Math.abs(zoom - this.zoom) < 1e-4 && !force && !fit)) {
      const pin = fit ? null : this.zoomAnchor(anchor);
      this.edit.finishEdit();
      this.zoom = zoom;
      $('#bZoom').textContent = formatZoom(zoom);
      this.layoutPages();
      if (pin) this.restoreAnchor(pin);
      else if (curPv) scroller.scrollTop = curPv.el.offsetTop + relScroll * curPv.el.offsetHeight;
      if (opts.live) this.renderHoldUntil = performance.now() + ZOOM_RENDER_HOLD_MS;
      const job = this.previewJob;
      if (job && job.task && job.key !== job.pv.previewSize().key) job.task.cancel();
      for (const pv of this.pvs) if (pv.visible) this.queueRender(pv);
      this.detail.schedule(opts.live ? ZOOM_RENDER_HOLD_MS : 30);
    }
  }
  /**
   * Hält einen Punkt fest, der beim Zoomen an derselben Bildschirmstelle bleiben soll:
   * { pv, pdf: [x, y], clientX, clientY } – die Seite unter (oder nächst) dem Punkt und die
   * PDF-Koordinaten darauf.
   */
  zoomAnchor(anchor) {
    if (anchor && anchor.pv) return anchor;
    const scroller = $('#scroller');
    const rect = scroller.getBoundingClientRect();
    const x = anchor ? anchor.clientX : rect.left + scroller.clientWidth / 2;
    const y = anchor ? anchor.clientY : rect.top + scroller.clientHeight / 2;
    // Mehrere Zoomschritte an derselben Stelle: den ursprünglichen PDF-Punkt weiterverwenden.
    // Neu abgetastet würde der Rundungsfehler der Bildlaufposition mit jedem Schritt vergrößert.
    const last = this.lastPin;
    if (
      last &&
      Math.abs(last.clientX - x) < 0.5 &&
      Math.abs(last.clientY - y) < 0.5 &&
      last.scrollLeft === scroller.scrollLeft &&
      last.scrollTop === scroller.scrollTop &&
      this.pvByKey.get(last.pv.key) === last.pv
    )
      return last;
    let best = null;
    let bestDist = Infinity;
    const candidates = this.pvs.filter((pv) => pv.visible);
    for (const pv of candidates.length ? candidates : this.pvs) {
      const r = pv.el.getBoundingClientRect();
      const dist = Math.hypot(Math.max(r.left - x, 0, x - r.right), Math.max(r.top - y, 0, y - r.bottom));
      if (dist < bestDist) {
        bestDist = dist;
        best = pv;
      }
    }
    return best ? { pv: best, pdf: best.clientToPdf(x, y), clientX: x, clientY: y } : null;
  }
  restoreAnchor(pin) {
    if (!pin || this.pvByKey.get(pin.pv.key) !== pin.pv) return;
    const scroller = $('#scroller');
    const [x, y] = pin.pv.layerToClient(...pin.pv.pdfToLayer(...pin.pdf));
    scroller.scrollLeft += x - pin.clientX;
    scroller.scrollTop += y - pin.clientY;
    this.lastPin = { ...pin, scrollLeft: scroller.scrollLeft, scrollTop: scroller.scrollTop };
  }
  /**
   * Anker auf der Mitte der Auswahl (Bearbeiten-Modus): bleibt stehen, wenn er sichtbar ist,
   * sonst wird er in die Fenstermitte gerückt. Ohne Auswahl null.
   */
  selectionAnchor() {
    const edit = this.edit;
    if (!edit.active || !edit.hasSelection()) return null;
    const pv = edit.sel.pv;
    const box = edit.selBox();
    const pdf = [(box[0] + box[2]) / 2, (box[1] + box[3]) / 2];
    const scroller = $('#scroller');
    const rect = scroller.getBoundingClientRect();
    let [x, y] = pv.layerToClient(...pv.pdfToLayer(...pdf));
    if (
      x < rect.left ||
      y < rect.top ||
      x > rect.left + scroller.clientWidth ||
      y > rect.top + scroller.clientHeight
    ) {
      x = rect.left + scroller.clientWidth / 2;
      y = rect.top + scroller.clientHeight / 2;
    }
    return { pv, pdf, clientX: x, clientY: y };
  }
  /** Nächste/vorige Zoomstufe; Anker: Mausposition, sonst Auswahl, sonst Fenstermitte. */
  zoomStep(dir, anchor) {
    let idx = ZOOM_LEVELS.findIndex((i) => i >= this.zoom - 0.001);
    if (idx < 0) idx = ZOOM_LEVELS.length - 1;
    if (dir > 0) idx = ZOOM_LEVELS[idx] > this.zoom + 0.001 ? idx : idx + 1;
    else idx = idx - 1;
    this.setZoom(
      ZOOM_LEVELS[Math.max(0, Math.min(ZOOM_LEVELS.length - 1, idx))],
      null,
      false,
      anchor || this.selectionAnchor(),
    );
  }
  /**
   * Stufenloses Zoomen um `factor` (Touchpad-Pinch). Mehrere Ereignisse je Bildschirmbild werden
   * zusammengefasst; gerendert wird erst nach einer kurzen Pause.
   */
  zoomBy(factor, anchor) {
    if (!this.session) return;
    this.pinch = this.pinch || { zoom: this.zoom, frame: 0 };
    this.pinch.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.pinch.zoom * factor));
    this.pinch.anchor = anchor;
    if (this.pinch.frame) return;
    this.pinch.frame = requestAnimationFrame(() => {
      const { zoom, anchor: at } = this.pinch;
      this.pinch = null;
      this.setZoom(zoom, null, false, at, { live: true });
    });
  }
  /** Zoomt so, dass die Auswahl das Fenster mit etwas Rand füllt (höchstens MAX_ZOOM). */
  zoomToSelection() {
    const anchor = this.selectionAnchor();
    if (!anchor) {
      toast('Zuerst ein Element auswählen (Bearbeiten-Modus).');
      return;
    }
    const box = this.edit.selBox();
    const rotated = anchor.pv.rot % 180 !== 0;
    const w = Math.max(1e-3, rotated ? box[3] - box[1] : box[2] - box[0]);
    const h = Math.max(1e-3, rotated ? box[2] - box[0] : box[3] - box[1]);
    const scroller = $('#scroller');
    const zoom = Math.min(
      (scroller.clientWidth * SELECTION_FILL) / (w * CSS_PX_PER_PT),
      (scroller.clientHeight * SELECTION_FILL) / (h * CSS_PX_PER_PT),
    );
    const rect = scroller.getBoundingClientRect();
    anchor.clientX = rect.left + scroller.clientWidth / 2;
    anchor.clientY = rect.top + scroller.clientHeight / 2;
    this.setZoom(zoom, null, true, anchor);
  }
  /** Zoom-Menü: Eingabefeld für eigene Werte, Voreinstellungen, Anpassen. */
  zoomMenu(anchorEl) {
    const hasSel = this.edit.active && this.edit.hasSelection();
    const menu = showMenu(
      [
        ...ZOOM_PRESETS.map((zoom) => ({
          label: formatZoom(zoom),
          key: zoom === 1 ? 'Strg+1' : undefined,
          run: () => this.setZoom(zoom, null, false, this.selectionAnchor()),
        })),
        '-',
        { label: 'Seitenbreite', icon: 'fitw', key: 'Strg+0', run: () => this.setZoom(null, 'width') },
        { label: 'Ganze Seite', icon: 'fitp', run: () => this.setZoom(null, 'page') },
        { label: 'Auf Auswahl zoomen', key: 'Strg+2', disabled: !hasSel, run: () => this.zoomToSelection() },
      ],
      anchorEl,
    );
    const row = htmlToElement(
      '<label class="zin"><input type="text" inputmode="decimal" autocomplete="off" spellcheck="false" aria-label="Zoom in Prozent"><span>%</span></label>',
    );
    const input = row.querySelector('input');
    input.value = String(Math.round(this.zoom * 100));
    input.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') {
        const value = parseFloat(
          input.value
            .replace(/[^\d,.]/g, '')
            .replace(/\.(?=\d{3}(\D|$))/g, '')
            .replace(',', '.'),
        );
        if (value > 0) {
          closeMenu();
          this.setZoom(value / 100, null, false, this.selectionAnchor());
        } else input.select();
      } else if (ev.key === 'Escape') closeMenu();
    });
    menu.insertBefore(row, menu.firstChild);
    menu.insertBefore(document.createElement('hr'), row.nextSibling);
    input.focus();
    input.select();
  }
  goto(index) {
    if (!this.pvs.length) return;
    index = Math.max(0, Math.min(this.pvs.length - 1, index));
    if (this.tool === 'organize') {
      this.org.reveal(index);
      return;
    }
    const scroller = $('#scroller');
    scroller.scrollTop = this.pvs[index].el.offsetTop - 16;
    this.setCur(index);
  }
  onScroll() {
    this.detail.schedule();
    const scroller = $('#scroller');
    const probeY = scroller.scrollTop + scroller.clientHeight * 0.35;
    let current = 0;
    for (let k = 0; k < this.pvs.length && this.pvs[k].el.offsetTop <= probeY; k++) current = k;
    this.setCur(current);
  }
  setCur(index) {
    if (
      index === this.cur &&
      $('#pgIn').value === String(index + 1) &&
      this._curKey === (this.pvs[index] && this.pvs[index].key)
    )
      return;
    this._curKey = this.pvs[index] && this.pvs[index].key;
    this.cur = index;
    $('#pgIn').value = index + 1;
    $$('.th').forEach((i) =>
      i.classList.toggle('cur', i.dataset.key === (this.pvs[index] && this.pvs[index].key)),
    );
    const thumb = $(`.th[data-key="${this.pvs[index] && this.pvs[index].key}"]`);
    if (thumb && !$('#right').classList.contains('collapsed')) {
      const thumbs = $('#thumbs');
      if (
        thumb.offsetTop < thumbs.scrollTop ||
        thumb.offsetTop + thumb.offsetHeight > thumbs.scrollTop + thumbs.clientHeight
      )
        thumbs.scrollTop = thumb.offsetTop - 40;
    }
  }
  async setTool(name) {
    await this.edit.finishEdit();
    const prev = this.tool;
    this.tool = name;
    if (prev === 'edit' && name !== 'edit') this.edit.leave();
    if (prev === 'organize' && name !== 'organize') this.org.leave();
    $('#scroller').classList.toggle('hidden', name === 'organize');
    $('#org').classList.toggle('hidden', name !== 'organize');
    $('#nav').classList.toggle('hidden', !this.session || name === 'organize');
    $('#rFonts').classList.toggle('on', name === 'fonts');
    $('#left').classList.remove('collapsed');
    if (name === 'edit') this.edit.enter();
    else if (name === 'organize') this.org.enter();
    else if (name === 'fonts') {
      $('#ctx').classList.add('hidden');
      this.fontsPanel.show();
    } else {
      $('#ctx').classList.add('hidden');
      this.toolList();
    }
    if (this.session && this.fit && name !== 'organize')
      requestAnimationFrame(() => this.setZoom(null, this.fit, true));
  }
  panel(title, withBack = true) {
    $('#lpHead').innerHTML =
      (withBack ? `<button class="btn ic" id="lpBack" title="Alle Werkzeuge">${icon('back')}</button>` : '') +
      `<span>${escapeHtml(title)}</span>`;
    if (withBack) $('#lpBack').addEventListener('click', () => this.setTool(null));
    const body = $('#lpBody');
    body.innerHTML = '';
    return body;
  }
  toolList() {
    const body = this.panel('Alle Werkzeuge', false);
    const tools = [
      ['edit', 'c1', 'edit', 'PDF bearbeiten', 'Texte, Bilder und Grafiken ändern'],
      ['organize', 'c2', 'pages', 'Seiten organisieren', 'Einfügen, löschen, drehen, ordnen'],
      ['addtext', 'c4', 'textbox', 'Text hinzufügen', 'Neues Textfeld auf der Seite'],
      ['addimage', 'c3', 'image', 'Bild hinzufügen', 'PNG oder JPG einfügen'],
      ['insert', 'c6', 'pageadd', 'Seiten einfügen', 'Leere Seite oder aus Datei'],
      ['fonts', 'c5', 'fonts', 'Schriften', 'Im Dokument verwendete Schriften'],
    ];
    for (const [id, color, iconName, title, desc] of tools) {
      const btn = htmlToElement(
        `<button class="tool"><span class="ti ${color}">${icon(iconName)}</span><span><div class="tt">${escapeHtml(title)}</div><div class="td">${escapeHtml(desc)}</div></span></button>`,
      );
      btn.addEventListener('click', async () => {
        if (id === 'addtext') {
          await this.setTool('edit');
          this.edit.arm('text');
        } else if (id === 'addimage') {
          await this.setTool('edit');
          this.edit.pickImage();
        } else if (id === 'insert') {
          await this.setTool('organize');
          this.org.insertMenu(null);
        } else this.setTool(id);
      });
      body.appendChild(btn);
    }
    body.appendChild(
      htmlToElement(
        `<div class="note info" style="margin-top:16px">${icon('info', 's')} <b>Tipp:</b> Mit <kbd>Strg</kbd> + Mausrad zoomen, mit <kbd>Strg</kbd>+<kbd>Z</kbd> jede Änderung rückgängig machen.</div>`,
      ),
    );
  }
  finishEdit() {
    return this.edit.finishEdit();
  }
  toast(message, kind) {
    return toast(message, kind);
  }
  toggleBold() {
    return this.edit.toggleBold();
  }
  onEditorSelection() {
    return this.edit.onEditorSelection();
  }
  showMissing(editor, missing) {
    return this.edit.showMissing(editor, missing);
  }
  onKey(ev) {
    const target = ev.target;
    const inField = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
    const mod = ev.ctrlKey || ev.metaKey;
    const key = ev.key.toLowerCase();
    if (mod && key === 'o') {
      ev.preventDefault();
      this.openDialog();
      return;
    }
    if (this.session) {
      if (mod && key === 's') {
        ev.preventDefault();
        if (ev.shiftKey) this.saveAs();
        else this.save();
        return;
      }
      if (!inField && !document.querySelector('.backdrop')) {
        if (mod && key === 'z' && !ev.shiftKey) {
          ev.preventDefault();
          this.undo();
          return;
        }
        if (mod && (key === 'y' || (key === 'z' && ev.shiftKey))) {
          ev.preventDefault();
          this.redo();
          return;
        }
        if (mod && (key === '+' || key === '=')) {
          ev.preventDefault();
          this.zoomStep(1);
          return;
        }
        if (mod && key === '-') {
          ev.preventDefault();
          this.zoomStep(-1);
          return;
        }
        if (mod && key === '0') {
          ev.preventDefault();
          this.setZoom(null, 'width');
          return;
        }
        if (mod && !ev.shiftKey && !ev.altKey && key === '1') {
          ev.preventDefault();
          this.setZoom(1, null, false, this.selectionAnchor());
          return;
        }
        if (mod && !ev.shiftKey && !ev.altKey && key === '2') {
          ev.preventDefault();
          this.zoomToSelection();
          return;
        }
        if (!(
          (this.tool === 'edit' && this.edit.onKey(ev)) ||
          (this.tool === 'organize' && this.org.onKey(ev))
        )) {
          if (key === 'home' && !this.edit.hasSelection()) {
            ev.preventDefault();
            this.goto(0);
          }
          if (key === 'end' && !this.edit.hasSelection()) {
            ev.preventDefault();
            this.goto(this.pvs.length - 1);
          }
          if (key === 'pagedown' && !this.edit.hasSelection()) {
            ev.preventDefault();
            this.goto(this.cur + 1);
          }
          if (key === 'pageup' && !this.edit.hasSelection()) {
            ev.preventDefault();
            this.goto(this.cur - 1);
          }
        }
      }
    }
  }
}

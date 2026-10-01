/**
 * Modus "Seiten organisieren": Raster, Einfügen, Löschen, Drehen, Sortieren, Export.
 */
import { PDFDocument } from 'pdf-lib';
import { icon } from './icons.js';
import { $, $$, escapeHtml, htmlToElement } from './dom.js';
import { showMenu } from './menu.js';
import { downloadBytes, pickFiles, showDialog, toast, withBusy } from './dialogs.js';
import {
  copyRunningElements,
  detectPageStructure,
  formatPageNumber,
  updatePageNumbers,
} from '../pdf/page-numbers.js';

const THUMB_SIZE = 150;

export class OrganizeMode {
  constructor(app) {
    this.app = app;
    this.selected = new Set();
    this.active = false;
    this.autoPN = true;
    this.copyHF = true;
    this.cards = new Map();
  }
  get session() {
    return this.app.session;
  }
  reset() {
    this.selected.clear();
    this.cards.clear();
    this.active = false;
    this.detected = null;
    const org = $('#org');
    if (org) org.innerHTML = '';
  }
  enter() {
    this.active = true;
    const ctx = $('#ctx');
    ctx.classList.remove('hidden');
    ctx.innerHTML = `<span class="title">Seiten organisieren</span>
      <button class="btn" id="oIns">${icon('pageadd', 's')}Einfügen ${icon('chev', 's caret')}</button>
      <div class="sep"></div>
      <button class="btn ic" id="oRotL" title="Nach links drehen">${icon('rotl')}</button>
      <button class="btn ic" id="oRotR" title="Nach rechts drehen">${icon('rotr')}</button>
      <button class="btn ic" id="oDup" title="Duplizieren">${icon('dup')}</button>
      <button class="btn ic" id="oDel" title="Löschen (Entf)">${icon('trash')}</button>
      <button class="btn" id="oExp" title="Ausgewählte Seiten als eigene PDF-Datei speichern">${icon('download', 's')}Als PDF speichern</button>
      <span class="chip" id="oInfo"></span>
      <div class="grow"></div>
      <button class="btn outline" id="oDone">${icon('check', 's')}Fertig</button>`;
    $('#oIns').addEventListener('click', (ev) => this.insertMenu(ev.currentTarget));
    $('#oRotL').addEventListener('click', () => this.rotate(-90));
    $('#oRotR').addEventListener('click', () => this.rotate(90));
    $('#oDup').addEventListener('click', () => this.duplicate());
    $('#oDel').addEventListener('click', () => this.remove());
    $('#oExp').addEventListener('click', () => this.extract());
    $('#oDone').addEventListener('click', () => this.app.setTool(null));
    if (!this.selected.size && this.app.pvs[this.app.cur]) this.selected.add(this.app.pvs[this.app.cur].key);
    this.renderGrid();
    this.panel();
    this.ensureDetected().then(() => this.panel());
  }
  leave() {
    this.active = false;
  }
  afterSync() {
    if (this.active) {
      this.renderGrid();
      this.panel();
    }
  }
  async ensureDetected() {
    if (this.detected) return this.detected;
    await new Promise((e) => setTimeout(e, 30));
    try {
      this.detected = detectPageStructure(this.session);
    } catch (err) {
      console.warn(err);
      this.detected = { pageNumbers: null, running: [] };
    }
    return this.detected;
  }
  panel() {
    if (!this.active) return;
    const body = this.app.panel('Seiten organisieren');
    const detected = this.detected;
    const insertSection = htmlToElement('<div class="sec"><h4>Seiten einfügen</h4></div>');
    body.appendChild(insertSection);
    const blankBtn = htmlToElement(`<button class="btn big">${icon('pageadd')}Leere Seite …</button>`);
    blankBtn.addEventListener('click', () => this.blankDialog(this.insertPos()));
    const fileBtn = htmlToElement(`<button class="btn big">${icon('filein')}Aus PDF-Datei …</button>`);
    fileBtn.addEventListener('click', () => this.insertFromFile(this.insertPos()));
    insertSection.append(blankBtn, fileBtn);
    const pnSection = htmlToElement('<div class="sec"><h4>Seitenzahlen</h4></div>');
    body.appendChild(pnSection);
    if (!detected) pnSection.appendChild(htmlToElement('<p class="hint">Dokument wird untersucht …</p>'));
    else if (detected.pageNumbers) {
      const pageNumbers = detected.pageNumbers;
      const label = formatPageNumber(pageNumbers, 1, this.session.numPages);
      pnSection.appendChild(
        htmlToElement(
          `<p class="hint">Erkannt: Seitenzahlen im Format <b>„${escapeHtml(label)}“</b> (${pageNumbers.align === 'right' ? 'rechtsbündig' : pageNumbers.align === 'left' ? 'linksbündig' : 'zentriert'}).</p>`,
        ),
      );
      const autoToggle = htmlToElement(
        `<label class="row" style="cursor:pointer;margin-top:6px"><input type="checkbox" ${this.autoPN ? 'checked' : ''} style="accent-color:var(--acc)"> <span>Automatisch anpassen</span></label>`,
      );
      autoToggle.querySelector('input').addEventListener('change', (ev) => {
        this.autoPN = ev.target.checked;
      });
      pnSection.appendChild(autoToggle);
      const updateBtn = htmlToElement(
        `<button class="btn outline" style="margin-top:2px">${icon('pnum', 's')}Jetzt aktualisieren</button>`,
      );
      updateBtn.addEventListener('click', () =>
        this.op('Seitenzahlen aktualisiert', async () => {}, { forcePN: true }),
      );
      pnSection.appendChild(updateBtn);
    } else
      pnSection.appendChild(
        htmlToElement(
          '<p class="hint">Keine Seitenzahlen erkannt. Seiten werden ohne Nummerierung eingefügt.</p>',
        ),
      );
    if (detected && detected.running.length) {
      const hfSection = htmlToElement(
        `<div class="sec"><h4>Kopf- und Fußzeile</h4><p class="hint">Wiederkehrende Elemente erkannt (${detected.running.length}). Neue leere Seiten können sie automatisch übernehmen.</p></div>`,
      );
      body.appendChild(hfSection);
    }
    body.appendChild(
      htmlToElement(
        '<div class="sec"><h4>Bedienung</h4><p class="hint">Klicken wählt eine Seite, <kbd>Strg</kbd>/<kbd>Umschalt</kbd> + Klick mehrere. Seiten zum Umsortieren ziehen. Das <b>+</b> zwischen zwei Seiten fügt dort ein. Doppelklick öffnet die Seite.</p></div>',
      ),
    );
  }
  insertPos() {
    const indices = this.selIdx();
    return indices.length ? indices[indices.length - 1] + 1 : this.session.numPages;
  }
  selIdx() {
    return this.app.pvs.map((pv, t) => (this.selected.has(pv.key) ? t : -1)).filter((e) => e >= 0);
  }
  renderGrid() {
    const org = $('#org');
    if (!this.session) return;
    let grid = org.querySelector('.ogrid');
    if (!grid) {
      org.innerHTML = '';
      grid = htmlToElement('<div class="ogrid"></div>');
      org.appendChild(grid);
      this.wireGrid(grid);
    }
    for (const key of [...this.selected]) if (!this.app.pvByKey.has(key)) this.selected.delete(key);
    const pvs = this.app.pvs;
    const frag = document.createDocumentFragment();
    const gap = (at) => {
      const el = htmlToElement(
        `<div class="ogap" data-at="${at}"><button class="ins" title="Hier Seite einfügen">${icon('plus', 's')}</button></div>`,
      );
      el.querySelector('.ins').addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.insertMenu(ev.currentTarget, at);
      });
      return el;
    };
    pvs.forEach((pv, index) => {
      const cell = htmlToElement('<div class="ocell"></div>');
      cell.appendChild(gap(index));
      let card = this.cards.get(pv.key);
      if (!card) {
        card = htmlToElement(
          `<div class="ocard" data-key="${pv.key}"><div class="tc"><canvas></canvas></div><div class="tn"></div><div class="acts"><button data-a="rl" title="Nach links drehen">${icon('rotl', 's')}</button><button data-a="rr" title="Nach rechts drehen">${icon('rotr', 's')}</button><button data-a="del" title="Löschen">${icon('trash', 's')}</button></div></div>`,
        );
        this.cards.set(pv.key, card);
      }
      const infoRaw = pv.infoRaw;
      const rotated = infoRaw.rotate % 180 !== 0;
      const width = rotated
        ? THUMB_SIZE * Math.max(1, infoRaw.h / infoRaw.w) * (infoRaw.w / infoRaw.h)
        : THUMB_SIZE;
      const height = width * ((rotated ? infoRaw.w : infoRaw.h) / (rotated ? infoRaw.h : infoRaw.w));
      const thumbBox = card.querySelector('.tc');
      thumbBox.style.width = width + 'px';
      thumbBox.style.height = height + 'px';
      card.querySelector('.tn').textContent = 'Seite ' + (index + 1);
      card.classList.toggle('sel', this.selected.has(pv.key));
      cell.appendChild(card);
      if (index === pvs.length - 1) cell.appendChild(gap(index + 1));
      frag.appendChild(cell);
      if (card.dataset.sig !== pv.sig) this.thumb(card, pv);
    });
    grid.replaceChildren(frag);
    const count = this.selected.size;
    const info = $('#oInfo');
    if (info)
      info.textContent = count ? (count === 1 ? '1 Seite ausgewählt' : count + ' Seiten ausgewählt') : '';
    ['oRotL', 'oRotR', 'oDup', 'oDel', 'oExp'].forEach((o) => {
      const btn = $('#' + o);
      if (btn) btn.disabled = !count;
    });
  }
  thumb(card, pv) {
    card.dataset.sig = pv.sig;
    const canvas = card.querySelector('canvas');
    const infoRaw = pv.infoRaw;
    const rotated = infoRaw.rotate % 180 !== 0;
    const scale = THUMB_SIZE / (rotated ? infoRaw.h : infoRaw.w);
    canvas.style.width = THUMB_SIZE + 'px';
    this.chain = (this.chain || Promise.resolve())
      .then(() =>
        this.app.pvByKey.get(pv.key) === pv
          ? this.app.renderer.render(pv.index, canvas, scale, { maxPx: 600000 })
          : false,
      )
      .catch(() => {
        card.dataset.sig = '';
      });
  }
  wireGrid(grid) {
    grid.addEventListener('click', (ev) => {
      const card = ev.target.closest('.ocard');
      if (!card) {
        if (!ev.target.closest('.ogap')) {
          this.selected.clear();
          this.renderGrid();
        }
        return;
      }
      const actionBtn = ev.target.closest('.acts button');
      const key = card.dataset.key;
      if (actionBtn) {
        ev.stopPropagation();
        this.selected = new Set([key]);
        if (actionBtn.dataset.a === 'rl') this.rotate(-90);
        else if (actionBtn.dataset.a === 'rr') this.rotate(90);
        else this.remove();
        return;
      }
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      if (ev.shiftKey && this.anchor) {
        const keys = this.app.pvs.map((pv) => pv.key);
        const from = keys.indexOf(this.anchor);
        const to = keys.indexOf(key);
        this.selected = new Set(keys.slice(Math.min(from, to), Math.max(from, to) + 1));
      } else if (ev.ctrlKey || ev.metaKey) {
        if (this.selected.has(key)) this.selected.delete(key);
        else this.selected.add(key);
        this.anchor = key;
      } else {
        this.selected = new Set([key]);
        this.anchor = key;
      }
      this.renderGrid();
    });
    grid.addEventListener('dblclick', (ev) => {
      const card = ev.target.closest('.ocard');
      if (!card) return;
      const pv = this.app.pvByKey.get(card.dataset.key);
      this.app.setTool(null).then(() => this.app.goto(pv.index));
    });
    grid.addEventListener('contextmenu', (ev) => {
      const card = ev.target.closest('.ocard');
      if (card) {
        ev.preventDefault();
        if (!this.selected.has(card.dataset.key)) {
          this.selected = new Set([card.dataset.key]);
          this.renderGrid();
        }
        this.pageMenu(this.app.pvByKey.get(card.dataset.key).index, { x: ev.clientX, y: ev.clientY });
      }
    });
    grid.addEventListener('pointerdown', (ev) => {
      const card = ev.target.closest('.ocard');
      if (!card || ev.button !== 0 || ev.target.closest('.acts')) return;
      const clientX = ev.clientX;
      const clientY = ev.clientY;
      let dragging = false;
      let dropGap = null;
      const onMove = (moveEv) => {
        if (!dragging) {
          if (Math.hypot(moveEv.clientX - clientX, moveEv.clientY - clientY) < 6) return;
          dragging = true;
          if (!this.selected.has(card.dataset.key)) {
            this.selected = new Set([card.dataset.key]);
            this.renderGrid();
          }
          $$('.ocard').forEach((I) => I.classList.toggle('dragging', this.selected.has(I.dataset.key)));
        }
        let nearest = null;
        let nearestDist = Infinity;
        for (const gapEl of $$('.ogap', grid)) {
          const gapRect = gapEl.getBoundingClientRect();
          const cx = gapRect.left + gapRect.width / 2;
          const cy = gapRect.top + gapRect.height / 2;
          const dist = Math.abs(moveEv.clientX - cx) + Math.abs(moveEv.clientY - cy) * 1.5;
          if (dist < nearestDist) {
            nearestDist = dist;
            nearest = gapEl;
          }
        }
        $$('.ogap.drop', grid).forEach((I) => I.classList.remove('drop'));
        if (nearest) nearest.classList.add('drop');
        dropGap = nearest;
        const org = $('#org');
        const orgRect = org.getBoundingClientRect();
        if (moveEv.clientY < orgRect.top + 40) org.scrollTop -= 12;
        else if (moveEv.clientY > orgRect.bottom - 40) org.scrollTop += 12;
      };
      const onUp = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        if (
          !dragging ||
          ((this.suppressClick = true),
          setTimeout(() => {
            this.suppressClick = false;
          }, 50),
          $$('.ocard').forEach((u) => u.classList.remove('dragging')),
          $$('.ogap.drop', grid).forEach((u) => u.classList.remove('drop')),
          !dropGap)
        )
          return;
        const at = +dropGap.dataset.at;
        const indices = this.selIdx();
        if (!(indices.length === 1 && (at === indices[0] || at === indices[0] + 1)))
          this.op(indices.length > 1 ? 'Seiten verschoben' : 'Seite verschoben', async () =>
            this.session.movePages(indices, at),
          );
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  }
  reveal(index) {
    const pv = this.app.pvs[index];
    if (!pv) return;
    this.selected = new Set([pv.key]);
    this.renderGrid();
    const card = this.cards.get(pv.key);
    if (card) card.scrollIntoView({ block: 'nearest' });
  }
  insertMenu(anchor, at) {
    if (at == null) at = this.session ? this.insertPos() : 0;
    if (anchor)
      showMenu(
        [
          { label: 'Leere Seite …', icon: 'pageadd', run: () => this.blankDialog(at) },
          { label: 'Aus PDF-Datei …', icon: 'filein', run: () => this.insertFromFile(at) },
        ],
        anchor,
      );
    else this.blankDialog(at);
  }
  pageMenu(index, at) {
    showMenu(
      [
        { label: 'Leere Seite davor einfügen', icon: 'pageadd', run: () => this.blankDialog(index) },
        { label: 'Leere Seite danach einfügen', icon: 'pageadd', run: () => this.blankDialog(index + 1) },
        {
          label: 'Seiten aus Datei danach einfügen …',
          icon: 'filein',
          run: () => this.insertFromFile(index + 1),
        },
        '-',
        { label: 'Nach rechts drehen', icon: 'rotr', run: () => this.withSel(index, () => this.rotate(90)) },
        { label: 'Nach links drehen', icon: 'rotl', run: () => this.withSel(index, () => this.rotate(-90)) },
        { label: 'Duplizieren', icon: 'dup', run: () => this.withSel(index, () => this.duplicate()) },
        {
          label: 'Als PDF speichern …',
          icon: 'download',
          run: () => this.withSel(index, () => this.extract()),
        },
        '-',
        {
          label: 'Löschen',
          icon: 'trash',
          disabled: this.session.numPages < 2,
          run: () => this.withSel(index, () => this.remove()),
        },
      ],
      at,
    );
  }
  withSel(index, fn) {
    const key = this.app.pvs[index].key;
    if (!this.active || !this.selected.has(key)) this.selected = new Set([key]);
    return fn();
  }
  async op(label, fn, opts = {}) {
    await this.app.edit.finishEdit();
    const session = this.session;
    const detected = await this.ensureDetected();
    let renumbered = 0;
    await withBusy(async () => {
      await session.batch(label, async () => {
        const result = await fn();
        if (detected.pageNumbers && (this.autoPN || opts.forcePN))
          renumbered = await updatePageNumbers(session, detected.pageNumbers, {
            addTo: (result && result.addTo) || new Set(),
          });
      });
      await this.app.sync();
    });
    if (renumbered && label !== 'Seitenzahlen aktualisiert') toast(label + ' – Seitenzahlen angepasst');
    else if (opts.forcePN)
      toast(renumbered ? 'Seitenzahlen aktualisiert' : 'Seitenzahlen sind bereits aktuell');
    this.renderGrid();
    this.panel();
  }
  async blankDialog(at) {
    const session = this.session;
    const detected = await this.ensureDetected();
    const numPages = session.numPages;
    const likeIndex = Math.max(0, Math.min(numPages - 1, at - 1));
    const info = session.pageInfo(likeIndex);
    const toMm = (pt) => Math.round((pt / 72) * 25.4);
    const el = htmlToElement(`<div>
      <div class="fr"><span>Position</span><select class="fld" name="pos">${Array.from({ length: numPages + 1 }, (h, u) => `<option value="${u}" ${u === at ? 'selected' : ''}>${u === 0 ? 'Am Anfang' : u === numPages ? 'Am Ende (nach Seite ' + numPages + ')' : 'Nach Seite ' + u}</option>`).join('')}</select></div>
      <div class="fr"><span>Anzahl</span><input class="fld" name="cnt" type="number" min="1" max="50" value="1" style="width:80px"></div>
      <div class="fr"><span>Format</span><select class="fld" name="fmt"><option value="like">Wie benachbarte Seite (${toMm(info.w)} × ${toMm(info.h)} mm)</option><option value="a4p">A4 Hochformat</option><option value="a4l">A4 Querformat</option><option value="ltr">US Letter</option></select></div>
      ${detected.running.length ? `<label class="ck"><input type="checkbox" name="hf" ${this.copyHF ? 'checked' : ''}><span>Kopf- und Fußzeile übernehmen<small>Wiederkehrende Texte und Linien der Nachbarseite werden auf die neue Seite kopiert.</small></span></label>` : ''}
      ${detected.pageNumbers ? `<label class="ck"><input type="checkbox" name="pn" ${this.autoPN ? 'checked' : ''}><span>Seitenzahlen anpassen<small>Alle Seitenzahlen („${escapeHtml(formatPageNumber(detected.pageNumbers, 1, numPages + 1))}“) werden neu nummeriert.</small></span></label>` : ''}
    </div>`);
    const choice = await showDialog({
      title: 'Leere Seite einfügen',
      icon: 'pageadd',
      body: el,
      buttons: [
        { label: 'Abbrechen', value: null },
        {
          label: 'Einfügen',
          primary: true,
          value: (body) => ({
            pos: +body.querySelector('[name=pos]').value,
            cnt: Math.max(1, Math.min(50, parseInt(body.querySelector('[name=cnt]').value, 10) || 1)),
            fmt: body.querySelector('[name=fmt]').value,
            hf: !!(body.querySelector('[name=hf]') || {}).checked,
            pn: !!(body.querySelector('[name=pn]') || {}).checked,
          }),
        },
      ],
    });
    if (!choice) return;
    this.copyHF = choice.hf;
    if (detected.pageNumbers) this.autoPN = choice.pn;
    const formats = { a4p: [595.28, 841.89], a4l: [841.89, 595.28], ltr: [612, 792] };
    await this.op(
      choice.cnt > 1 ? choice.cnt + ' leere Seiten eingefügt' : 'Leere Seite eingefügt',
      async () => {
        const newKeys = new Set();
        const neighbourIndex = Math.max(
          0,
          Math.min(session.numPages - 1, choice.pos - 1 < 0 ? 0 : choice.pos - 1),
        );
        const info2 = session.pageInfo(neighbourIndex);
        const size = choice.fmt === 'like' ? [info2.media.width, info2.media.height] : formats[choice.fmt];
        for (let k = 0; k < choice.cnt; k++) {
          const insertAt = choice.pos + k;
          session.pagesEntry('Leere Seite eingefügt', () => session.doc.insertPage(insertAt, size));
          const key = session.page(insertAt).ref.toString();
          newKeys.add(key);
          const neighbour = insertAt > 0 ? insertAt - 1 : insertAt + 1;
          if (choice.hf && detected.running.length && neighbour < session.numPages) {
            const source =
              neighbour === insertAt - 1
                ? this.firstNonNew(insertAt - 1, newKeys, -1)
                : this.firstNonNew(insertAt + 1, newKeys, 1);
            if (source != null) await copyRunningElements(session, detected.running, source, insertAt);
          }
        }
        this.selected = new Set(newKeys);
        return { addTo: choice.pn ? newKeys : new Set() };
      },
    );
  }
  firstNonNew(index, newKeys, step) {
    const session = this.session;
    while (index >= 0 && index < session.numPages) {
      if (!newKeys.has(session.page(index).ref.toString())) return index;
      index += step;
    }
    return null;
  }
  async insertFromFile(at) {
    const file = await pickFiles('.pdf,application/pdf', true);
    if (file && file.length) return this.insertFiles(file, at);
  }
  async insertFiles(files, at) {
    if (this.app.tool !== 'organize') await this.app.setTool('organize');
    if (at == null) at = this.insertPos();
    const sources = [];
    for (const file of files)
      sources.push({ name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
    let total = 0;
    for (const src of sources)
      try {
        const doc = await PDFDocument.load(src.bytes, { updateMetadata: false });
        if (doc.isEncrypted) throw new Error('enc');
        src.n = doc.getPageCount();
        total += src.n;
      } catch {
        showDialog({
          title: 'Einfügen nicht möglich',
          icon: 'warn',
          body: `„${escapeHtml(src.name)}“ ist keine lesbare PDF-Datei (beschädigt oder kennwortgeschützt).`,
        });
        return;
      }
    const detected = await this.ensureDetected();
    const numPages = this.session.numPages;
    const el = htmlToElement(`<div>
      <p style="margin:0 0 8px">${total === 1 ? '1 Seite' : total + ' Seiten'} aus ${sources.length === 1 ? '„' + escapeHtml(sources[0].name) + '“' : sources.length + ' Dateien'}.</p>
      <div class="fr"><span>Einfügen</span><select class="fld" name="pos">${Array.from({ length: numPages + 1 }, (l, c) => `<option value="${c}" ${c === at ? 'selected' : ''}>${c === 0 ? 'Am Anfang' : c === numPages ? 'Am Ende (nach Seite ' + numPages + ')' : 'Nach Seite ' + c}</option>`).join('')}</select></div>
      ${detected.pageNumbers ? `<label class="ck"><input type="checkbox" name="pn" ${this.autoPN ? 'checked' : ''}><span>Seitenzahlen anpassen<small>Die Seitenzahlen dieses Dokuments werden neu nummeriert.</small></span></label>` : ''}
    </div>`);
    const choice = await showDialog({
      title: 'Seiten einfügen',
      icon: 'filein',
      body: el,
      buttons: [
        { label: 'Abbrechen', value: null },
        {
          label: 'Einfügen',
          primary: true,
          value: (body) => ({
            pos: +body.querySelector('[name=pos]').value,
            pn: !!(body.querySelector('[name=pn]') || {}).checked,
          }),
        },
      ],
    });
    if (choice) {
      at = choice.pos;
      if (detected.pageNumbers) this.autoPN = choice.pn;
      try {
        let inserted = 0;
        await this.op(
          files.length > 1
            ? 'Seiten aus ' + files.length + ' Dateien eingefügt'
            : 'Seiten aus „' + files[0].name + '“ eingefügt',
          async () => {
            let insertAt = at;
            const newKeys = new Set();
            for (const src of sources) {
              const count = await this.session.insertFromPdf(insertAt, src.bytes);
              for (let k = 0; k < count; k++) newKeys.add(this.session.page(insertAt + k).ref.toString());
              insertAt += count;
              inserted += count;
            }
            this.selected = newKeys;
            return { addTo: new Set() };
          },
        );
        toast(inserted === 1 ? '1 Seite eingefügt' : inserted + ' Seiten eingefügt');
      } catch (err) {
        console.error(err);
        showDialog({
          title: 'Einfügen nicht möglich',
          icon: 'warn',
          body: 'Die Datei konnte nicht gelesen werden (beschädigt oder geschützt).',
        });
      }
    }
  }
  async rotate(delta) {
    const indices = this.selIdx();
    if (indices.length) {
      await this.app.edit.finishEdit();
      await withBusy(async () => {
        this.session.rotatePages(indices, delta);
        await this.app.sync();
      });
      this.renderGrid();
    }
  }
  async duplicate() {
    const indices = this.selIdx();
    if (indices.length)
      await this.op(indices.length > 1 ? 'Seiten dupliziert' : 'Seite dupliziert', async () => {
        const newKeys = new Set();
        for (const index of indices.slice().reverse()) {
          await this.session.duplicatePage(index);
          newKeys.add(this.session.page(index + 1).ref.toString());
        }
        this.selected = newKeys;
        return { addTo: new Set() };
      });
  }
  async remove() {
    const indices = this.selIdx();
    if (!indices.length) return;
    if (indices.length >= this.session.numPages) {
      toast('Mindestens eine Seite muss erhalten bleiben.', 'warn');
      return;
    }
    if (
      indices.length > 1 &&
      !(await showDialog({
        title: indices.length + ' Seiten löschen?',
        icon: 'trash',
        body: 'Die ausgewählten Seiten werden aus dem Dokument entfernt. Sie können dies mit „Rückgängig“ zurücknehmen.',
        buttons: [
          { label: 'Abbrechen', value: false },
          { label: 'Löschen', primary: true, value: true },
        ],
      }))
    )
      return;
    const nextPv = this.app.pvs[Math.min(this.session.numPages - 1, indices[indices.length - 1] + 1)];
    await this.op(
      indices.length > 1 ? 'Seiten gelöscht' : 'Seite gelöscht',
      async () => (this.session.deletePages(indices), { addTo: new Set() }),
    );
    this.selected = new Set(nextPv && this.app.pvByKey.has(nextPv.key) ? [nextPv.key] : []);
    this.renderGrid();
  }
  async extract() {
    const indices = this.selIdx();
    if (!indices.length) return;
    await this.app.edit.finishEdit();
    const bytes = await withBusy(async () => {
      const src = await PDFDocument.load(await this.session.save({ clean: false }), {
        updateMetadata: false,
      });
      const out = await PDFDocument.create();
      (await out.copyPages(src, indices)).forEach((l) => out.addPage(l));
      return out.save({ useObjectStreams: true });
    });
    const contiguous = indices.every((A, s) => s === 0 || A === indices[s - 1] + 1);
    const suffix =
      indices.length === 1
        ? 'Seite_' + (indices[0] + 1)
        : contiguous
          ? 'Seiten_' + (indices[0] + 1) + '-' + (indices[indices.length - 1] + 1)
          : 'Seiten_' + indices.map((A) => A + 1).join(',');
    const filename = this.app.file.name.replace(/\.pdf$/i, '') + '_' + suffix + '.pdf';
    if (window.showSaveFilePicker)
      try {
        const handle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{ description: 'PDF-Dokument', accept: { 'application/pdf': ['.pdf'] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(bytes);
        await writable.close();
        toast('Gespeichert: ' + handle.name);
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    downloadBytes(bytes, filename);
    toast('In den Download-Ordner gespeichert');
  }
  onKey(ev) {
    if (ev.key === 'Delete' || ev.key === 'Backspace') {
      ev.preventDefault();
      this.remove();
      return true;
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'a') {
      ev.preventDefault();
      this.selected = new Set(this.app.pvs.map((pv) => pv.key));
      this.renderGrid();
      return true;
    }
    if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') {
      const indices = this.selIdx();
      const target = indices.length
        ? ev.key === 'ArrowRight'
          ? indices[indices.length - 1] + 1
          : indices[0] - 1
        : 0;
      if (target >= 0 && target < this.app.pvs.length) {
        ev.preventDefault();
        this.reveal(target);
        return true;
      }
    }
    return false;
  }
}

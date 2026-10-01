/**
 * Seitenleiste "Schriften".
 */
import { icon } from './icons.js';
import { htmlToElement } from './dom.js';
import { pickFiles, toast } from './dialogs.js';
import { idbPut } from '../storage/idb.js';

export class FontsPanel {
  constructor(app) {
    this.app = app;
  }
  get fonts() {
    return this.app.session.fonts;
  }
  async show() {
    const body = this.app.panel('Schriften');
    if (!this.app.session) return;
    body.appendChild(
      htmlToElement(
        '<p class="hint" style="margin:2px 4px 12px">Eingebettete Schriften enthalten oft nur die Zeichen, die im Dokument vorkommen. Für neue Zeichen (z. B. „Ü“ oder „Q“) wird die vollständige Schriftdatei verwendet – sofern vorhanden.</p>',
      ),
    );
    const families = this.fonts.list();
    for (const fam of families) {
      const row = htmlToElement(
        '<div class="fontrow"><div class="fn"></div><div class="fs">Aa Bb Cc 0123 äöü</div><div class="st"></div></div>',
      );
      row.querySelector('.fn').textContent = fam.label;
      body.appendChild(row);
      const merged = fam.merged();
      const full = this.fonts.fullFor(fam);
      const status = row.querySelector('.st');
      if (full)
        status.innerHTML = `<span class="badge ok">${icon('check', 's')}Vollständig verfügbar</span> <span class="hint">${full.source === 'mitgeliefert' ? 'mitgeliefert' : 'eigene Datei'}</span>`;
      else if (merged)
        status.innerHTML = `<span class="badge part">Teilmenge · ${merged.uni.size} Zeichen</span>`;
      else if (fam.fonts.some((font) => font.program()))
        status.innerHTML = '<span class="badge part">Eingebettet</span>';
      else status.innerHTML = '<span class="badge warn">Nicht eingebettet</span>';
      if (!full && !fam.std) {
        const loadBtn = htmlToElement(
          `<button class="btn">${icon('fonts', 's')}Schriftdatei laden …</button>`,
        );
        loadBtn.addEventListener('click', () => this.loadFor(fam).then(() => this.show()));
        status.appendChild(document.createElement('br'));
        status.appendChild(loadBtn);
      }
      this.fonts.ensureCss(fam).then(() => {
        row.querySelector('.fs').style.fontFamily = this.fonts.cssStack(fam);
      });
    }
    const addBtn = htmlToElement(
      `<button class="btn outline" style="width:100%;justify-content:center;margin-top:6px">${icon('plus', 's')}Schriftdateien hinzufügen …</button>`,
    );
    addBtn.addEventListener('click', () => this.addFiles());
    body.appendChild(addBtn);
    body.appendChild(
      htmlToElement(
        '<p class="hint" style="margin:10px 4px">Hinzugefügte Schriften (TTF/OTF) merkt sich der PDF-Editor und ordnet sie über den Namen automatisch zu – auch in anderen Dokumenten.</p>',
      ),
    );
  }
  async attach(fam, item) {
    this.fonts.setFull(fam, item);
    try {
      const cssName = 'pdfe-full-' + Math.random().toString(36).slice(2, 8);
      const face = new FontFace(cssName, item.bytes, { weight: '1 1000' });
      await face.load();
      document.fonts.add(face);
      fam.fullCss = cssName;
      this.fonts.byCss.set(cssName, fam);
    } catch {}
    const editor = this.app.edit.editor;
    if (editor)
      for (const span of editor.te.querySelectorAll('span[data-fam]'))
        if (span.dataset.fam === fam.key) span.style.fontFamily = this.fonts.cssStack(fam);
  }
  async loadFor(fam) {
    return this.app.edit.loadFontFor(fam);
  }
  async addFiles() {
    const files = await pickFiles('.ttf,.otf,.woff,font/ttf,font/otf', true);
    if (!files || !files.length) return;
    let added = 0;
    let assigned = 0;
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const item = this.app.library.add(bytes, 'eigene');
        added++;
        idbPut('fonts', item.ps, bytes.buffer.slice(0));
        for (const fam of this.fonts.list())
          if (!fam.full && this.app.library.find(fam.key) === item) {
            await this.attach(fam, item);
            assigned++;
          }
      } catch {
        toast('„' + file.name + '“ ist keine lesbare Schriftdatei.', 'err');
      }
    }
    if (added)
      toast(
        added +
          (added === 1 ? ' Schrift' : ' Schriften') +
          ' hinzugefügt' +
          (assigned ? ` – ${assigned} im Dokument zugeordnet` : ''),
      );
    this.show();
  }
}

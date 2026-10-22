/**
 * Automatische Wiederherstellung der geöffneten PDF: sichert kurz nach jeder Änderung eine Kopie
 * (src/storage/recovery.js) und bietet nach einem unerwarteten Ende beim nächsten Start an, sie
 * wiederherzustellen. Gesichert wird erst, wenn rund 2 s nichts mehr geändert wurde; bei großen
 * Dokumenten seltener (Abstand mindestens das Zehnfache der Dauer einer Sicherung).
 */
import { deleteCopy, loadCopy, orphanCopies, putCopy, windowId } from '../storage/recovery.js';
import { reviveFileHandle } from '../platform/desktop-bridge.js';
import { escapeHtml } from './dom.js';
import { showDialog, toast } from './dialogs.js';

const QUIET = 2000;
const MIN_GAP = 3000;

const when = (time) => {
  const d = new Date(time);
  const today = new Date().toDateString() === d.toDateString();
  const clock = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return today ? `heute, ${clock} Uhr` : `${d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' })}, ${clock} Uhr`;
};

export class Recovery {
  constructor(app) {
    this.app = app;
    this.saved = null; // { session, version } der zuletzt gesicherten Fassung
    this.seen = null; // { session, version, at } zuletzt beobachtete Änderung
    this.pending = null; // laufende Sicherung
    this.lastAt = -Infinity;
    this.gap = MIN_GAP;
    this.more = false; // nach dem Wiederherstellen liegen weitere Kopien bereit
    this.gen = 0; // zählt beim Löschen hoch: ältere Sicherungen schreiben nicht mehr
    setInterval(() => this.tick(), 1000);
  }

  tick() {
    const app = this.app;
    const session = app.session;
    if (!session || !session.dirty) {
      if (this.saved) this.clear();
      return;
    }
    // während einer offenen Textbearbeitung fehlt der Absatz im Dokument: erst danach sichern
    if (this.pending || session.pending || (app.edit && app.edit.editor)) return;
    if (this.saved && this.saved.session === session && this.saved.version === session.version) return;
    const now = performance.now();
    if (!this.seen || this.seen.session !== session || this.seen.version !== session.version) {
      this.seen = { session, version: session.version, at: now };
      return;
    }
    if (now - this.seen.at < QUIET || now - this.lastAt < this.gap) return;
    this.backup();
  }

  /** Kopie der geöffneten PDF jetzt sichern. */
  backup() {
    const app = this.app;
    const session = app.session;
    if (!session || this.pending) return this.pending;
    const version = session.version;
    const gen = this.gen;
    const t0 = performance.now();
    const current = () => app.session === session && session.dirty && this.gen === gen;
    this.pending = (async () => {
      try {
        const bytes = await session.save({ clean: false });
        // während des Sicherns geändert (z. B. Bearbeitung begonnen): verwerfen, später neu
        if (!current() || session.version !== version || session.pending) return;
        await putCopy(windowId, { name: app.file.name, bytes, handle: app.file.handle });
        this.gap = Math.max(MIN_GAP, (performance.now() - t0) * 10);
        if (current()) this.saved = { session, version };
        // inzwischen gespeichert, verworfen oder geschlossen: Kopie gleich wieder weg
        else await deleteCopy(windowId);
      } catch (err) {
        console.warn('Wiederherstellungs-Kopie nicht gesichert', err);
      } finally {
        this.lastAt = performance.now();
        this.pending = null;
      }
    })();
    return this.pending;
  }

  /**
   * Kopie dieses Fensters löschen (gespeichert, verworfen, geschlossen); `closed`: Dokument
   * geschlossen. Eine laufende Sicherung schreibt danach nichts mehr (sofort, auch bei großen PDFs).
   */
  clear(closed = false) {
    this.gen++;
    this.saved = null;
    this.seen = null;
    this.clearing = deleteCopy(windowId).catch(() => {});
    if (closed && this.more) {
      this.more = false;
      setTimeout(() => this.offer(), 300);
    }
    return this.clearing;
  }

  /** Beim Start: Kopien aus einem unerwartet beendeten Fenster anbieten. */
  async offer() {
    let list;
    try {
      list = await orphanCopies();
    } catch {
      return;
    }
    if (!list.length || this.app.session?.dirty) return;
    const rows = list.map((m) => `<li><b>${escapeHtml(m.name)}</b><span class="hint">gesichert ${when(m.time)}</span></li>`).join('');
    const choice = await showDialog({
      title: 'Dokument wiederherstellen',
      icon: 'save',
      body:
        `PlantPDF wurde nicht ordnungsgemäß beendet. Diese ungespeicherten Änderungen wurden automatisch gesichert:<ul class="rec-list">${rows}</ul>` +
        (list.length > 1 ? '<span class="hint">Das neueste wird geöffnet, die übrigen danach angeboten.</span> ' : '') +
        (this.app.session && !this.app.tabHost ? `<span class="hint">„${escapeHtml(this.app.file.name)}“ wird dabei geschlossen.</span>` : ''),
      buttons: [
        { label: 'Später', value: 'later' },
        { label: list.length > 1 ? 'Alle verwerfen' : 'Verwerfen', value: 'discard' },
        { label: 'Wiederherstellen', primary: true, value: 'restore' },
      ],
      cancelValue: 'later',
    });
    if (choice === 'discard') {
      await Promise.all(list.map((m) => deleteCopy(m.id).catch(() => {})));
      toast(list.length > 1 ? 'Die gesicherten Kopien wurden verworfen.' : 'Die gesicherte Kopie wurde verworfen.');
    } else if (choice === 'restore') {
      if ((await this.restore(list[0])) && list.length > 1) this.more = true;
    }
  }

  /** In einem neuen Tab: die Kopie mit dieser Kennung wiederherstellen. */
  async restoreById(id) {
    const meta = (await orphanCopies().catch(() => [])).find((m) => m.id === id);
    if (meta) return this.restore(meta);
    toast('Die gesicherte Kopie ist nicht mehr vorhanden.', 'warn', 4000);
    return false;
  }

  /** Kopie öffnen: ungespeichert, mit Strg+S in die ursprüngliche Datei (falls bekannt). */
  async restore(meta) {
    const app = this.app;
    // Desktop-App mit offenem Dokument: im eigenen Tab wiederherstellen
    if (app.tabHost && app.hasDocument()) {
      await app.tabHost.open({ kind: 'recover', id: meta.id, name: meta.name });
      return true;
    }
    let data;
    try {
      data = await loadCopy(meta.id);
    } catch {
      data = null;
    }
    if (!data || !data.bytes) {
      toast('Die gesicherte Kopie konnte nicht gelesen werden.', 'err', 5000);
      return false;
    }
    if (!(await app.openBytes(data.bytes, meta.name, data.handle ? reviveFileHandle(data.handle) : null))) return false;
    await this.clearing;
    const session = app.session;
    session.savedVersion = -1; // ungespeichert, bis gespeichert wird
    app.updateHist();
    // erst unter diesem Fenster sichern, dann die alte Kopie löschen (nie ohne Kopie)
    await this.backup();
    if (this.saved && this.saved.session === session) await deleteCopy(meta.id).catch(() => {});
    else this.more = true; // Sicherung gescheitert: die alte Kopie bleibt und wird wieder angeboten
    toast(`„${meta.name}“ wiederhergestellt (Stand ${when(meta.time)}). Mit Strg+S speichern.`, '', 7000);
    return true;
  }
}

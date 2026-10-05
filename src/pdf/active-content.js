/**
 * Aktive Inhalte einer PDF (JavaScript, Programmstarts, Formular-Versand, eingebettete Dateien).
 *
 * Der Editor führt nichts davon aus. Beim Speichern würde er es aber unverändert in die neue
 * Datei übernehmen und so an Empfänger weitergeben. `withoutActiveContent` entfernt es nur für
 * die Dauer eines Speichervorgangs und stellt danach alles wieder her (Rückgängig, Neuladen und
 * ein späteres Speichern mit ausgeschaltetem Schalter bleiben unberührt).
 *
 * Bleibt erhalten: Text, Bilder, Grafiken, normale Links (URI/GoTo), Formularfelder, Lesezeichen.
 */
import { PDFArray, PDFDict, PDFName } from 'pdf-lib';

/** Aktionen, die Code ausführen, Programme starten oder Daten versenden. */
const DANGEROUS_ACTIONS = new Set([
  'JavaScript',
  'Launch',
  'SubmitForm',
  'ImportData',
  'GoToE',
  'Rendition',
  'Movie',
  'Sound',
  'RichMediaExecute',
]);

/** Anmerkungen, die selbst Anhänge oder aktive Medien sind. */
const REMOVED_ANNOTATIONS = new Set(['FileAttachment', 'RichMedia', 'Screen', 'Movie', 'Sound', '3D']);

const N = (name) => PDFName.of(name);

/**
 * @param {import('pdf-lib').PDFDocument} doc
 * @param {() => Promise<T>} fn  läuft, solange die aktiven Inhalte entfernt sind
 * @returns {Promise<{ result: T, removed: { scripts: number, programs: number, attachments: number } }>}
 * @template T
 */
export async function withoutActiveContent(doc, fn) {
  const ctx = doc.context;
  const undo = [];
  const removed = { scripts: 0, programs: 0, attachments: 0 };

  const dictOf = (value) => {
    const resolved = ctx.lookup(value);
    return resolved instanceof PDFDict ? resolved : null;
  };

  /** Entfernt einen Eintrag samt Merkzettel zum Wiederherstellen. */
  const removeKey = (dict, name) => {
    const old = dict.get(N(name));
    if (old === undefined) return false;
    dict.delete(N(name));
    undo.push(() => dict.set(N(name), old));
    return true;
  };

  const countAction = (kind) => {
    if (kind === 'JavaScript') removed.scripts++;
    else removed.programs++;
  };

  /** Erste gefährliche Aktion einer Kette (Aktion samt /Next), sonst null. */
  const dangerousKind = (action, seen = new Set()) => {
    const dict = dictOf(action);
    if (!dict || seen.has(dict)) return null;
    seen.add(dict);
    const type = ctx.lookup(dict.get(N('S')));
    const kind = type instanceof PDFName ? type.decodeText() : '';
    if (DANGEROUS_ACTIONS.has(kind)) return kind;
    const next = ctx.lookup(dict.get(N('Next')));
    for (const item of next instanceof PDFArray ? next.asArray() : next ? [next] : []) {
      const found = dangerousKind(item, seen);
      if (found) return found;
    }
    return null;
  };

  /** Aktionen eines Objekts (Anmerkung, Formularfeld, Seite): gefährliches /A, immer /AA. */
  const stripActions = (dict) => {
    const kind = dangerousKind(dict.get(N('A')));
    if (kind && removeKey(dict, 'A')) countAction(kind);
    if (removeKey(dict, 'AA')) removed.scripts++;
  };

  const stripFieldTree = (fields, seen) => {
    if (!(fields instanceof PDFArray)) return;
    for (const entry of fields.asArray()) {
      const dict = dictOf(entry);
      if (!dict || seen.has(dict)) continue;
      seen.add(dict);
      stripActions(dict);
      stripFieldTree(ctx.lookup(dict.get(N('Kids'))), seen);
    }
  };

  /** Anzahl der Dateien in einem Namensbaum (/Names-Paare, /Kids rekursiv). */
  const countTreeLeaves = (node, depth = 0) => {
    const dict = dictOf(node);
    if (!dict || depth > 32) return 0;
    const names = ctx.lookup(dict.get(N('Names')));
    const kids = ctx.lookup(dict.get(N('Kids')));
    return (
      (names instanceof PDFArray ? names.size() / 2 : 0) +
      (kids instanceof PDFArray
        ? kids.asArray().reduce((n, kid) => n + countTreeLeaves(kid, depth + 1), 0)
        : 0)
    );
  };

  try {
    const catalog = doc.catalog;

    // Startaktion: nur Aktionen entfernen, Zielansichten (Seite/Zoom beim Öffnen) bleiben
    const openAction = dictOf(catalog.get(N('OpenAction')));
    const kind = openAction && dangerousKind(openAction);
    if (kind && removeKey(catalog, 'OpenAction')) countAction(kind);
    if (removeKey(catalog, 'AA')) removed.scripts++;
    removeKey(catalog, 'AF'); // verknüpfte Dateien: Verweise auf dieselben Anhänge, nicht doppelt zählen

    const names = dictOf(catalog.get(N('Names')));
    if (names) {
      if (removeKey(names, 'JavaScript')) removed.scripts++;
      const embedded = names.get(N('EmbeddedFiles'));
      if (embedded !== undefined) {
        removed.attachments += countTreeLeaves(embedded) || 1;
        removeKey(names, 'EmbeddedFiles');
      }
    }

    const acroForm = dictOf(catalog.get(N('AcroForm')));
    if (acroForm) {
      if (removeKey(acroForm, 'XFA')) removed.scripts++;
      stripFieldTree(ctx.lookup(acroForm.get(N('Fields'))), new Set());
    }

    for (const page of doc.getPages()) {
      const node = page.node;
      if (removeKey(node, 'AA')) removed.scripts++;
      removeKey(node, 'AF');
      const annots = ctx.lookup(node.get(N('Annots')));
      if (!(annots instanceof PDFArray)) continue;
      for (let index = annots.size() - 1; index >= 0; index--) {
        const entry = annots.get(index);
        const annot = dictOf(entry);
        if (!annot) continue;
        const subtype = ctx.lookup(annot.get(N('Subtype')));
        const name = subtype instanceof PDFName ? subtype.decodeText() : '';
        if (REMOVED_ANNOTATIONS.has(name)) {
          annots.remove(index);
          undo.push(() => annots.insert(index, entry));
          if (name === 'FileAttachment') removed.attachments++;
          else removed.programs++;
        } else stripActions(annot);
      }
    }
    return { result: await fn(), removed };
  } finally {
    // in umgekehrter Reihenfolge, damit Einfügepositionen in Anmerkungslisten wieder stimmen
    for (const restore of undo.reverse()) restore();
  }
}

export const hasRemoved = (removed) => removed.scripts + removed.programs + removed.attachments > 0;

/** Kurzbeschreibung für die Rückmeldung nach dem Speichern, z. B. „1 Skript, 2 Anhänge“. */
export function describeRemoved(removed) {
  const part = (n, one, many) => (n ? `${n} ${n === 1 ? one : many}` : null);
  return [
    part(removed.scripts, 'Skript', 'Skripte'),
    part(removed.programs, 'Programmstart oder Medium', 'Programmstarts oder Medien'),
    part(removed.attachments, 'Anhang', 'Anhänge'),
  ]
    .filter(Boolean)
    .join(', ');
}

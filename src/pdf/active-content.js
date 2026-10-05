/**
 * Aktive Inhalte einer PDF (JavaScript, Programmstarts, Formular-Versand, eingebettete Dateien).
 *
 * Der Editor führt nichts davon aus. Beim Speichern würde er es aber unverändert in die neue
 * Datei übernehmen und so an Empfänger weitergeben. `withoutActiveContent` entfernt es nur für
 * die Dauer eines Speichervorgangs und stellt danach alles wieder her (Rückgängig, Neuladen und
 * ein späteres Speichern mit ausgeschaltetem Schalter bleiben unberührt).
 *
 * Gesucht wird im gesamten Objektgraphen ab dem Katalog (Seiten, Anmerkungen, Formularfelder,
 * Lesezeichen, Strukturbaum …), nicht nur an den bekannten Stellen:
 *  - Aktionen (`/S`) vom Typ JavaScript, Launch, SubmitForm usw. werden dort ausgehängt, wo sie
 *    eingetragen sind (`/A`, `/AA`-Einträge, `/Next`, `/OpenAction`); harmlose Aktionen
 *    (URI, GoTo …) und harmlose Einträge derselben `/AA` bleiben.
 *  - Eingebettete Dateien: `/EF` jeder Dateispezifikation, `/AF` (verknüpfte Dateien), der
 *    Namensbaum `/EmbeddedFiles` und Datei-Anhang-Anmerkungen. Auch wenn eine entfernte Anmerkung
 *    noch über ein Popup oder den Strukturbaum erreichbar ist, enthält sie keine Nutzlast mehr.
 *  - JavaScript-Namensbaum und XFA-Formulare.
 *
 * Bleibt erhalten: Text, Bilder, Grafiken, normale Links (URI/GoTo), Formularfelder, Lesezeichen.
 */
import { PDFArray, PDFDict, PDFName, PDFStream } from 'pdf-lib';

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

/** Tiefste Schachtelung eines Namensbaums beim Zählen (Schutz vor Zyklen). */
const MAX_TREE_DEPTH = 32;

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
  const counted = new Set();

  const dictOf = (value) => {
    const resolved = ctx.lookup(value);
    return resolved instanceof PDFDict ? resolved : null;
  };

  /** Entfernt einen Eintrag samt Merkzettel zum Wiederherstellen. */
  const removeKey = (dict, key) => {
    const name = typeof key === 'string' ? N(key) : key;
    const old = dict.get(name);
    if (old === undefined) return false;
    dict.delete(name);
    undo.push(() => dict.set(name, old));
    return true;
  };

  const removeIndex = (array, index) => {
    const old = array.get(index);
    array.remove(index);
    undo.push(() => array.insert(index, old));
  };

  /** Art der Aktion (`/S`), wenn sie gefährlich ist, sonst null. */
  const dangerousKind = (dict) => {
    const type = dict.get(N('S'));
    const name = type instanceof PDFName ? type.decodeText() : '';
    return DANGEROUS_ACTIONS.has(name) ? name : null;
  };

  /** Zählt eine entfernte Aktion einmal, auch wenn sie von mehreren Stellen aus erreichbar ist. */
  const countAction = (action, kind) => {
    if (counted.has(action)) return;
    counted.add(action);
    if (kind === 'JavaScript') removed.scripts++;
    else removed.programs++;
  };

  /** Anzahl der Dateien in einem Namensbaum (/Names-Paare, /Kids rekursiv). */
  const countTreeLeaves = (node, depth = 0) => {
    const dict = dictOf(node);
    if (!dict || depth > MAX_TREE_DEPTH) return 0;
    const names = ctx.lookup(dict.get(N('Names')));
    const kids = ctx.lookup(dict.get(N('Kids')));
    return (
      (names instanceof PDFArray ? names.size() / 2 : 0) +
      (kids instanceof PDFArray
        ? kids.asArray().reduce((n, kid) => n + countTreeLeaves(kid, depth + 1), 0)
        : 0)
    );
  };

  /** Durchsucht den Objektgraphen ab `root` und hängt gefährliche Aktionen und Dateien aus. */
  const sweep = (root) => {
    const seen = new Set();
    const stack = [root];
    const descend = (value) => {
      const child = ctx.lookup(value);
      if (child instanceof PDFDict || child instanceof PDFArray) stack.push(child);
      else if (child instanceof PDFStream) stack.push(child.dict);
    };
    while (stack.length) {
      const container = stack.pop();
      if (seen.has(container)) continue;
      seen.add(container);
      if (container instanceof PDFArray) {
        for (let index = container.size() - 1; index >= 0; index--) {
          const child = ctx.lookup(container.get(index));
          const kind = child instanceof PDFDict ? dangerousKind(child) : null;
          if (kind) {
            countAction(child, kind);
            removeIndex(container, index);
          } else descend(container.get(index));
        }
        continue;
      }
      // Dateispezifikation mit eingebetteter Datei: Nutzlast aushängen, wo auch immer sie hängt
      if (container.has(N('EF')) && removeKey(container, 'EF')) removed.attachments++;
      for (const [key, value] of [...container.entries()]) {
        if (key.decodeText() === 'AF') {
          removeKey(container, key); // verknüpfte Dateien (Verweise auf dieselben Anhänge)
          continue;
        }
        const child = ctx.lookup(value);
        const kind = child instanceof PDFDict ? dangerousKind(child) : null;
        if (kind) {
          countAction(child, kind);
          removeKey(container, key);
        } else descend(value);
      }
    }
  };

  try {
    const catalog = doc.catalog;

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
    if (acroForm && removeKey(acroForm, 'XFA')) removed.scripts++;

    // Anmerkungen, die selbst Anhänge oder aktive Medien sind, ganz entfernen
    for (const page of doc.getPages()) {
      const annots = ctx.lookup(page.node.get(N('Annots')));
      if (!(annots instanceof PDFArray)) continue;
      for (let index = annots.size() - 1; index >= 0; index--) {
        const annot = dictOf(annots.get(index));
        const subtype = annot && ctx.lookup(annot.get(N('Subtype')));
        const name = subtype instanceof PDFName ? subtype.decodeText() : '';
        if (!REMOVED_ANNOTATIONS.has(name)) continue;
        removeIndex(annots, index);
        if (name === 'FileAttachment') removed.attachments++;
        else removed.programs++;
      }
    }

    sweep(catalog);
    return { result: await fn(), removed };
  } finally {
    // in umgekehrter Reihenfolge, damit Einfügepositionen in Listen wieder stimmen
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

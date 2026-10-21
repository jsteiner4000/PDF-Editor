/**
 * Zugangsdaten: Geräte-Zugänge, Gerätedaten, Netzwerk, WLAN und Fernzugriff als Tabellen im Stil
 * des Klemmenplans (dunkle Kopfzeile, Zeilen im Wechsel hinterlegt). Welche Bereiche und Spalten
 * erscheinen, wählt man je Kunde; leere Spalten entfallen von selbst. Passwörter und Schlüssel
 * erscheinen nur, wenn das für diese Fassung gewählt ist – sonst als Punkte.
 */
import { C, MONO, PAGE, line, rect, text } from './svg.js';
import { ACCESS_BLOCKS, STRINGS, tx } from './model.js';
import { wrap } from './measure.js';

const MASK = '••••••••';

/** Hat ein Bereich Inhalt (Zeilen bzw. Netzwerkangaben)? */
export function blockHasData(section, block) {
  if (block.fields) return block.fields.some((f) => valueText(section.network[f.key], 'de'));
  return (section[block.list] || []).length > 0;
}

const valueText = (v, lang) => (v && typeof v === 'object' ? tx(v, lang) : String(v ?? '')).trim();

/** Zellzeilen: Hauptsprache, bei „Deutsch und Englisch“ darunter die zweite Sprache grau. */
function cellLines(ts, col, value, width, mask) {
  const style = (italic) => ({ family: col.mono ? MONO : ts.font.css, weight: col.bold ? 700 : 400, italic });
  const runs = col.bi ? ts.runs(value) : [{ text: valueText(value, ts.lang), sec: false }].filter((r) => r.text);
  return runs.flatMap((r) => {
    const shown = col.secret && mask ? MASK : r.text;
    return wrap(shown, col.mono ? 8.4 : 8.8, style(r.sec), width).map((t) => ({ text: t, sec: r.sec }));
  });
}

/**
 * Setzt die Zugangsdaten in Seiten: [{ svg, hits }]. Tabellen laufen mit wiederholter Kopfzeile
 * auf Folgeseiten weiter; eine Überschrift steht nie allein am Seitenende.
 */
export function accessPages(section, ts, { top = 132, bottom = PAGE.bottom } = {}) {
  const WIDTH = PAGE.right - PAGE.left - 0.276;
  const pages = [];
  let svg = '';
  let hits = [];
  let y = top;
  const flush = () => {
    pages.push({ svg, hits });
    svg = '';
    hits = [];
    y = top;
  };
  const mask = !section.showPasswords;
  const headH = ts.bi ? 28 : 20;

  const header = (cols) => {
    svg += rect(PAGE.left, y, WIDTH, headH, { fill: C.navy });
    for (const c of cols) {
      svg += text(c.x + 6, y + 13, tx(c.label, ts.lang), { size: 9, weight: 700, fill: '#fff' });
      if (ts.bi && c.label.en !== c.label.de)
        svg += text(c.x + 6, y + 23, c.label.en, { size: 7.5, italic: true, fill: '#c8d3db' });
    }
    y += headH;
  };

  const table = (block, cols, rows, kind) => {
    // weitere Benutzer eines Geräts: eigene Zeilen direkt darunter (nur Benutzer, Passwort, Rolle)
    rows = rows.flatMap((row) => [
      row,
      ...(kind === 'device' && block.id === 'devices' ? (row.users || []).map((u) => ({ ...u, id: row.id, sub: true })) : []),
    ]);
    let band = -1;
    // Spaltenbreiten aus den Anteilen
    const total = cols.reduce((n, c) => n + c.w, 0);
    let x = PAGE.left;
    cols = cols.map((c) => {
      const w = (WIDTH * c.w) / total;
      const out = { ...c, x, w };
      x += w;
      return out;
    });
    if (y + 22 + headH + 16 > bottom && y > top) flush();
    svg += text(PAGE.left, y, ts.inline(block.title), { size: 12, weight: 700 });
    y += 22;
    header(cols);
    rows.forEach((row, i) => {
      // Spalteneigenschaften je Zeile (Netzwerk: technische Werte in Festbreitenschrift)
      const rowCols = cols.map((c) => ({ ...c, mono: c.mono || !!(c.monoFrom && row[c.monoFrom]), bi: c.bi && (!c.biFrom || !!row[c.biFrom]) }));
      const cells = rowCols.map((c) => cellLines(ts, c, row[c.key], c.w - 10, mask));
      const h = 16 + 10.56 * (Math.max(1, ...cells.map((l) => l.length)) - 1);
      if (y + h > bottom) {
        flush();
        header(cols);
      }
      // Unterzeilen behalten die Hinterlegung ihres Geräts
      if (!row.sub) band++;
      if (band % 2 === 0) svg += rect(PAGE.left, y, WIDTH, h, { fill: C.alt });
      cells.forEach((lines, ci) => {
        const c = rowCols[ci];
        lines.forEach((l, k) => {
          svg += text(c.x + 6, y + 11 + 10.56 * k, l.text, {
            size: c.mono ? 8.4 : 8.8,
            weight: c.bold && !l.sec ? 700 : 400,
            italic: l.sec,
            fill: l.sec ? C.muted : c.bold ? C.navy : C.body,
            family: c.mono ? MONO : null,
          });
        });
      });
      const next = rows[i + 1];
      if (!(next && next.sub)) svg += line(PAGE.left, y + h, PAGE.left + WIDTH, y + h, C.rule, 0.5);
      hits.push({ kind, id: row.id, rect: [PAGE.left, y, WIDTH, h] });
      y += h;
    });
    y += 30;
  };

  for (const block of ACCESS_BLOCKS) {
    if (!section.blocks[block.id] || !blockHasData(section, block)) continue;
    if (block.fields) {
      // Netzwerk: zweispaltig „Einstellung – Wert“
      const rows = block.fields
        .filter((f) => valueText(section.network[f.key], 'de'))
        .map((f) => ({ id: f.key, label: f.label, value: section.network[f.key], mono: f.mono, bi: f.bi }));
      const cols = [
        { key: 'label', label: STRINGS.setting, w: 1, bold: true, bi: true },
        { key: 'value', label: STRINGS.value, w: 2.2, bi: true, biFrom: 'bi', monoFrom: 'mono' },
      ];
      table(block, cols, rows, 'network');
      continue;
    }
    const hidden = new Set(section.hide[block.id] || []);
    const rows = section[block.list];
    const filled = (r, c) => valueText(r[c.key], 'de') || valueText(r[c.key], 'en') || (r.users || []).some((u) => valueText(u[c.key], 'de'));
    const cols = block.columns.filter((c) => c.fixed || (!hidden.has(c.key) && rows.some((r) => filled(r, c))));
    table(block, cols, rows, block.list === 'devices' ? 'device' : block.list);
  }

  if (mask && ACCESS_BLOCKS.some((b) => b.columns && b.columns.some((c) => c.secret) && section.blocks[b.id] && hasSecrets(section, b))) {
    if (y + 12 > bottom) flush();
    svg += text(PAGE.left, y - 10, ts.label('secretsHidden'), { size: 8.5, italic: true, fill: C.muted });
  }
  if (svg || !pages.length) pages.push({ svg, hits });
  return pages;
}

function hasSecrets(section, block) {
  return (section[block.list] || []).some((row) =>
    block.columns.some((c) => c.secret && (valueText(row[c.key]) || (row.users || []).some((u) => valueText(u[c.key])))),
  );
}


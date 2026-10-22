/**
 * Datenmodell der Projektmappe („Dokumentation erstellen“).
 *
 * Ein Projekt beschreibt die komplette Kundendokumentation: Firmen- und Projektangaben, Sprache,
 * Schrift und eine geordnete Liste von Abschnitten (Deckblatt, Inhaltsverzeichnis, Anschlussplan,
 * später Lageplan, Fotos, Anleitungskapitel). Aus dem Projekt entstehen die Seiten (render/*) und
 * daraus die PDF; das Projekt selbst wird in der PDF mitgespeichert (export.js).
 *
 * Texte, die der Nutzer eingibt, sind zweisprachig: `{ de, en }` (siehe `tx`). Bilder liegen
 * getrennt in `project.images` (Kennung → { mime, data }), damit der Verlauf (Rückgängig) nur
 * kleine Daten kopiert.
 */

export const MODEL_VERSION = 1;

/** Sprachen eines Dokuments. */
export const LANGS = [
  { id: 'de', label: 'Deutsch' },
  { id: 'en', label: 'Englisch' },
  { id: 'de+en', label: 'Deutsch und Englisch' },
];

/** Schriften der Dokumente (Barlow: wie die Anleitungen; Helvetica: wie der Anschlussplan). */
export const FONTS = [
  { id: 'helvetica', label: 'Helvetica', css: 'Helvetica, Arial, "Liberation Sans", Arimo, sans-serif' },
  { id: 'barlow', label: 'Barlow', css: '"PDFix Barlow", Helvetica, Arial, sans-serif' },
];

let seq = 0;
/** Kurze, eindeutige Kennung (Zufall aus crypto – Math.random bleibt unberührt). */
export const uid = (prefix = 'x') =>
  `${prefix}${Date.now().toString(36)}${(seq++).toString(36)}${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;

/** Zweisprachiger Text. */
export const T = (de = '', en = '') => ({ de, en });

/** Text in der Sprache `lang` ('de' | 'en'); fehlt die Übersetzung, gilt der andere Text. */
export function tx(value, lang = 'de') {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  return (lang === 'en' ? value.en || value.de : value.de || value.en) || '';
}

/** Feste Beschriftungen der Dokumente in beiden Sprachen. */
export const STRINGS = {
  pageOf: T('Seite {n} von {total}', 'Page {n} of {total}'),
  toc: T('Inhalt', 'Contents'),
  wiring: T('Anschlussplan', 'Wiring diagram'),
  wiringOverview: T('Übersicht der Anschlüsse', 'Connection overview'),
  wiringTerminals: T('Klemmenplan und Hinweise', 'Terminal plan and notes'),
  pinTable: T('Belegung der Anschlüsse', 'Pin assignment'),
  pinTableOf: T('Belegung der {name}-Anschlüsse', '{name} pin assignment'),
  pin: T('Pin', 'Pin'),
  func: T('Funktion', 'Function'),
  connected: T('Angeschlossen an', 'Connected to'),
  remark: T('Bemerkung', 'Remark'),
  hints: T('Hinweise zur Verdrahtung', 'Wiring notes'),
  legend: T('Legende', 'Legend'),
  seePage: T(
    'Die genauen Klemmen und alle Hinweise zur Verdrahtung stehen auf Seite {page}.',
    'Exact terminals and all wiring notes are on page {page}.',
  ),
  documentation: T('Anlagendokumentation', 'System documentation'),
  customer: T('Kunde', 'Customer'),
  address: T('Anschrift', 'Address'),
  site: T('Anlage', 'System'),
  date: T('Datum', 'Date'),
  technician: T('Techniker', 'Technician'),
  docNo: T('Dokument-Nr.', 'Document no.'),
  version: T('Version', 'Version'),
  contacts: T('Ansprechpartner', 'Contacts'),
  guard: T('Wachschutz', 'Security service'),
  guardCompany: T('Firma', 'Company'),
  guardPhone: T('Notruf', 'Emergency line'),
  guardNo: T('Kunden-/Objekt-Nr.', 'Customer/site no.'),
  guardCenter: T('Leitstelle', 'Monitoring centre'),
  projectData: T('Projektangaben', 'Project data'),
  access: T('Zugangsdaten', 'Access data'),
  continued: T('Fortsetzung', 'continued'),
  sitePlan: T('Lageplan', 'Site plan'),
  deviceList: T('Geräteliste', 'Device list'),
  fence: T('Zaun', 'Fence'),
  radioLink: T('Richtfunk', 'Radio link'),
  radioTo: T('Richtfunk zu {to}', 'Radio link to {to}'),
  radioBase: T('Richtfunk-Basis für {to}', 'Radio link base for {to}'),
  scale: T('Maßstab', 'Scale'),
  nr: T('Nr.', 'No.'),
  type: T('Typ', 'Type'),
  name: T('Bezeichnung', 'Designation'),
  photos: T('Fotodokumentation', 'Photo documentation'),
  photo: T('Foto', 'Photo'),
  chapters: T('Anleitung', 'Manual'),
  figure: T('Abbildung', 'Figure'),
  table: T('Tabelle', 'Table'),
  section: T('Abschnitt', 'Section'),
  figurePending: T('Abbildung folgt', 'Figure to follow'),
  refMissing: T('(Verweis fehlt)', '(missing reference)'),
  tone: {
    note: T('Hinweis', 'Note'),
    warn: T('Achtung', 'Caution'),
    danger: T('Vorsicht', 'Warning'),
    open: T('Offen', 'Open'),
  },
  setting: T('Einstellung', 'Setting'),
  value: T('Wert', 'Value'),
  secretsHidden: T(
    'Passwörter und Schlüssel sind in dieser Fassung ausgeblendet.',
    'Passwords and keys are hidden in this version.',
  ),
};

/** Beschriftung `key` für die Sprache `lang`, Platzhalter {x} aus `vars`. */
export function str(key, lang, vars = {}) {
  return tx(STRINGS[key], lang).replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? '') + '');
}

/** Sprachen, in denen das Dokument erscheint (Reihenfolge = Darstellung). */
export const langsOf = (project) => (project.lang === 'de+en' ? ['de', 'en'] : [project.lang || 'de']);

/* ---------- Anschlussplan ---------- */

/** Leitungsarten eines neuen Plans (neutral benannt, im Plan frei änderbar). */
export const DEFAULT_CATEGORIES = () => [
  { id: 'sig', name: T('Signal', 'Signal'), color: '#1f3b4d' },
  { id: 'ls', name: T('Eingang', 'Input'), color: '#15803d' },
  { id: 'led', name: T('Ausgang', 'Output'), color: '#b91c1c' },
  { id: 'pwr', name: T('Versorgung', 'Supply'), color: '#b45309' },
];

/**
 * Neue Baugruppe. Lage und Größe ergeben sich automatisch; `y` (pt unter der Oberkante der
 * Steuerung), `h` (Mindesthöhe), `pinY` (erste Leitung, pt unter der Oberkante) und `pinGap`
 * setzt das Verschieben im Plan bzw. das Beispiel.
 */
export function newBox(cat = 'sig', side = 'left') {
  return {
    id: uid('b'),
    title: T('', ''),
    lines: T('', ''),
    cat,
    side,
    badge: false,
    bus: false,
    parent: null,
    fill: side === 'bottom',
    fillColor: null,
    y: null,
    h: null,
    pinY: null,
    pinGap: null,
  };
}

/** Neuer Anschluss der Steuerung. */
export const newPin = (name = '', box = null) => ({
  id: uid('p'),
  name,
  label: '',
  func: T('', ''),
  box,
  terminal: T('', ''),
  note: T('', ''),
});

/** Neuer Hinweis. */
export const newHint = (cat = 'sig') => ({ id: uid('h'), cat, title: T('', ''), text: T('', '') });

/** Leerer Anschlussplan: eine zentrale Baugruppe, Leitungsarten, sonst nichts. */
export function newWiring() {
  return {
    id: uid('s'),
    type: 'wiring',
    system: T('', ''),
    categories: DEFAULT_CATEGORIES(),
    badge: { label: '12 V', color: '#b45309', text: T('Baugruppe wird direkt aus dem 12-V-Netzteil versorgt.', 'Module is supplied directly from the 12 V power supply.') },
    hub: { name: T('Steuerung', 'Controller'), short: T('', ''), model: T('', ''), note: T('', ''), pins: [] },
    boxes: [],
    hints: [],
  };
}

/* ---------- Lageplan ---------- */

/**
 * Symbole für den Lageplan. `code` = Kürzel für die Nummerierung (K 1, BM 2 …), `fov` = hat einen
 * Erfassungsbereich (Winkel/Reichweite in pt auf der Seite), `glyph` = Name des Bildzeichens in
 * site.js.
 */
export const SYMBOLS = [
  { id: 'camera', code: 'K', name: T('Kamera', 'Camera'), color: '#1d4ed8', glyph: 'camera', fov: { angle: 90, range: 90 } },
  { id: 'motion', code: 'BM', name: T('Bewegungsmelder', 'Motion detector'), color: '#b91c1c', glyph: 'motion', fov: { angle: 90, range: 60 } },
  { id: 'smoke', code: 'RM', name: T('Rauchmelder', 'Smoke detector'), color: '#c2410c', glyph: 'smoke' },
  { id: 'contact', code: 'MK', name: T('Öffnungsmelder', 'Door/window contact'), color: '#0f766e', glyph: 'contact' },
  { id: 'glass', code: 'GB', name: T('Glasbruchmelder', 'Glass-break detector'), color: '#0e7490', glyph: 'glass' },
  { id: 'barrier', code: 'LS', name: T('Lichtschranke', 'Light barrier'), color: '#15803d', glyph: 'barrier' },
  { id: 'siren', code: 'SI', name: T('Sirene', 'Siren'), color: '#a21caf', glyph: 'siren' },
  { id: 'keypad', code: 'BT', name: T('Bedienteil', 'Keypad'), color: '#475569', glyph: 'keypad' },
  { id: 'panel', code: 'AZ', name: T('Alarmzentrale', 'Alarm panel'), color: '#1f3b4d', glyph: 'panel' },
  { id: 'keyswitch', code: 'SS', name: T('Schlüsselschalter', 'Key switch'), color: '#7c3aed', glyph: 'keyswitch' },
  { id: 'access', code: 'ZK', name: T('Zutrittsleser', 'Access reader'), color: '#0369a1', glyph: 'access' },
  { id: 'opener', code: 'TÖ', name: T('Türöffner', 'Door opener'), color: '#9a3412', glyph: 'opener' },
  { id: 'intercom', code: 'TS', name: T('Türsprechstelle', 'Door intercom'), color: '#4d7c0f', glyph: 'intercom' },
  { id: 'router', code: 'NW', name: T('Router / Switch', 'Router / switch'), color: '#334155', glyph: 'router' },
  { id: 'recorder', code: 'NVR', name: T('Rekorder', 'Recorder'), color: '#1e3a8a', glyph: 'recorder' },
  // Installation: Module, Masten, Kästen (Galerie-Gruppe „Installation“)
  { id: 'mgm', code: 'MGM', name: T('Meldegruppenmodul', 'Zone module'), color: '#9f1239', glyph: 'mgm', group: 'infra' },
  { id: 'mast', code: 'MA', name: T('Mast', 'Pole'), color: '#57534e', glyph: 'mast', group: 'infra' },
  { id: 'cabinet', code: 'SK', name: T('Schaltkasten', 'Control cabinet'), color: '#b45309', glyph: 'cabinet', group: 'infra' },
  { id: 'junction', code: 'AK', name: T('Anschlusskasten', 'Junction box'), color: '#78716c', glyph: 'junction', group: 'infra' },
  { id: 'rack', code: 'NS', name: T('Netzwerkschrank', 'Network rack'), color: '#1e293b', glyph: 'rack', group: 'infra' },
  // Fotostandort: wo ein Foto der Fotodokumentation aufgenommen wurde (Nummer = Foto, „F 3“)
  { id: 'photo', code: 'F', name: T('Fotostandort', 'Photo location'), color: '#0d9488', glyph: 'photo', fov: { angle: 60, range: 50 } },
  // Station einer Richtfunkstrecke: wird über „Richtfunk“ gesetzt, nicht einzeln in der Galerie
  { id: 'radio', code: 'RF', name: T('Richtfunk-Antenne', 'Radio link antenna'), color: '#0891b2', glyph: 'radio', link: true },
];

/** Farben für Zeichnungen, Zäune und Zonen (wie die Markierungsfarben in Vorschau). */
export const SHAPE_COLORS = [
  ['#1d4ed8', 'Blau'],
  ['#b91c1c', 'Rot'],
  ['#15803d', 'Grün'],
  ['#c2410c', 'Orange'],
  ['#7c3aed', 'Violett'],
  ['#0891b2', 'Türkis'],
  ['#475569', 'Grau'],
  ['#16181d', 'Schwarz'],
];

/** Zeichnungsarten: gerade Linie, Freihand, Zaun (geschlossen = Zone). */
export const SHAPE_TYPES = {
  line: T('Linie', 'Line'),
  free: T('Freihand', 'Freehand'),
  fence: T('Zaun', 'Fence'),
  zone: T('Zone', 'Zone'),
  dim: T('Maßlinie', 'Dimension'),
};

export const newShape = (type, pts, color = type === 'fence' ? '#15803d' : '#1d4ed8') => ({
  id: uid('z'),
  type,
  pts,
  closed: false,
  color,
  name: T('', ''),
  showLen: true,
});

/** Richtfunkstrecke: `from` = Station (bei Punkt-zu-Mehrpunkt die Basis), `to` = Gegenstellen. */
export const newLink = (mode, from, to = []) => ({ id: uid('l'), mode, from, to, band: '', ssid: '', key: '' });

/** Leerer Lageplan. */
export const newSite = () => ({
  id: uid('s'),
  type: 'site',
  title: T('Lageplan', 'Site plan'),
  bg: { image: null, rotate: 0, fit: 'contain', fade: 0 },
  symbols: [],
  custom: [],
  shapes: [],
  links: [],
  /** Maßstab: Bezugsstrecke a–b (Anteile der Planfläche) mit ihrer Länge in Metern, oder null. */
  scale: null,
  scaleBar: true,
  /** Plan ausdünnen: Art → 'faded' (blass) oder 'hidden' (aus); fehlt = normal. */
  thin: {},
  showNumbers: true,
  showList: true,
  /** Bus/Adresse an den Symbolen im Plan („BM 3 · 1/12“) */
  showBus: false,
  photoSpotsInPdf: true,
  /** Legende in der PDF: 'below' (unter dem Plan, sonst eigene Seite), 'page' oder 'none' */
  legend: 'below',
});

/** Neues Symbol an der Stelle (x, y) – Anteile der Planfläche (0–1). */
export function newSymbol(kind, x = 0.5, y = 0.5) {
  const info = SYMBOLS.find((s) => s.id === kind);
  return {
    id: uid('y'),
    kind,
    x,
    y,
    name: T('', ''),
    note: T('', ''),
    ip: '',
    scale: 1,
    fov: !!(info && info.fov),
    dir: 0,
    angle: info && info.fov ? info.fov.angle : 90,
    range: info && info.fov ? info.fov.range : 60,
    ...(kind === 'mgm' ? { groups: 2 } : {}),
  };
}

/** Eigenes Symbol (Bild aus `project.images`). */
export const newCustomSymbol = (image) => ({ id: uid('u'), image, name: T('Eigenes Symbol', 'Custom symbol'), code: 'ES' });

/** Angaben zu einem Symbolart: { code, name, color, glyph, fov, image } oder null. */
export function symbolInfo(site, kind) {
  const base = SYMBOLS.find((s) => s.id === kind);
  if (base) return base;
  const id = typeof kind === 'string' && kind.startsWith('custom:') ? kind.slice(7) : null;
  const custom = id && site.custom.find((c) => c.id === id);
  return custom ? { code: custom.code || 'ES', name: custom.name, color: '#475569', glyph: null, image: custom.image } : null;
}

/**
 * Symbole einer Art in Nummernfolge. `seq` (gesetzt beim Ändern der Nummer oder „Neu
 * nummerieren“) bestimmt die Folge; Symbole ohne `seq` (neu gesetzt) kommen danach in der
 * Reihenfolge der Liste. Die Liste selbst bleibt die Zeichenreihenfolge.
 */
/**
 * Kürzel für die Nummer: das der Art; beim Meldegruppenmodul mit der Zahl der Meldegruppen
 * („MGM-2“ → MGM-2-1, MGM-2-2 …; jeder Typ zählt für sich).
 */
export function symbolCode(site, sym) {
  const info = symbolInfo(site, sym.kind);
  // Fotostandorte zählen nicht mit: ihre Nummer ist die des Fotos (photoLabels)
  if (!info || sym.kind === 'photo') return null;
  return sym.kind === 'mgm' ? `MGM-${sym.groups || 2}` : info.code;
}

/** Trenner zwischen Kürzel und Nummer: „K 1“, aber „MGM-2-1“. */
export const codeSep = (code) => (code.startsWith('MGM-') ? '-' : ' ');

function numberedGroups(site) {
  const groups = new Map();
  site.symbols.forEach((sym, i) => {
    const code = symbolCode(site, sym);
    if (!code) return;
    if (!groups.has(code)) groups.set(code, []);
    groups.get(code).push({ sym, key: Number.isInteger(sym.seq) ? sym.seq : 1e6 + i, i });
  });
  for (const list of groups.values()) list.sort((a, b) => a.key - b.key || a.i - b.i);
  return new Map([...groups].map(([code, list]) => [code, list.map((e) => e.sym)]));
}

/**
 * Bei mehreren Lageplänen zählen die Nummern durch: Anzahl je Kürzel in den Plänen davor
 * (Reihenfolge der Projektmappe). Ohne Projekt beginnt jeder Plan bei 1.
 */
function codeOffsets(site, project) {
  const out = new Map();
  if (!project) return out;
  for (const s of project.sections) {
    if (s === site) break;
    if (s.type === 'site') for (const [code, list] of numberedGroups(s)) out.set(code, (out.get(code) || 0) + list.length);
  }
  return out;
}

/** Nummern der Symbole: Kennung → „K 1“ (je Kürzel lückenlos, über alle Lagepläne durchgehend). */
/** `forPdf`: nur Fotos zählen, die in die fertige PDF kommen. */
export function symbolLabels(site, project = null, forPdf = false) {
  const off = codeOffsets(site, project);
  const out = new Map();
  for (const [code, list] of numberedGroups(site)) list.forEach((sym, i) => out.set(sym.id, `${code}${codeSep(code)}${(off.get(code) || 0) + i + 1}`));
  if (site.symbols.some((y) => y.kind === 'photo')) {
    const nums = photoNumbers(project, forPdf);
    for (const y of site.symbols) if (y.kind === 'photo') out.set(y.id, photoLabel(nums.get(y.id)));
  }
  return out;
}

/** Nummern der Fotos je verknüpftem Symbol: Kennung → [3, 4] (wie in der Fotodokumentation). */
export function photoNumbers(project, forPdf = false) {
  const out = new Map();
  for (const s of project ? project.sections : [])
    if (s.type === 'photos' && !(forPdf && s.inPdf === false)) s.items.forEach((p, i) => p.link && (out.get(p.link) || out.set(p.link, []).get(p.link)).push(i + 1));
  return out;
}

/** „F 3“, „F 3, 5“, „F 3–5“; ohne Foto nur „F“. */
function photoLabel(list) {
  if (!list || !list.length) return 'F';
  list = [...new Set(list)].sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < list.length; i++) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[j] + 1) j++;
    parts.push(j > i + 1 ? `${list[i]}–${list[j]}` : j === i + 1 ? `${list[i]}, ${list[j]}` : `${list[i]}`);
    i = j;
  }
  return `F ${parts.join(', ')}`;
}

/** Alle Symbole in Nummernfolge (je Art zusammen, Arten in der Reihenfolge ihres ersten Auftretens). */
export function symbolsInOrder(site) {
  return [...numberedGroups(site).values()].flat();
}

/**
 * Nummer eines Symbols: { code, n, first, last } – `n` wie im Plan (durchgehend), `first`/`last`
 * der Bereich dieser Art in diesem Plan; oder null.
 */
export function symbolNumber(site, sym, project = null) {
  const code = symbolCode(site, sym);
  const list = code && numberedGroups(site).get(code);
  if (!list) return null;
  const off = codeOffsets(site, project).get(code) || 0;
  return { code, sep: codeSep(code), n: off + list.indexOf(sym) + 1, first: off + 1, last: off + list.length, count: list.length };
}

/** Nummer ändern: das Symbol rückt an Stelle `n`, die übrigen rücken nach (lückenlos). */
export function setSymbolNumber(site, sym, n) {
  const list = numberedGroups(site).get(symbolCode(site, sym));
  if (!list) return;
  list.splice(list.indexOf(sym), 1);
  list.splice(Math.max(0, Math.min(list.length, Math.round(n) - 1)), 0, sym);
  list.forEach((y, i) => (y.seq = i));
}

/** Nach Wechsel von Art oder Typ: in der neuen Gruppe hinten anstellen. */
export function appendToGroup(site, sym) {
  delete sym.seq;
  const list = numberedGroups(site).get(symbolCode(site, sym));
  if (!list) return;
  list.splice(list.indexOf(sym), 1);
  list.push(sym);
  list.forEach((y, i) => (y.seq = i));
}

/**
 * Alle Arten neu nummerieren nach Lage im Plan: zeilenweise von oben nach unten, in der Zeile
 * von links nach rechts (Symbole mit kaum unterschiedlicher Höhe gelten als eine Zeile).
 */
export function renumberByPosition(site, row = 0.06) {
  for (const list of numberedGroups(site).values()) {
    const sorted = [...list].sort((a, b) => a.y - b.y);
    const rows = [];
    for (const y of sorted) {
      const last = rows.at(-1);
      if (last && y.y - last[0].y < row) last.push(y);
      else rows.push([y]);
    }
    rows.flatMap((r) => r.sort((a, b) => a.x - b.x)).forEach((y, i) => (y.seq = i));
  }
}

/* ---------- Lageplan ↔ Zugangsdaten ---------- */

/** Symbolarten mit Netzwerkzugang: erscheinen automatisch in „Zugangsdaten › Geräte-Zugänge“. */
export const NET_KINDS = ['camera', 'recorder', 'radio', 'router', 'intercom', 'access', 'panel'];

/** Melder und Teilnehmer der Alarmanlage: Bus, Adresse, Meldegruppe und Bereich (auch eigene Symbole). */
export const BUS_KINDS = ['motion', 'smoke', 'contact', 'glass', 'barrier', 'siren', 'keypad', 'keyswitch', 'access', 'opener'];
export const isBusKind = (kind) => BUS_KINDS.includes(kind) || String(kind).startsWith('custom:');

/** Arten mit Montagehöhe. */
export const isHeightKind = (kind) => kind === 'camera' || kind === 'mast' || kind === 'radio' || isBusKind(kind);

/** Montage- und Anschlussangaben eines Symbols (Texte; leer = nicht angegeben). */
export const SYMBOL_DETAILS = { bus: 20, addr: 20, group: 40, area: 60, channel: 10, height: 20 };

/** Angaben, die zur (neuen) Art nicht passen, entfernen: Bus-Felder nur bei Meldern, Rekorder nur bei Kameras. */
export function dropDetails(y) {
  if (!isBusKind(y.kind)) for (const k of ['bus', 'addr', 'group', 'area']) delete y[k];
  if (y.kind !== 'camera') for (const k of ['nvr', 'channel']) delete y[k];
  if (!isHeightKind(y.kind)) delete y.height;
}

/** Anzeigename eines Symbols: eigene Bezeichnung, sonst „K 1 Kamera“. */
function symbolName(site, sym, labels) {
  const info = symbolInfo(site, sym.kind);
  const own = sym.name || T('', '');
  const fallback = (lang) => [labels.get(sym.id), info ? tx(info.name, lang) : ''].filter(Boolean).join(' ');
  return { de: own.de || fallback('de'), en: own.en || (own.de ? '' : fallback('en')) };
}

/** Zugangsdaten-Eintrag eines Symbols (über alle Abschnitte) oder null. */
export function deviceOf(project, symId) {
  for (const s of project.sections) if (s.type === 'access') for (const d of s.devices) if (d.sym === symId) return d;
  return null;
}

/** WLAN-Eintrag einer Richtfunkstrecke oder null. */
export function wifiOf(project, linkId) {
  for (const s of project.sections) if (s.type === 'access') for (const w of s.wifi) if (w.link === linkId) return w;
  return null;
}

/**
 * Hält Lageplan und Zugangsdaten gleich (läuft nach jeder Änderung): Jedes Netzwerkgerät im
 * Lageplan hat einen Eintrag unter „Geräte-Zugänge“ (Name folgt dem Symbol), jede Richtfunkstrecke
 * mit SSID oder Schlüssel einen WLAN-Eintrag. Fehlt der Abschnitt Zugangsdaten, wird er angelegt.
 * Verschwindet ein Symbol, bleibt sein Eintrag als gewöhnliches Gerät erhalten (keine Daten gehen
 * verloren); gelöscht wird er mit dem Symbol über die Oberfläche.
 */
/**
 * Hat ein Geräte-Eintrag eigene Angaben? Name und Standort setzt der Lageplan selbst – sie zählen
 * nicht. Geräte aus dem Lageplan stehen erst mit eigenen Angaben in den Zugangsdaten.
 */
export function deviceHasData(d) {
  const t = (v) => (v && typeof v === 'object' ? `${v.de || ''}${v.en || ''}` : String(v || '')).trim();
  return (
    ['ip', 'web', 'user', 'password', 'role', 'note', 'model', 'serial', 'mac', 'firmware'].some((k) => t(d[k])) ||
    (d.users || []).some((u) => t(u.user) || t(u.password) || t(u.role))
  );
}

/**
 * Lageplan und Zugangsdaten abgleichen. Geräte aus dem Lageplan (Netzwerkgeräte) bekommen erst
 * einen Eintrag, wenn etwas eingetragen ist: `drafts` (Kennung des Symbols → Entwurf) hält die
 * Angaben bis dahin; ein Entwurf mit Angaben wird übernommen, ein Eintrag ohne Angaben entfernt.
 */
export function syncAccess(project, drafts = null, keep = null) {
  const sites = project.sections.filter((s) => s.type === 'site');
  const syms = [];
  const links = [];
  for (const site of sites) {
    const labels = symbolLabels(site, project);
    for (const y of site.symbols) if (NET_KINDS.includes(y.kind)) syms.push({ y, name: symbolName(site, y, labels), site, labels });
    for (const l of site.links) if (l.ssid || l.key) links.push({ l, site, labels });
  }
  const symIds = new Set(syms.map((x) => x.y.id));
  // Entwürfe mit Angaben übernehmen
  const adopt = drafts ? [...drafts.values()].filter((d) => symIds.has(d.sym) && deviceHasData(d) && !deviceOf(project, d.sym)) : [];
  const wanted = adopt.length || links.length || syms.some(({ y }) => y.ip);
  let access = project.sections.find((s) => s.type === 'access');
  if (!access) {
    if (!wanted) return 0;
    access = newAccess();
    const last = project.sections.lastIndexOf(sites[sites.length - 1]);
    project.sections.splice(last + 1, 0, access);
  }
  // neue Einträge nach der Nummer einsortieren (die übrige Reihenfolge bleibt, auch selbst verschobene)
  const rank = new Map(sites.flatMap((site) => symbolsInOrder(site)).map((y, i) => [y.id, i]));
  const place = (d) => {
    const r = rank.get(d.sym) ?? Infinity;
    const at = access.devices.findIndex((x) => x.sym && rank.has(x.sym) && rank.get(x.sym) > r);
    access.devices.splice(at < 0 ? access.devices.length : at, 0, d);
  };
  for (const d of adopt) {
    place(d);
    drafts.delete(d.sym);
  }
  const all = project.sections.filter((s) => s.type === 'access');
  for (const s of all) for (const d of s.devices) if (d.sym && !symIds.has(d.sym)) d.sym = null;
  // Einträge aus dem Lageplan ohne eigene Angaben entfallen (der Entwurf bleibt für die Eingabe);
  // ein selbst eingetragener Standort (anders als der Titel des Lageplans) zählt als Angabe
  const siteOf = new Map(syms.map(({ y, site }) => [y.id, tx(site.title, 'de')]));
  const ownLocation = (d) => !!(d.location && d.location.de && d.location.de !== siteOf.get(d.sym));
  for (const s of all)
    s.devices = s.devices.filter((d) => {
      if (!d.sym || d.id === keep || deviceHasData(d) || ownLocation(d)) return true;
      if (drafts) drafts.set(d.sym, d);
      return false;
    });
  for (const { y, name, site } of syms) {
    let d = deviceOf(project, y.id);
    // frühere IP an der Antenne: Eintrag anlegen
    if (!d && y.ip) {
      d = { ...newDevice(), sym: y.id };
      place(d);
    }
    if (!d) continue;
    if (d.name.de !== name.de || d.name.en !== name.en) d.name = name;
    // frühere IP an der Antenne in den Eintrag übernehmen
    if (y.ip) {
      if (!d.ip) d.ip = y.ip;
      delete y.ip;
    }
    const where = tx(site.title, 'de');
    if (!d.location.de && where) d.location = { de: where, en: tx(site.title, 'en') === where ? '' : tx(site.title, 'en') };
  }
  const linkIds = new Set(links.map((x) => x.l.id));
  for (const s of all) s.wifi = s.wifi.filter((w) => !w.link || linkIds.has(w.link));
  for (const { l, labels } of links) {
    let w = wifiOf(project, l.id);
    if (!w) {
      const ends = [l.from, ...l.to].map((i) => labels.get(i)).filter(Boolean).join(l.mode === 'ptp' ? ' ↔ ' : ', ');
      w = { ...newWifi(), link: l.id, note: T(`Richtfunk ${ends}`, `Radio link ${ends}`) };
      access.wifi.push(w);
    }
    if (w.ssid !== l.ssid) w.ssid = l.ssid;
    if (w.key !== l.key) w.key = l.key;
  }
  return adopt.length;
}

/* ---------- Ansprechpartner und Wachschutz (Deckblatt) ---------- */

export const newContact = () => ({ id: uid('c'), name: '', role: '', phone: '', email: '' });
export const newGuard = () => ({ company: '', phone: '', customerNo: '', center: '' });

/* ---------- Fotodokumentation ---------- */

export const PHOTO_LAYOUTS = [1, 2, 4, 6];

export const newPhotos = () => ({
  id: uid('s'),
  type: 'photos',
  title: T('Fotodokumentation', 'Photo documentation'),
  perPage: 4,
  showDate: true,
  inPdf: true,
  items: [],
});

export const newPhoto = (image, date = '') => ({ id: uid('f'), image, caption: T('', ''), date, link: null });

/** Alle Symbole des Projekts mit ihrer Nummer: [{ id, label, name, section }] (für Fotoverknüpfungen). */
export function projectSymbols(project, lang = 'de') {
  const out = [];
  for (const s of project.sections) {
    if (s.type !== 'site') continue;
    const labels = symbolLabels(s, project);
    for (const sym of s.symbols) {
      const info = symbolInfo(s, sym.kind);
      if (!info) continue;
      out.push({ id: sym.id, label: labels.get(sym.id), name: tx(sym.name, lang) || tx(info.name, lang), section: s.id });
    }
  }
  return out;
}

/** Ohne Verweis verwendete Bilder entfernen (z. B. ersetzte Hintergründe, entfernte Fotos). */
export function pruneImages(project) {
  const used = new Set();
  const text = JSON.stringify({ ...project, images: undefined });
  for (const id of Object.keys(project.images || {})) if (text.includes(`"${id}"`)) used.add(id);
  const images = {};
  for (const id of used) images[id] = project.images[id];
  return { ...project, images };
}

/** Hat ein Abschnitt keinen Inhalt? (leere Abschnitte bleiben in der fertigen PDF weg) */
export function isEmptySection(section) {
  if (section.type === 'wiring') return !section.boxes.length && !section.hub.pins.length && !section.hints.length;
  if (section.type === 'access')
    return (
      !section.devices.length &&
      !section.wifi.length &&
      !section.remote.length &&
      !Object.entries(section.network).some(([, v]) => (typeof v === 'object' ? tx(v) : String(v || '').trim()))
    );
  if (section.type === 'site') return !section.symbols.length && !section.bg.image && !section.shapes.length;
  if (section.type === 'photos') return !section.items.length;
  if (section.type === 'chapters') return !section.blocks.length;
  return false;
}

/* ---------- Anleitung / Technische Beschreibung ---------- */

/** Bausteine eines Kapitels (`preset` = Tabelle mit vorbelegter Kopfzeile). */
export const BLOCK_TYPES = [
  { id: 'h', label: 'Überschrift', icon: 'text' },
  { id: 'p', label: 'Absatz', icon: 'al' },
  { id: 'ul', label: 'Aufzählung', icon: 'list' },
  { id: 'steps', label: 'Handlungsschritte', icon: 'pnum' },
  { id: 'callout', label: 'Hinweis / Warnung', icon: 'warn' },
  { id: 'figure', label: 'Abbildung', icon: 'image' },
  { id: 'figsteps', label: 'Abbildung mit Schritten', icon: 'pages' },
  { id: 'cards', label: 'Schritte mit Fotos', icon: 'image', manual: true },
  { id: 'signs', label: 'Zeichenerklärung', icon: 'info', manual: true },
  { id: 'table', label: 'Tabelle', icon: 'field' },
  { id: 'faults', label: 'Störungstabelle', icon: 'field', table: true },
  { id: 'parts', label: 'Positionsliste', icon: 'field', table: true },
  { id: 'scope', label: 'Lieferumfang', icon: 'field', table: true },
  { id: 'code', label: 'Codeblock', icon: 'edit' },
  { id: 'formula', label: 'Formel', icon: 'text' },
];

/** Tonarten der Hinweiskästen (Farben wie im Anschlussplan). */
export const TONES = [
  { id: 'note', color: '#2e6e8e' },
  { id: 'warn', color: '#b45309' },
  { id: 'danger', color: '#b91c1c' },
  { id: 'open', color: '#6b7280' },
];

/** Kopfzeilen und Spaltenbreiten der Tabellenvorlagen. */
const TABLE_PRESETS = {
  faults: { head: ['Störung', 'Mögliche Ursache', 'Abhilfe'], en: ['Fault', 'Cause', 'Remedy'], weights: [1.1, 1.4, 1.6] },
  parts: { head: ['Pos.', 'Bezeichnung'], en: ['Item', 'Designation'], weights: [0.5, 4] },
  scope: { head: ['Menge', 'Bezeichnung'], en: ['Quantity', 'Item'], weights: [0.6, 4] },
  table: { head: ['Spalte 1', 'Spalte 2'], en: ['Column 1', 'Column 2'], weights: [1, 1] },
};

export function newBlock(type, extra = {}) {
  const id = uid('k');
  if (type === 'h') return { id, type, level: 1, text: T('', ''), ...extra };
  if (type === 'p' || type === 'ul') return { id, type, text: T('', ''), ...extra };
  if (type === 'steps') return { id, type, text: T('', ''), ...extra };
  if (type === 'callout') return { id, type, tone: 'note', title: T('', ''), text: T('', ''), ...extra };
  if (type === 'figure') return { id, type, image: null, caption: T('', ''), width: 'full', marks: [], legend: true, aside: { title: T('', ''), text: T('', '') }, ...extra };
  if (type === 'cards') return { id, type, items: [newCard(), newCard()], ...extra };
  if (type === 'signs') return { id, type, ...extra };
  if (type === 'figsteps') return { id, type, image: null, caption: T('', ''), text: T('', ''), ...extra };
  if (type === 'code') return { id, type, text: '', ...extra };
  if (type === 'formula') return { id, type, text: '', ...extra };
  const preset = TABLE_PRESETS[type] || TABLE_PRESETS.table;
  return {
    id,
    type: 'table',
    preset: type,
    caption: T('', ''),
    head: [...preset.head],
    rows: [preset.head.map(() => '')],
    weights: [...preset.weights],
    en: { head: [...(preset.en || preset.head.map(() => ''))], rows: [preset.head.map(() => '')] },
    ...extra,
  };
}

/** Position auf einer Abbildung: Punkt (Anteile des Bildes), Kreis links/rechts, Bauteil und Beschreibung. */
export const newMark = (x = 0.5, y = 0.5) => ({ id: uid('m'), x, y, side: 'auto', ly: null, name: T('', ''), desc: T('', '') });

/** Karte der „Schritte mit Fotos“: Foto, Titel, Text. */
export const newCard = () => ({ id: uid('c'), image: null, title: T('', ''), text: T('', ''), fill: false });

/** Angaben des Deckblatts im Stil „Bedienungsanleitung“ (Titel = Projekttitel, Logo = Firmenlogo). */
export const newManualMeta = () => ({
  kicker: T('Bedienungsanleitung', 'Operating instructions'),
  subtitle: T('', ''),
  cover: null,
  modelLabel: T('Ausführung', 'Model'),
  model: '',
  note: T('Technische Änderungen vorbehalten.', 'Subject to technical modifications.'),
  version: '',
  date: '',
  accent: '#0c4061',
  accent2: '#0c4061',
});

export function newChapters(kind = 'manual') {
  return {
    id: uid('s'),
    type: 'chapters',
    kind,
    title: kind === 'tech' ? T('Technische Beschreibung', 'Technical description') : T('Bedienungsanleitung', 'User manual'),
    numbering: true,
    blocks: [],
  };
}

/**
 * Startinhalt der Bedienungsanleitung im Stil des Vorbilds: Sicherheit (Zeichenerklärung,
 * Sicherheitshinweise, Verwendung), Geräteübersicht mit Lieferumfang, Bedienung, Störungen.
 * Alle Texte sind neutrale Platzhalter.
 */
export function starterManual() {
  const s = newChapters('manual');
  const h = (de, en, level = 1) => newBlock('h', { level, text: T(de, en) });
  const ul = (de, en) => newBlock('ul', { text: T(de, en) });
  s.blocks = [
    h('Sicherheit', 'Safety'),
    h('Hinweise in dieser Anleitung', 'Notices in this manual', 2),
    newBlock('signs'),
    h('Sicherheitshinweise', 'Safety instructions', 2),
    newBlock('callout', {
      tone: 'danger',
      text: T('Beschreiben Sie hier die wichtigste Gefahr und wie man sie vermeidet.', 'Describe the most important hazard here and how to avoid it.'),
    }),
    ul('Erster Sicherheitshinweis.\nZweiter Sicherheitshinweis.', 'First safety instruction.\nSecond safety instruction.'),
    h('Bestimmungsgemäße Verwendung', 'Intended use', 2),
    ul('Wofür das Gerät bestimmt ist.\nWofür es nicht verwendet werden darf.', 'What the device is intended for.\nWhat it must not be used for.'),
    h('Geräteübersicht und Lieferumfang', 'Overview and items supplied'),
    newBlock('figure', { caption: T('Gerät, Gesamtansicht', 'Device, overall view') }),
    h('Lieferumfang', 'Items supplied', 2),
    newBlock('scope', { rows: [['1 ×', 'Gerät'], ['1 ×', 'Bedienungsanleitung']], en: { head: ['Quantity', 'Item'], rows: [['', 'Device'], ['', 'Operating instructions']] } }),
    h('Inbetriebnahme', 'Getting started'),
    newBlock('cards'),
    h('Störungen beheben', 'Troubleshooting'),
    newBlock('faults', { en: { head: ['Fault', 'Cause', 'Remedy'], rows: [['', '', '']] } }),
  ];
  return s;
}

/** Startinhalt der Vorlagen „Bedienungsanleitung“ und „Technische Beschreibung“. */
export function starterChapters(kind) {
  const s = newChapters(kind);
  const h = (de, en, level = 1) => newBlock('h', { level, text: T(de, en) });
  const p = (de, en = '') => newBlock('p', { text: T(de, en) });
  if (kind === 'tech') {
    s.blocks = [
      h('Aufgabe und Einsatz', 'Purpose and use'),
      p('Hier beschreiben: wofür die Anlage gebaut wurde und wo sie eingesetzt wird.'),
      h('Aufbau', 'Design'),
      p('Hauptkomponenten und ihr Zusammenspiel.'),
      newBlock('table', { preset: 'table', head: ['Komponente', 'Typ', 'Bemerkung'], rows: [['', '', '']], weights: [1.2, 1.2, 2] }),
      h('Funktionsbeschreibung', 'Functional description'),
      p('Ablauf und Betriebszustände.'),
      newBlock('callout', { tone: 'open', title: T('Offene Punkte', 'Open items'), text: T('Noch zu klären oder nachzureichen.', '') }),
    ];
  } else {
    s.blocks = [
      h('Zu dieser Anleitung', 'About this manual'),
      p('Kurz erklären, für wen die Anleitung ist und was sie beschreibt.'),
      h('Sicherheitshinweise', 'Safety'),
      newBlock('callout', { tone: 'danger', text: T('Hier die wichtigsten Warnhinweise nennen.', 'List the most important warnings here.') }),
      h('Bedienung', 'Operation'),
      newBlock('steps', { text: T('Erster Schritt\nZweiter Schritt\nDritter Schritt', '') }),
      h('Störungen', 'Troubleshooting'),
      newBlock('faults'),
    ];
  }
  return s;
}

/* ---------- Zugangsdaten ---------- */

/**
 * Tabellen der Zugangsdaten mit ihren Spalten: `w` = Breitenanteil, `mono` = Festbreitenschrift
 * (IP, MAC, Passwörter), `secret` = wird ausgeblendet, wenn Passwörter nicht mit in die PDF sollen,
 * `bi` = zweisprachiger Text, `fixed` = Spalte immer sichtbar.
 */
export const ACCESS_BLOCKS = [
  {
    id: 'devices',
    list: 'devices',
    title: T('Geräte-Zugänge', 'Device access'),
    columns: [
      { key: 'name', label: T('Gerät', 'Device'), w: 3, bi: true, bold: true, fixed: true },
      { key: 'ip', label: T('IP-Adresse', 'IP address'), w: 2.3, mono: true },
      { key: 'web', label: T('Port / Web', 'Port / web'), w: 2.2, mono: true },
      { key: 'user', label: T('Benutzer', 'User'), w: 1.9, mono: true },
      { key: 'password', label: T('Passwort', 'Password'), w: 2.1, mono: true, secret: true },
      { key: 'role', label: T('Rolle', 'Role'), w: 1.6 },
      { key: 'note', label: T('Bemerkung', 'Remark'), w: 3, bi: true },
    ],
  },
  {
    id: 'hardware',
    list: 'devices',
    title: T('Gerätedaten', 'Device data'),
    columns: [
      { key: 'name', label: T('Gerät', 'Device'), w: 3, bi: true, bold: true, fixed: true },
      { key: 'model', label: T('Hersteller / Typ', 'Make / model'), w: 3 },
      { key: 'serial', label: T('Seriennummer', 'Serial number'), w: 2.4, mono: true },
      { key: 'mac', label: T('MAC-Adresse', 'MAC address'), w: 2.7, mono: true },
      { key: 'firmware', label: T('Firmware', 'Firmware'), w: 1.8, mono: true },
      { key: 'location', label: T('Standort', 'Location'), w: 2.4, bi: true },
    ],
  },
  {
    id: 'network',
    title: T('Netzwerk', 'Network'),
    fields: [
      { key: 'subnet', label: T('Subnetzmaske', 'Subnet mask'), mono: true },
      { key: 'gateway', label: T('Gateway', 'Gateway'), mono: true },
      { key: 'dns', label: T('DNS-Server', 'DNS server'), mono: true },
      { key: 'dhcp', label: T('DHCP-Bereich', 'DHCP range'), mono: true },
      { key: 'vlan', label: T('VLAN', 'VLAN'), mono: true },
      { key: 'note', label: T('Bemerkung', 'Remark'), bi: true },
    ],
  },
  {
    id: 'wifi',
    list: 'wifi',
    title: T('WLAN', 'Wi-Fi'),
    columns: [
      { key: 'ssid', label: T('WLAN-Name (SSID)', 'Network name (SSID)'), w: 3, bold: true, fixed: true },
      { key: 'key', label: T('Schlüssel', 'Key'), w: 3, mono: true, secret: true },
      { key: 'security', label: T('Verschlüsselung', 'Security'), w: 2 },
      { key: 'note', label: T('Bemerkung', 'Remark'), w: 3, bi: true },
    ],
  },
  {
    id: 'remote',
    list: 'remote',
    title: T('Fernzugriff', 'Remote access'),
    columns: [
      { key: 'service', label: T('Dienst', 'Service'), w: 2.6, bold: true, fixed: true },
      { key: 'address', label: T('Adresse / ID', 'Address / ID'), w: 3.2, mono: true },
      { key: 'user', label: T('Benutzer', 'User'), w: 1.9, mono: true },
      { key: 'password', label: T('Passwort', 'Password'), w: 2.1, mono: true, secret: true },
      { key: 'note', label: T('Bemerkung', 'Remark'), w: 3, bi: true },
    ],
  },
];

/** Neue Zugangsdaten: alle Bereiche außer „Netzwerk“ eingeschaltet, Passwörter ausgeblendet. */
export function newAccess() {
  return {
    id: uid('s'),
    type: 'access',
    title: T('Zugangsdaten', 'Access data'),
    showPasswords: false,
    blocks: { devices: true, hardware: true, network: false, wifi: true, remote: true },
    hide: { devices: [], hardware: ['location'], wifi: [], remote: [] },
    devices: [],
    network: { subnet: '', gateway: '', dns: '', dhcp: '', vlan: '', note: T('', '') },
    wifi: [],
    remote: [],
  };
}

export const newDevice = () => ({
  id: uid('d'),
  /** Verknüpftes Gerät im Lageplan (Kennung des Symbols) oder null. */
  sym: null,
  name: T('', ''),
  ip: '',
  web: '',
  user: '',
  password: '',
  role: '',
  /** Weitere Benutzer: [{ id, user, password, role }] (der erste steht in user/password/role). */
  users: [],
  note: T('', ''),
  model: '',
  serial: '',
  mac: '',
  firmware: '',
  location: T('', ''),
});

export const newWifi = () => ({ id: uid('w'), link: null, ssid: '', key: '', security: 'WPA2', note: T('', '') });

export const newUser = () => ({ id: uid('n'), user: '', password: '', role: '' });

/** Rollen zur Auswahl (frei änderbar). */
export const ROLES = ['Administrator', 'Bediener', 'Nur ansehen', 'Wartung'];

export const newRemote = () => ({ id: uid('r'), service: '', address: '', user: '', password: '', note: T('', '') });

/** Kopie des Projekts ohne Passwörter/Schlüssel in Zugangsdaten, die sie nicht zeigen sollen. */
export function withoutSecrets(project, show = null) {
  const copy = JSON.parse(JSON.stringify({ ...project, images: undefined }));
  copy.images = project.images;
  for (const s of copy.sections) {
    if (s.type !== 'access' || (show ?? s.showPasswords)) continue;
    for (const block of ACCESS_BLOCKS)
      for (const col of block.columns || [])
        if (col.secret)
          for (const row of s[block.list] || []) {
            row[col.key] = '';
            for (const u of row.users || []) if (col.key in u) u[col.key] = '';
          }
    s.secretsRemoved = true;
  }
  return copy;
}

/* ---------- Projekt ---------- */

/** Vorlagen für neue Projekte. */
export const TEMPLATES = [
  {
    id: 'documentation',
    title: T('Anlagendokumentation', 'System documentation'),
    desc: 'Deckblatt, Inhalt, Lageplan, Anschlussplan, Zugangsdaten, Fotos',
    sections: () => [
      { id: uid('s'), type: 'cover' },
      { id: uid('s'), type: 'toc' },
      newSite(),
      newWiring(),
      newAccess(),
      newPhotos(),
    ],
  },
  {
    id: 'manual',
    title: T('Bedienungsanleitung', 'User manual'),
    desc: 'Deckblatt, Sicherheit, Geräteübersicht, Schritte mit Fotos und Störungstabelle – zweisprachig',
    design: 'manual',
    lang: 'de+en',
    font: 'barlow',
    sections: () => [{ id: uid('s'), type: 'cover' }, starterManual()],
  },
  {
    id: 'tech',
    title: T('Technische Beschreibung', 'Technical description'),
    desc: 'Aufgabe, Aufbau, Funktion, technische Daten und offene Punkte',
    sections: () => [{ id: uid('s'), type: 'cover' }, { id: uid('s'), type: 'toc' }, starterChapters('tech')],
  },
  {
    id: 'wiring',
    title: T('Anschlussplan', 'Wiring diagram'),
    desc: 'Blockschaltbild mit Leitungsarten, Klemmenplan und Hinweisen',
    sections: () => [newWiring()],
  },
];

/** Teile der Anlagendokumentation, die man beim Anlegen wählen kann (Reihenfolge wie im Dokument). */
export const DOC_PARTS = [
  { id: 'cover', label: 'Deckblatt', icon: 'fitp' },
  { id: 'site', label: 'Lageplan', hint: 'mit Geräteliste', icon: 'map' },
  { id: 'wiring', label: 'Anschlussplan', icon: 'wiring' },
  { id: 'access', label: 'Zugangsdaten', icon: 'key' },
  { id: 'photos', label: 'Fotodokumentation', icon: 'camera' },
];

/**
 * Nur die gewählten Teile übernehmen. Das Inhaltsverzeichnis kommt automatisch dazu, sobald
 * mindestens zwei Inhaltsteile gewählt sind.
 */
function pickParts(sections, parts) {
  const content = parts.filter((p) => p !== 'cover').length;
  return sections.filter((s) => (s.type === 'toc' ? content >= 2 : parts.includes(s.type)));
}

export function newProject(templateId = 'documentation', opts = {}) {
  const template = TEMPLATES.find((t) => t.id === templateId) || TEMPLATES[0];
  const sections = template.sections();
  return {
    v: MODEL_VERSION,
    id: uid('prj'),
    template: template.id,
    lang: opts.lang || template.lang || 'de',
    font: opts.font || template.font || 'helvetica',
    /** Gestaltung: 'classic' oder 'manual' (Bedienungsanleitung im Stil des Vorbilds). */
    design: template.design || 'classic',
    manual: newManualMeta(),
    title: template.design === 'manual' ? T('Produktname', 'Product name') : template.title,
    company: { name: '', tagline: T('', ''), logo: null },
    meta: {
      customer: '',
      address: '',
      site: '',
      date: new Date().toISOString().slice(0, 10),
      technician: '',
      docNo: '',
      version: '1.0',
    },
    /** Ansprechpartner des Kunden: [{ id, name, role, phone, email }] */
    contacts: [],
    /** Wachschutz: Firma, Notruf, Kunden-/Objektnummer, Leitstelle/Aufschaltung */
    guard: newGuard(),
    sections: opts.parts ? pickParts(sections, opts.parts) : sections,
    /** Freie Bilder und QR-Codes: { id, kind: 'image'|'qr', section, page, x, y, w, h, … } */
    overlays: [],
    images: {},
    created: Date.now(),
    modified: Date.now(),
  };
}

/* ---------- Laden und Prüfen ---------- */

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const IMAGE_RE = /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
const str_ = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : typeof v === 'number' ? String(v) : '');
const bool = (v) => v === true;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-5000, Math.min(5000, v)) : null);
const toT = (v) =>
  typeof v === 'string' ? T(str_(v), '') : v && typeof v === 'object' ? T(str_(v.de), str_(v.en)) : T('', '');
const oneOf = (v, list, fallback) => (list.includes(v) ? v : fallback);
const hasImg = (images, key) => typeof key === 'string' && Object.hasOwn(images, key);

/**
 * Prüft ein geladenes Projekt (Entwurf oder aus einer PDF) und bringt es auf den aktuellen Stand:
 * unbekannte Felder entfallen, Kennungen werden geprüft (sonst neu vergeben und Verweise
 * nachgezogen), Texte sind Zeichenketten, Bilder nur eingebettete PNG/JPG/WebP/SVG. So gelangt aus
 * einer fremden PDF nichts in die Oberfläche, was dort nicht hingehört.
 */
export function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections)) throw new Error('Kein PlantPDF-Projekt');
  const used = new Set();
  const id = (v, prefix) => {
    let out = typeof v === 'string' && ID_RE.test(v) && !used.has(v) ? v : uid(prefix);
    while (used.has(out)) out = uid(prefix);
    used.add(out);
    return out;
  };
  const base = newProject('wiring');
  const images = Object.create(null);
  for (const [key, img] of Object.entries(raw.images && typeof raw.images === 'object' ? raw.images : {})) {
    if (!ID_RE.test(key) || !img || typeof img.data !== 'string' || !IMAGE_RE.test(img.data)) continue;
    const w = num(img.w);
    const h = num(img.h);
    if (!(w > 0 && h > 0)) continue;
    images[key] = { mime: str_(img.mime, 40), data: img.data, w, h };
  }
  const company = raw.company && typeof raw.company === 'object' ? raw.company : {};
  const meta = raw.meta && typeof raw.meta === 'object' ? raw.meta : {};
  const project = {
    v: MODEL_VERSION,
    id: id(raw.id, 'prj'),
    template: oneOf(raw.template, TEMPLATES.map((t) => t.id), 'documentation'),
    lang: oneOf(raw.lang, LANGS.map((l) => l.id), 'de'),
    font: oneOf(raw.font, FONTS.map((f) => f.id), 'helvetica'),
    title: toT(raw.title),
    company: {
      name: str_(company.name, 200),
      tagline: toT(company.tagline),
      logo: hasImg(images, company.logo) ? company.logo : null,
    },
    meta: Object.fromEntries(Object.keys(base.meta).map((k) => [k, str_(meta[k], 1000)])),
    contacts: (Array.isArray(raw.contacts) ? raw.contacts : [])
      .filter((c) => c && typeof c === 'object')
      .slice(0, 50)
      .map((c) => ({ id: id(c.id, 'c'), name: str_(c.name, 200), role: str_(c.role, 200), phone: str_(c.phone, 80), email: str_(c.email, 200) })),
    guard: Object.fromEntries(Object.keys(newGuard()).map((k) => [k, str_(raw.guard && typeof raw.guard === 'object' ? raw.guard[k] : '', 300)])),
    design: oneOf(raw.design, ['classic', 'manual'], 'classic'),
    manual: cleanManualMeta(raw.manual, images),
    sections: [],
    images,
    created: num(raw.created) ?? Date.now(),
    modified: typeof raw.modified === 'number' && Number.isFinite(raw.modified) ? raw.modified : Date.now(),
  };
  for (const s of raw.sections) {
    if (!s || typeof s !== 'object') continue;
    if (s.type === 'cover' || s.type === 'toc') project.sections.push({ id: id(s.id, 's'), type: s.type });
    else if (s.type === 'wiring') project.sections.push(cleanWiring(s, id));
    else if (s.type === 'access') project.sections.push(cleanAccess(s, id));
    else if (s.type === 'site') project.sections.push(cleanSite(s, id, images));
    else if (s.type === 'photos') project.sections.push(cleanPhotos(s, id, images));
    else if (s.type === 'chapters') project.sections.push(cleanChapters(s, id, images));
    else continue;
    // Seitenformat je Abschnitt (Deckblatt und Inhalt immer hoch)
    if (s.landscape === true && s.type !== 'cover' && s.type !== 'toc') project.sections.at(-1).landscape = true;
  }
  project.overlays = cleanOverlays(raw.overlays, project.sections, images, id);
  // Fotoverknüpfungen nur auf Symbole, die es gibt
  const symbolIds = new Set(project.sections.flatMap((s) => (s.type === 'site' ? s.symbols.map((y) => y.id) : [])));
  for (const s of project.sections) if (s.type === 'photos') for (const p of s.items) if (p.link && !symbolIds.has(p.link)) p.link = null;
  return project;
}

/** Freie Bilder und QR-Codes: nur auf vorhandenen Abschnitten, Maße auf der Seite begrenzt. */
function cleanOverlays(list, sections, images, id) {
  const ids = new Set(sections.map((s) => s.id));
  return (Array.isArray(list) ? list : [])
    .filter((o) => o && typeof o === 'object' && ids.has(o.section) && (o.kind === 'qr' || (o.kind === 'image' && hasImg(images, o.image))))
    .slice(0, 500)
    .map((o) => ({
      id: id(o.id, 'o'),
      kind: o.kind,
      section: o.section,
      page: Math.round(clamp(o.page, 0, 999, 0)),
      x: clamp(o.x, -200, 1000, 42),
      y: clamp(o.y, -200, 1000, 120),
      w: clamp(o.w, 8, 900, 100),
      h: clamp(o.h, 8, 900, 100),
      ...(o.kind === 'image' ? { image: o.image } : { src: typeof o.src === 'string' && ID_RE.test(o.src) ? o.src : null, text: str_(o.text, 2000), caption: o.caption !== false }),
    }));
}

function cleanManualMeta(m, images) {
  const d = newManualMeta();
  if (!m || typeof m !== 'object') return d;
  const hex = (v, f) => (/^#[0-9a-f]{6}$/i.test(v) ? v : f);
  return {
    kicker: m.kicker ? toT(m.kicker) : d.kicker,
    subtitle: toT(m.subtitle),
    cover: hasImg(images, m.cover) ? m.cover : null,
    modelLabel: m.modelLabel ? toT(m.modelLabel) : d.modelLabel,
    model: str_(m.model, 200),
    note: m.note ? toT(m.note) : d.note,
    version: str_(m.version, 40),
    date: str_(m.date, 40),
    accent: hex(m.accent, d.accent),
    accent2: hex(m.accent2, d.accent2),
  };
}

function cleanWiring(s, id) {
  const d = newWiring();
  const remap = new Map();
  const boxId = (v) => {
    const out = id(v, 'b');
    if (typeof v === 'string') remap.set(v, out);
    return out;
  };
  const categories = (Array.isArray(s.categories) ? s.categories : d.categories)
    .filter((c) => c && typeof c === 'object')
    .map((c) => ({ id: id(c.id, 'c'), name: toT(c.name), color: str_(c.color, 9) }));
  const boxes = (Array.isArray(s.boxes) ? s.boxes : [])
    .filter((b) => b && typeof b === 'object')
    .map((b) => ({
      ...newBox(),
      id: boxId(b.id),
      title: toT(b.title),
      lines: toT(b.lines),
      cat: str_(b.cat, 64),
      side: oneOf(b.side, ['left', 'right', 'bottom'], 'left'),
      badge: bool(b.badge),
      bus: bool(b.bus),
      parent: typeof b.parent === 'string' ? b.parent : null,
      fill: bool(b.fill),
      fillColor: b.fillColor ? str_(b.fillColor, 9) : null,
      y: num(b.y),
      h: num(b.h),
      pinY: num(b.pinY),
      pinGap: num(b.pinGap),
    }));
  // Verweise auf umbenannte Kennungen nachziehen; Unterbaugruppen eines unteren Kastens lösen
  for (const b of boxes) {
    b.parent = b.parent != null && remap.has(b.parent) ? remap.get(b.parent) : null;
    const parent = boxes.find((x) => x.id === b.parent);
    if (!parent || parent.side === 'bottom' || parent === b) b.parent = null;
  }
  const hub = s.hub && typeof s.hub === 'object' ? s.hub : {};
  const pins = (Array.isArray(hub.pins) ? hub.pins : [])
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      id: id(p.id, 'p'),
      name: str_(p.name, 40),
      label: str_(p.label, 40),
      func: toT(p.func),
      box: typeof p.box === 'string' && remap.has(p.box) ? remap.get(p.box) : null,
      terminal: toT(p.terminal),
      note: toT(p.note),
    }));
  const badge = s.badge && typeof s.badge === 'object' ? s.badge : d.badge;
  return {
    id: id(s.id, 's'),
    type: 'wiring',
    system: toT(s.system),
    categories: categories.length ? categories : d.categories,
    badge: { label: str_(badge.label, 20), color: str_(badge.color, 9) || d.badge.color, text: toT(badge.text) },
    hub: { name: toT(hub.name), short: toT(hub.short), model: toT(hub.model), note: toT(hub.note), pins },
    boxes,
    hints: (Array.isArray(s.hints) ? s.hints : [])
      .filter((h) => h && typeof h === 'object')
      .map((h) => ({ id: id(h.id, 'h'), cat: str_(h.cat, 64), title: toT(h.title), text: toT(h.text) })),
  };
}

const clamp = (v, lo, hi, fallback) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback);
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

function cleanSite(s, id, images) {
  const d = newSite();
  const bg = s.bg && typeof s.bg === 'object' ? s.bg : {};
  const renamed = new Map();
  const custom = (Array.isArray(s.custom) ? s.custom : [])
    .filter((c) => c && typeof c === 'object' && hasImg(images, c.image))
    .map((c) => {
      const out = { id: id(c.id, 'u'), image: c.image, name: toT(c.name), code: str_(c.code, 6).trim() || 'ES' };
      if (typeof c.id === 'string' && !renamed.has(c.id)) renamed.set(c.id, out.id);
      return out;
    });
  const kinds = new Set(SYMBOLS.map((x) => x.id));
  /** Symbolart prüfen; eigene Arten folgen ihrer (ggf. neu vergebenen) Kennung. */
  const kindOf = (k) => {
    if (typeof k !== 'string') return null;
    if (kinds.has(k)) return k;
    const to = k.startsWith('custom:') ? renamed.get(k.slice(7)) : null;
    return to ? 'custom:' + to : null;
  };
  const symbols = (Array.isArray(s.symbols) ? s.symbols : [])
    .filter((y) => y && typeof y === 'object' && kindOf(y.kind))
    .map((y) => cleanLook(y, {
      id: id(y.id, 'y'),
      kind: kindOf(y.kind),
      x: clamp(y.x, 0, 1, 0.5),
      y: clamp(y.y, 0, 1, 0.5),
      name: toT(y.name),
      note: toT(y.note),
      ip: str_(y.ip, 80),
      scale: clamp(y.scale, 0.5, 2.5, 1),
      fov: bool(y.fov),
      dir: clamp(y.dir, -360, 720, 0),
      angle: clamp(y.angle, 5, 360, 90),
      range: clamp(y.range, 10, 600, 60),
      ...(Number.isInteger(y.seq) && y.seq >= 0 && y.seq < 100000 ? { seq: y.seq } : {}),
      ...(y.kind === 'mgm' ? { groups: Number.isInteger(y.groups) && y.groups >= 1 && y.groups <= 99 ? y.groups : 2 } : {}),
      ...Object.fromEntries(Object.entries(SYMBOL_DETAILS).filter(([k]) => str_(y[k]).trim()).map(([k, max]) => [k, str_(y[k], max)])),
      ...(typeof y.nvr === 'string' && ID_RE.test(y.nvr) ? { nvr: y.nvr } : {}),
    }, true));
  const point = (q) => (Array.isArray(q) && q.length === 2 ? [clamp(q[0], 0, 1, 0), clamp(q[1], 0, 1, 0)] : null);
  const shapes = (Array.isArray(s.shapes) ? s.shapes : [])
    .filter((z) => z && typeof z === 'object' && ['line', 'free', 'fence', 'dim'].includes(z.type) && Array.isArray(z.pts))
    .map((z) => cleanLook(z, {
      id: id(z.id, 'z'),
      type: z.type,
      pts: z.pts.slice(0, 4000).map(point).filter(Boolean),
      closed: z.type === 'fence' && bool(z.closed),
      color: /^#[0-9a-f]{6}$/i.test(z.color) ? z.color : '#1d4ed8',
      name: toT(z.name),
      showLen: z.showLen !== false,
    }))
    .filter((z) => z.pts.length >= 2)
    .map((z) => (z.type === 'dim' ? { ...z, pts: z.pts.slice(0, 2) } : z));
  for (const z of shapes) if (z.closed && z.pts.length < 3) z.closed = false;
  const stations = new Set(symbols.filter((y) => y.kind === 'radio').map((y) => y.id));
  const links = (Array.isArray(s.links) ? s.links : [])
    .filter((l) => l && typeof l === 'object')
    .map((l) => cleanLook(l, {
      id: id(l.id, 'l'),
      mode: l.mode === 'ptmp' ? 'ptmp' : 'ptp',
      from: l.from,
      to: (Array.isArray(l.to) ? l.to : []).filter((t) => stations.has(t) && t !== l.from),
      band: str_(l.band, 40),
      ssid: str_(l.ssid, 80),
      key: str_(l.key, 200),
    }))
    .filter((l) => stations.has(l.from) && l.to.length);
  for (const l of links) if (l.mode === 'ptp') l.to = l.to.slice(0, 1);
  return {
    id: id(s.id, 's'),
    type: 'site',
    title: toT(s.title || d.title),
    bg: {
      image: hasImg(images, bg.image) ? bg.image : null,
      rotate: oneOf(bg.rotate, [0, 90, 180, 270], 0),
      fit: oneOf(bg.fit, ['contain', 'cover'], 'contain'),
      fade: clamp(bg.fade, 0, 0.8, 0),
    },
    symbols,
    custom,
    shapes,
    links,
    scale: cleanScale(s.scale),
    scaleBar: s.scaleBar !== false,
    thin: Object.fromEntries(
      Object.entries(s.thin && typeof s.thin === 'object' ? s.thin : {})
        .filter(([k, v]) => typeof k === 'string' && k.length < 60 && (v === 'faded' || v === 'hidden'))
        .slice(0, 100),
    ),
    showNumbers: s.showNumbers !== false,
    showList: s.showList !== false,
    showBus: bool(s.showBus),
    photoSpotsInPdf: s.photoSpotsInPdf !== false,
    legend: oneOf(s.legend, ['below', 'page', 'none'], 'below'),
  };
}

/** Darstellung je Objekt: Ebene, Aufhellen; Symbole zusätzlich Beschriftung und Erfassungsbereich. */
const FADES = [0, 0.4, 0.7];
function cleanLook(o, out, sym = false) {
  if (typeof o.layer === 'number' && Number.isFinite(o.layer)) out.layer = Math.max(-1e6, Math.min(1e6, o.layer));
  if (FADES.includes(o.fade) && o.fade) out.fade = o.fade;
  if (sym) {
    if (['left', 'right', 'top', 'bottom', 'none'].includes(o.labelPos)) out.labelPos = o.labelPos;
    if (o.cone === 'outline') out.cone = 'outline';
  }
  return out;
}

function cleanScale(v) {
  if (!v || typeof v !== 'object' || !Array.isArray(v.a) || !Array.isArray(v.b)) return null;
  const pt = (q) => [clamp(q[0], 0, 1, 0), clamp(q[1], 0, 1, 0)];
  const m = Number(v.m);
  if (!(m > 0 && m < 1e6)) return null;
  const a = pt(v.a);
  const b = pt(v.b);
  return a[0] === b[0] && a[1] === b[1] ? null : { a, b, m };
}

const TABLE_IDS = new Set(['table', 'faults', 'parts', 'scope']);

function cleanChapters(s, id, images) {
  const d = newChapters(s.kind === 'tech' ? 'tech' : 'manual');
  const cell = (v) => str_(v, 600);
  const blocks = [];
  for (const b of Array.isArray(s.blocks) ? s.blocks : []) {
    if (!b || typeof b !== 'object') continue;
    const base = { id: id(b.id, 'k'), type: b.type };
    if (b.type === 'h') blocks.push({ ...base, level: oneOf(b.level, [1, 2, 3], 1), text: toT(b.text) });
    else if (b.type === 'p') blocks.push({ ...base, text: toT(b.text), ...(b.small === true ? { small: true } : {}) });
    else if (b.type === 'ul' || b.type === 'steps') blocks.push({ ...base, text: toT(b.text) });
    else if (b.type === 'signs') blocks.push(base);
    else if (b.type === 'cards')
      blocks.push({
        ...base,
        items: (Array.isArray(b.items) ? b.items : [])
          .filter((c) => c && typeof c === 'object')
          .slice(0, 40)
          .map((c) => ({ id: id(c.id, 'c'), image: hasImg(images, c.image) ? c.image : null, title: toT(c.title), text: toT(c.text), fill: c.fill === true })),
      });
    else if (b.type === 'callout')
      blocks.push({ ...base, tone: oneOf(b.tone, TONES.map((t) => t.id), 'note'), title: toT(b.title), text: toT(b.text) });
    else if (b.type === 'figure')
      blocks.push({
        ...base,
        image: hasImg(images, b.image) ? b.image : null,
        caption: toT(b.caption),
        width: oneOf(b.width, ['full', 'half', 'side'], 'full'),
        marks: (Array.isArray(b.marks) ? b.marks : [])
          .filter((m) => m && typeof m === 'object')
          .slice(0, 60)
          .map((m) => ({
            id: id(m.id, 'm'),
            x: clamp(m.x, 0, 1, 0.5),
            y: clamp(m.y, 0, 1, 0.5),
            side: oneOf(m.side, ['auto', 'l', 'r'], 'auto'),
            ly: typeof m.ly === 'number' ? clamp(m.ly, -0.2, 1.2, null) : null,
            name: toT(m.name),
            desc: toT(m.desc),
          })),
        legend: b.legend !== false,
        aside: { title: toT(b.aside && b.aside.title), text: toT(b.aside && b.aside.text) },
      });
    else if (b.type === 'figsteps')
      blocks.push({ ...base, image: hasImg(images, b.image) ? b.image : null, caption: toT(b.caption), text: toT(b.text) });
    else if (b.type === 'code' || b.type === 'formula') blocks.push({ ...base, text: str_(b.text, 8000) });
    else if (b.type === 'table') {
      const cols = Math.max(1, Math.min(6, Array.isArray(b.head) ? b.head.length : 2));
      const head = Array.from({ length: cols }, (_, i) => cell(Array.isArray(b.head) ? b.head[i] : ''));
      const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 200).map((r) => Array.from({ length: cols }, (_, i) => cell(Array.isArray(r) ? r[i] : '')));
      const weights = Array.from({ length: cols }, (_, i) => clamp(Array.isArray(b.weights) ? b.weights[i] : 1, 0.2, 10, 1));
      // englische Fassung der Zellen (zweisprachige Bedienungsanleitung)
      const en = b.en && typeof b.en === 'object' ? b.en : {};
      const enHead = Array.from({ length: cols }, (_, i) => cell(Array.isArray(en.head) ? en.head[i] : ''));
      const enRows = rows.map((_, r) => Array.from({ length: cols }, (_, i) => cell(Array.isArray(en.rows) && Array.isArray(en.rows[r]) ? en.rows[r][i] : '')));
      blocks.push({ ...base, preset: TABLE_IDS.has(b.preset) ? b.preset : 'table', caption: toT(b.caption), head, rows, weights, en: { head: enHead, rows: enRows } });
    }
  }
  return {
    id: id(s.id, 's'),
    type: 'chapters',
    kind: d.kind,
    title: toT(s.title || d.title),
    numbering: s.numbering !== false,
    blocks,
  };
}

function cleanPhotos(s, id, images) {
  const d = newPhotos();
  const items = (Array.isArray(s.items) ? s.items : [])
    .filter((p) => p && typeof p === 'object' && hasImg(images, p.image))
    .map((p) => ({
      id: id(p.id, 'f'),
      image: p.image,
      caption: toT(p.caption),
      date: typeof p.date === 'string' && DATE_RE.test(p.date) ? p.date : '',
      link: typeof p.link === 'string' && ID_RE.test(p.link) ? p.link : null,
    }));
  return {
    id: id(s.id, 's'),
    type: 'photos',
    title: toT(s.title || d.title),
    perPage: oneOf(s.perPage, PHOTO_LAYOUTS, 4),
    showDate: s.showDate !== false,
    inPdf: s.inPdf !== false,
    items,
  };
}

function cleanAccess(s, id) {
  const d = newAccess();
  const blocks = s.blocks && typeof s.blocks === 'object' ? s.blocks : {};
  const hide = s.hide && typeof s.hide === 'object' ? s.hide : {};
  const network = s.network && typeof s.network === 'object' ? s.network : {};
  const list = (rows, make, prefix) =>
    (Array.isArray(rows) ? rows : [])
      .filter((r) => r && typeof r === 'object')
      .map((r) => {
        const out = make();
        for (const [k, v] of Object.entries(out))
          if (k === 'id') out.id = id(r.id, prefix);
          else if (k === 'sym' || k === 'link') out[k] = typeof r[k] === 'string' && ID_RE.test(r[k]) ? r[k] : null;
          else if (k === 'users')
            out.users = (Array.isArray(r.users) ? r.users : [])
              .filter((u) => u && typeof u === 'object')
              .slice(0, 50)
              .map((u) => ({ id: id(u.id, 'n'), user: str_(u.user, 200), password: str_(u.password, 500), role: str_(u.role, 80) }));
          else out[k] = typeof v === 'object' ? toT(r[k]) : str_(r[k], 500);
        return out;
      });
  return {
    id: id(s.id, 's'),
    type: 'access',
    title: toT(s.title || d.title),
    showPasswords: bool(s.showPasswords),
    blocks: Object.fromEntries(Object.keys(d.blocks).map((k) => [k, k in blocks ? bool(blocks[k]) : d.blocks[k]])),
    hide: Object.fromEntries(
      Object.keys(d.hide).map((k) => [k, Array.isArray(hide[k]) ? hide[k].filter((x) => typeof x === 'string').slice(0, 20) : d.hide[k]]),
    ),
    devices: list(s.devices, newDevice, 'd'),
    network: Object.fromEntries(Object.entries(d.network).map(([k, v]) => [k, typeof v === 'object' ? toT(network[k]) : str_(network[k], 200)])),
    wifi: list(s.wifi, newWifi, 'w'),
    remote: list(s.remote, newRemote, 'r'),
    ...(s.secretsRemoved ? { secretsRemoved: true } : {}),
  };
}

/** Name eines Abschnitts für Listen und das Inhaltsverzeichnis. */
export function sectionTitle(section, lang = 'de') {
  if (section.type === 'cover') return lang === 'en' ? 'Cover' : 'Deckblatt';
  if (section.type === 'toc') return str('toc', lang);
  if (section.type === 'wiring') {
    const sys = tx(section.system, lang);
    return str('wiring', lang) + (sys ? ' ' + sys : '');
  }
  if (section.type === 'access') return tx(section.title, lang) || str('access', lang);
  if (section.type === 'site') return tx(section.title, lang) || str('sitePlan', lang);
  if (section.type === 'photos') return tx(section.title, lang) || str('photos', lang);
  if (section.type === 'chapters') return tx(section.title, lang) || str('chapters', lang);
  return section.type;
}

/** Dateiname-tauglicher Titel des Projekts. */
export function projectName(project) {
  const site = project.meta.site || project.meta.customer;
  const main = project.sections.find((s) => s.type === 'wiring');
  const base = tx(project.title, langsOf(project)[0]);
  if (project.template === 'wiring' && main) return sectionTitle(main, langsOf(project)[0]);
  return site ? `${base} ${site}` : base;
}

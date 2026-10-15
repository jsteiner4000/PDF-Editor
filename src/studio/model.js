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
  access: T('Zugangsdaten', 'Access data'),
  continued: T('Fortsetzung', 'continued'),
  sitePlan: T('Lageplan', 'Site plan'),
  deviceList: T('Geräteliste', 'Device list'),
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
];

/** Leerer Lageplan. */
export const newSite = () => ({
  id: uid('s'),
  type: 'site',
  title: T('Lageplan', 'Site plan'),
  bg: { image: null, rotate: 0, fit: 'contain', fade: 0 },
  symbols: [],
  custom: [],
  showNumbers: true,
  showList: true,
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
    scale: 1,
    fov: !!(info && info.fov),
    dir: 0,
    angle: info && info.fov ? info.fov.angle : 90,
    range: info && info.fov ? info.fov.range : 60,
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

/** Nummern der Symbole: Kennung → „K 1“ (je Kürzel fortlaufend in der Reihenfolge der Liste). */
export function symbolLabels(site) {
  const count = new Map();
  const out = new Map();
  for (const sym of site.symbols) {
    const info = symbolInfo(site, sym.kind);
    if (!info) continue;
    const n = (count.get(info.code) || 0) + 1;
    count.set(info.code, n);
    out.set(sym.id, `${info.code} ${n}`);
  }
  return out;
}

/* ---------- Fotodokumentation ---------- */

export const PHOTO_LAYOUTS = [1, 2, 4, 6];

export const newPhotos = () => ({
  id: uid('s'),
  type: 'photos',
  title: T('Fotodokumentation', 'Photo documentation'),
  perPage: 4,
  showDate: true,
  items: [],
});

export const newPhoto = (image, date = '') => ({ id: uid('f'), image, caption: T('', ''), date, link: null });

/** Alle Symbole des Projekts mit ihrer Nummer: [{ id, label, name, section }] (für Fotoverknüpfungen). */
export function projectSymbols(project, lang = 'de') {
  const out = [];
  for (const s of project.sections) {
    if (s.type !== 'site') continue;
    const labels = symbolLabels(s);
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
  if (section.type === 'site') return !section.symbols.length && !section.bg.image;
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
  faults: { head: ['Störung', 'Mögliche Ursache', 'Abhilfe'], weights: [1.1, 1.4, 1.6] },
  parts: { head: ['Pos.', 'Bezeichnung'], weights: [0.5, 4] },
  scope: { head: ['Menge', 'Bezeichnung'], weights: [0.6, 4] },
  table: { head: ['Spalte 1', 'Spalte 2'], weights: [1, 1] },
};

export function newBlock(type, extra = {}) {
  const id = uid('k');
  if (type === 'h') return { id, type, level: 1, text: T('', ''), ...extra };
  if (type === 'p' || type === 'ul') return { id, type, text: T('', ''), ...extra };
  if (type === 'steps') return { id, type, text: T('', ''), ...extra };
  if (type === 'callout') return { id, type, tone: 'note', title: T('', ''), text: T('', ''), ...extra };
  if (type === 'figure') return { id, type, image: null, caption: T('', ''), width: 'full', ...extra };
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
    ...extra,
  };
}

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
  name: T('', ''),
  ip: '',
  web: '',
  user: '',
  password: '',
  note: T('', ''),
  model: '',
  serial: '',
  mac: '',
  firmware: '',
  location: T('', ''),
});

export const newWifi = () => ({ id: uid('w'), ssid: '', key: '', security: 'WPA2', note: T('', '') });

export const newRemote = () => ({ id: uid('r'), service: '', address: '', user: '', password: '', note: T('', '') });

/** Kopie des Projekts ohne Passwörter/Schlüssel in Zugangsdaten, die sie nicht zeigen sollen. */
export function withoutSecrets(project, show = null) {
  const copy = JSON.parse(JSON.stringify({ ...project, images: undefined }));
  copy.images = project.images;
  for (const s of copy.sections) {
    if (s.type !== 'access' || (show ?? s.showPasswords)) continue;
    for (const block of ACCESS_BLOCKS)
      for (const col of block.columns || [])
        if (col.secret) for (const row of s[block.list] || []) row[col.key] = '';
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
    desc: 'Deckblatt, Inhalt, Kapitel mit Schritten, Warnhinweisen und Störungstabelle',
    sections: () => [{ id: uid('s'), type: 'cover' }, { id: uid('s'), type: 'toc' }, starterChapters('manual')],
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

export function newProject(templateId = 'documentation', opts = {}) {
  const template = TEMPLATES.find((t) => t.id === templateId) || TEMPLATES[0];
  return {
    v: MODEL_VERSION,
    id: uid('prj'),
    template: template.id,
    lang: opts.lang || 'de',
    font: opts.font || 'helvetica',
    title: template.title,
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
    sections: template.sections(),
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
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections)) throw new Error('Kein PDFix-Projekt');
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
  }
  // Fotoverknüpfungen nur auf Symbole, die es gibt
  const symbolIds = new Set(project.sections.flatMap((s) => (s.type === 'site' ? s.symbols.map((y) => y.id) : [])));
  for (const s of project.sections) if (s.type === 'photos') for (const p of s.items) if (p.link && !symbolIds.has(p.link)) p.link = null;
  return project;
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
    .map((y) => ({
      id: id(y.id, 'y'),
      kind: kindOf(y.kind),
      x: clamp(y.x, 0, 1, 0.5),
      y: clamp(y.y, 0, 1, 0.5),
      name: toT(y.name),
      note: toT(y.note),
      scale: clamp(y.scale, 0.5, 2.5, 1),
      fov: bool(y.fov),
      dir: clamp(y.dir, -360, 720, 0),
      angle: clamp(y.angle, 5, 360, 90),
      range: clamp(y.range, 10, 600, 60),
    }));
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
    showNumbers: s.showNumbers !== false,
    showList: s.showList !== false,
  };
}

const TABLE_IDS = new Set(['table', 'faults', 'parts', 'scope']);

function cleanChapters(s, id, images) {
  const d = newChapters(s.kind === 'tech' ? 'tech' : 'manual');
  const cell = (v) => str_(v, 600);
  const blocks = [];
  for (const b of Array.isArray(s.blocks) ? s.blocks : []) {
    if (!b || typeof b !== 'object') continue;
    const base = { id: id(b.id, 'k'), type: b.type };
    if (b.type === 'h') blocks.push({ ...base, level: oneOf(b.level, [1, 2], 1), text: toT(b.text) });
    else if (b.type === 'p' || b.type === 'ul' || b.type === 'steps') blocks.push({ ...base, text: toT(b.text) });
    else if (b.type === 'callout')
      blocks.push({ ...base, tone: oneOf(b.tone, TONES.map((t) => t.id), 'note'), title: toT(b.title), text: toT(b.text) });
    else if (b.type === 'figure')
      blocks.push({
        ...base,
        image: hasImg(images, b.image) ? b.image : null,
        caption: toT(b.caption),
        width: oneOf(b.width, ['full', 'half'], 'full'),
      });
    else if (b.type === 'figsteps')
      blocks.push({ ...base, image: hasImg(images, b.image) ? b.image : null, caption: toT(b.caption), text: toT(b.text) });
    else if (b.type === 'code' || b.type === 'formula') blocks.push({ ...base, text: str_(b.text, 8000) });
    else if (b.type === 'table') {
      const cols = Math.max(1, Math.min(6, Array.isArray(b.head) ? b.head.length : 2));
      const head = Array.from({ length: cols }, (_, i) => cell(Array.isArray(b.head) ? b.head[i] : ''));
      const rows = (Array.isArray(b.rows) ? b.rows : []).slice(0, 200).map((r) => Array.from({ length: cols }, (_, i) => cell(Array.isArray(r) ? r[i] : '')));
      const weights = Array.from({ length: cols }, (_, i) => clamp(Array.isArray(b.weights) ? b.weights[i] : 1, 0.2, 10, 1));
      blocks.push({ ...base, preset: TABLE_IDS.has(b.preset) ? b.preset : 'table', caption: toT(b.caption), head, rows, weights });
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

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

/** Leitungsarten wie im Anschlussplan-Vorbild (Farben exakt übernommen). */
export const DEFAULT_CATEGORIES = () => [
  { id: 'sig', name: T('Signalleitung', 'Signal line'), color: '#1f3b4d' },
  { id: 'ls', name: T('Lichtschranke', 'Light barrier'), color: '#15803d' },
  { id: 'led', name: T('Leuchten', 'Lights'), color: '#b91c1c' },
  { id: 'pwr', name: T('Ton und Versorgung', 'Sound and supply'), color: '#b45309' },
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

/**
 * Beispiel aus der Vorlage „Anschlussplan Zufallsgenerator“ – zum Ausprobieren und als Maßstab,
 * dass der Plan exakt so entsteht wie das Vorbild.
 */
export function exampleWiring() {
  const w = newWiring();
  w.system = T('Zufallsgenerator', 'Random generator');
  w.hub = {
    name: T('Arduino Uno'),
    short: T('Arduino'),
    model: T('ATmega328P'),
    note: T('A1 bleibt frei\n(Zufallsstart)', 'A1 stays free\n(random seed)'),
    pins: [],
  };
  const box = (id, title, lines, cat, side, extra = {}) =>
    w.boxes.push({ ...newBox(cat, side), id, title: T(title), lines: T(lines), ...extra });
  box('display', 'Display 4D Systems', 'Logo, Gesamtzahl und\nRot-Durchgänge\nTX an D2, RX an D3\n(Leitungen gekreuzt)\n5 V und GND vom Arduino', 'sig', 'left', { y: 16, h: 84, pinY: 54, pinGap: 16 });
  box('key', 'Schlüsselschalter', 'Startet das Auslesen\nSchließer gegen GND', 'sig', 'left', { y: 120, h: 56, pinY: 30 });
  box('ls1', 'Lichtschranke 1 (vorn)', 'Satel ACTIVA-6\nRelaisausgang gegen GND\noffen = unterbrochen', 'ls', 'left', { badge: true, y: 200, h: 72 });
  box('ls2', 'Lichtschranke 2 (hinten)', 'Satel ACTIVA-6\nRelaisausgang gegen GND\noffen = unterbrochen', 'ls', 'left', { badge: true, y: 294, h: 72 });
  box('relay', 'Relaismodul 3-fach', 'IN1 = Rot an D5\nIN2 = Grün an D6\nIN3 = Blau an D7\nschaltet bei HIGH-Pegel\n5 V und GND vom Arduino', 'led', 'right', { y: 16, h: 90, pinY: 50 });
  box('lights', 'Leuchten am Tor', 'Rot / Grün / Blau\nüber die Relaiskontakte', 'led', 'right', { badge: true, parent: 'relay', y: 122, h: 58 });
  box('amp', 'Verstärker + Lautsprecher', 'Tonsignal von D9\n5 V und GND vom Arduino', 'pwr', 'right', { y: 190, h: 58, pinY: 16 });
  box('sd', 'MicroSD-Modul', 'CS = D10, MOSI = D11\nMISO = D12, SCK = D13\n5 V und GND vom Arduino', 'sig', 'right', { bus: true, y: 258, h: 66, pinY: 24 });
  box('rtc', 'Uhr DS3231', 'SDA = A4, SCL = A5\n5 V und GND vom Arduino', 'sig', 'right', { bus: true, y: 348, h: 58, pinY: 28 });
  box('psu', 'Netzteil 12 V DC', 'Versorgt den Arduino über die Hohlbuchse, beide Lichtschranken und die Lastseite\nder Relais für die Leuchten.\nDie 5 V für Display, Relaismodul, Verstärker, SD-Karte und Uhr erzeugt der Arduino selbst.\nGND ist im ganzen Aufbau gemeinsam - alle Massen müssen zusammengelegt werden.', 'pwr', 'bottom', { fill: true, fillColor: '#fdf6ec', y: 492, h: 82 });
  const pin = (name, func, box, terminal, note, label = '') =>
    w.hub.pins.push({ ...newPin(name, box), label, func: T(func), terminal: T(terminal), note: T(note) });
  pin('D2', 'Display empfangen', 'display', 'TX', 'SoftwareSerial, gekreuzt');
  pin('D3', 'Display senden', 'display', 'RX', 'SoftwareSerial, gekreuzt');
  pin('D4', 'unbenutzt', null, '', 'bleibt frei');
  pin('D5', 'Leuchte Rot', 'relay', 'IN1', 'HIGH schaltet ein');
  pin('D6', 'Leuchte Grün', 'relay', 'IN2', 'HIGH schaltet ein');
  pin('D7', 'Leuchte Blau', 'relay', 'IN3', 'Ruhezustand, dauerhaft an');
  pin('D9', 'Tonausgabe', 'amp', 'Verstärkermodul', 'Rechtecksignal');
  pin('D10', 'SD Chip Select', 'sd', 'CS', '');
  pin('D11', 'SD Daten hinein', 'sd', 'MOSI', '');
  pin('D12', 'SD Daten heraus', 'sd', 'MISO', '');
  pin('D13', 'SD Takt', 'sd', 'SCK', 'Onboard-LED liegt parallel');
  pin('A0', 'Schlüsselschalter', 'key', 'Schalter gegen GND', 'geschlossen startet das Auslesen');
  pin('A1', 'frei', null, '', 'muss frei bleiben, Zufallsstart');
  pin('A2', 'Lichtschranke 1', 'ls1', 'Relaisausgang LS 1', 'gegen GND, offen = unterbrochen');
  pin('A3', 'Lichtschranke 2', 'ls2', 'Relaisausgang LS 2', 'gegen GND, offen = unterbrochen');
  pin('A4', 'Uhr Daten', 'rtc', 'SDA', '');
  pin('A5', 'Uhr Takt', 'rtc', 'SCL', '');
  pin('5V', 'Versorgung 5 V', null, 'Display, Relais, Verstärker, SD, Uhr', '');
  pin('GND', 'Masse', null, 'alle Baugruppen', 'gemeinsame Masse');
  pin('DC', 'Versorgung', 'psu', 'Netzteil 12 V', 'Hohlbuchse', 'Hohlbuchse');
  // „Angeschlossen an“ wie im Vorbild: Baugruppe + Klemme
  const named = { display: 'Display', relay: 'Relaismodul', sd: 'MicroSD', rtc: 'DS3231' };
  for (const p of w.hub.pins) if (named[p.box]) p.terminal = T(`${named[p.box]} ${p.terminal.de}`);
  w.hints = [
    { id: uid('h'), cat: 'ls', title: T('Lichtschranken'), text: T('Der Alarmausgang der ACTIVA ist ein Relaiskontakt. Eine Seite liegt auf GND, die andere geht direkt auf A2 beziehungsweise A3. Der Arduino schaltet dort seinen internen Pull-Up ein, ein zusätzlicher Widerstand ist nicht nötig. Kontakt geschlossen bedeutet Strahl frei, Kontakt offen bedeutet unterbrochen. Nach dem Einschalten der Versorgung ist der Kontakt zunächst offen - deshalb müssen beide Schranken einmal angelernt werden.') },
    { id: uid('h'), cat: '#2e6e8e', title: T('Schlüsselschalter'), text: T('Ein einfacher Schließer zwischen A0 und GND. Ein zusätzlicher Widerstand ist nicht nötig, der Arduino schaltet an diesem Eingang seinen internen Pull-Up ein. Geschlossener Kontakt startet das Auslesen.') },
    { id: uid('h'), cat: 'pwr', title: T('Masse'), text: T('Alle Baugruppen und das Netzteil müssen eine gemeinsame Masse haben. Fehlt die Verbindung zwischen Netzteil-Minus und Arduino-GND, arbeiten die Lichtschranken nicht zuverlässig.') },
  ];
  return w;
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
    desc: 'Deckblatt, Inhaltsverzeichnis, Anschlussplan, Zugangsdaten',
    sections: () => [{ id: uid('s'), type: 'cover' }, { id: uid('s'), type: 'toc' }, newWiring(), newAccess()],
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
    company: { name: 'Doitronic', tagline: T('Sicherheits- und Kommunikationstechnik', 'Security and communication technology'), logo: null },
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
  const images = {};
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
      logo: typeof company.logo === 'string' && images[company.logo] ? company.logo : null,
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
  }
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

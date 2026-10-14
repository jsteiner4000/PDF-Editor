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

/* ---------- Projekt ---------- */

/** Vorlagen für neue Projekte. */
export const TEMPLATES = [
  {
    id: 'documentation',
    title: T('Anlagendokumentation', 'System documentation'),
    desc: 'Deckblatt, Inhaltsverzeichnis, Anschlussplan – später Lageplan und Fotos',
    sections: () => [{ id: uid('s'), type: 'cover' }, { id: uid('s'), type: 'toc' }, newWiring()],
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

/** Projekt nach dem Laden auf den aktuellen Stand bringen (fehlende Felder ergänzen). */
export function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.sections)) throw new Error('Kein PDFix-Projekt');
  const base = newProject(raw.template || 'documentation');
  const project = { ...base, ...raw, company: { ...base.company, ...(raw.company || {}) }, meta: { ...base.meta, ...(raw.meta || {}) } };
  project.images = raw.images && typeof raw.images === 'object' ? raw.images : {};
  project.sections = raw.sections.filter((s) => s && typeof s.type === 'string');
  for (const s of project.sections) {
    s.id ||= uid('s');
    if (s.type === 'wiring') {
      const d = newWiring();
      for (const key of Object.keys(d)) if (s[key] === undefined) s[key] = d[key];
      s.hub.pins ||= [];
    }
  }
  return project;
}

/** Name eines Abschnitts für Listen und das Inhaltsverzeichnis. */
export function sectionTitle(section, lang = 'de') {
  if (section.type === 'cover') return lang === 'en' ? 'Cover' : 'Deckblatt';
  if (section.type === 'toc') return str('toc', lang);
  if (section.type === 'wiring') {
    const sys = tx(section.system, lang);
    return str('wiring', lang) + (sys ? ' ' + sys : '');
  }
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

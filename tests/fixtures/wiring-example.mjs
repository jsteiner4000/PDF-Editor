/**
 * Beispiel-Anschlussplan für die Tests: Maßstab dafür, dass der Plan exakt nach dem Vorbild-Layout
 * entsteht (Lage aller Kästen und Leitungen). Nicht Teil der App.
 */
import { T, newBox, newPin, newProject, newWiring, uid } from '../../src/studio/model.js';

function exampleWiring() {
  const w = newWiring();
  w.system = T('Testaufbau', 'Test setup');
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

/** Vollständiges Projekt (Vorlage „Anschlussplan“) mit dem Beispiel als einzigem Abschnitt. */
export function exampleProject() {
  const project = newProject('wiring');
  project.sections = [exampleWiring()];
  return project;
}

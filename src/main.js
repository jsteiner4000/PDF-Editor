/**
 * Einstiegspunkt.
 */
import { App } from './app.js';
import { installDesktopBridge } from './platform/desktop-bridge.js';
import { StreamTooLargeError } from './pdf/pdf-objects.js';
import { toast } from './ui/dialogs.js';

window.addEventListener('DOMContentLoaded', () => {
  try {
    document.execCommand('defaultParagraphSeparator', false, 'p');
  } catch {}
  window.pdfEditor = new App(document.getElementById('app'));
  installDesktopBridge(window.pdfEditor);
});

// Eine Bearbeitung scheitert an einer Seite mit unzulässig großem Inhalt: verständlich melden,
// nichts überschreiben (die Seite bleibt unverändert).
window.addEventListener('unhandledrejection', (event) => {
  if (!(event.reason instanceof StreamTooLargeError)) return;
  event.preventDefault();
  toast('Diese Seite kann nicht bearbeitet werden: ' + event.reason.message, 'warn', 7000);
});

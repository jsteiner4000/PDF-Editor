/**
 * Einstiegspunkt.
 */
import { App } from './app.js';

window.addEventListener('DOMContentLoaded', () => {
  try {
    document.execCommand('defaultParagraphSeparator', false, 'p');
  } catch {}
  window.pdfEditor = new App(document.getElementById('app'));
});

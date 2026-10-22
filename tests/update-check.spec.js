import { test, expect } from '@playwright/test';
import { isNewer, pickUpdate, allowedUrl } from '../desktop/update-check.js';

/** Update-Prüfung (Desktop): Auswahl des Releases, Versionsvergleich, nur mit Prüfsumme und GitHub-Adresse. */

const release = (tag, name, extra = {}) => ({
  tag_name: tag,
  html_url: `https://github.com/jsteiner4000/PlantPDF/releases/tag/${tag}`,
  assets: [
    {
      name,
      size: 1000,
      digest: 'sha256:' + 'ab'.repeat(32),
      browser_download_url: `https://github.com/jsteiner4000/PlantPDF/releases/download/${tag}/${name}`,
      ...extra,
    },
  ],
});

test('Versionsvergleich', () => {
  expect(isNewer('2.18.0', '2.17.1')).toBe(true);
  expect(isNewer('2.17.10', '2.17.9')).toBe(true);
  expect(isNewer('2.17.1', '2.17.1')).toBe(false);
  expect(isNewer('v3.0.0', '2.99.99')).toBe(true);
  expect(isNewer('2.9.0', '2.17.0')).toBe(false);
});

test('Release auswählen: neuer, mit Setup und Prüfsumme', () => {
  const u = pickUpdate(release('v2.18.0', 'PlantPDF-Setup-2.18.0.exe'), '2.17.1');
  expect(u).toMatchObject({ version: '2.18.0', size: 1000, sha256: 'ab'.repeat(32) });
  // gleiche oder ältere Version: nichts
  expect(pickUpdate(release('v2.17.1', 'PlantPDF-Setup-2.17.1.exe'), '2.17.1')).toBeNull();
  // Tag und Dateiname passen nicht zusammen
  expect(pickUpdate(release('v2.18.0', 'PlantPDF-Setup-2.19.0.exe'), '2.17.1')).toBeNull();
  // fremde Download-Adresse
  expect(pickUpdate(release('v2.18.0', 'PlantPDF-Setup-2.18.0.exe', { browser_download_url: 'https://evil.example/x.exe' }), '2.17.1')).toBeNull();
  // Entwurf/Vorabversion: nichts
  expect(pickUpdate({ ...release('v2.18.0', 'PlantPDF-Setup-2.18.0.exe'), prerelease: true }, '2.17.1')).toBeNull();
  // ohne Prüfsumme: gefunden, aber sha256 null (dann nur Release-Seite öffnen)
  expect(pickUpdate(release('v2.18.0', 'PlantPDF-Setup-2.18.0.exe', { digest: null }), '2.17.1').sha256).toBeNull();
  expect(pickUpdate(null, '2.17.1')).toBeNull();
});

test('Erlaubte Adressen', () => {
  expect(allowedUrl('https://github.com/jsteiner4000/PlantPDF/releases/download/v1/x.exe')).toBe(true);
  expect(allowedUrl('https://release-assets.githubusercontent.com/abc')).toBe(true);
  expect(allowedUrl('http://github.com/x')).toBe(false);
  expect(allowedUrl('https://github.com.evil.example/x')).toBe(false);
});

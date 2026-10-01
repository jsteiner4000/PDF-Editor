/**
 * Smoke-Test der Desktop-App (Electron, Playwright `_electron`):
 * Start mit PDF als Kommandozeilenargument, Text bearbeiten, Speichern überschreibt die Datei,
 * Fenstertitel mit „Bearbeitet“, Rückfrage beim Schließen, zweite Instanz öffnet im laufenden
 * Fenster, „Zuletzt geöffnet“, Sicherheitsgrenzen des Renderers.
 *
 * Unter Linux ohne Anzeige wird der Test übersprungen, außer er läuft unter xvfb
 * (z. B. `xvfb-run -a npx playwright test tests/desktop.spec.js`).
 */
import { test, expect, _electron as electron } from '@playwright/test';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { idle, clientPoint, findBlock, extractText } from './helpers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = createRequire(import.meta.url)('electron'); // Pfad zur Electron-Binary
const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
// Als root (Container/CI) startet Chromium nur ohne OS-Sandbox; die Renderer-Sandbox-Option bleibt aktiv.
const extraArgs = process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [];

test.describe.configure({ mode: 'serial' });
test.skip(noDisplay, 'Keine Anzeige (DISPLAY) – mit xvfb-run starten');
test.skip(!existsSync(path.join(ROOT, 'dist', 'PDF-Editor.html')), 'dist/PDF-Editor.html fehlt');

const mainWindowTitle = (app) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());

async function waitForDocument(page, name) {
  await page.waitForFunction(
    (name) => window.pdfEditor && window.pdfEditor.session && window.pdfEditor.file.name === name,
    name,
    { timeout: 30_000 },
  );
  await page.waitForFunction(() => window.pdfEditor.library.items.size >= 10);
  await idle(page);
}

test('Desktop-App: öffnen per Kommandozeile, bearbeiten, speichern, schließen', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pdf-editor-desktop-'));
  const userData = path.join(dir, 'userdata');
  const pdf = path.join(dir, 'dokument.pdf');
  const second = path.join(dir, 'layout.pdf');
  copyFileSync(path.join(ROOT, 'tests', 'fixtures', 'dokument.pdf'), pdf);
  copyFileSync(path.join(ROOT, 'tests', 'fixtures', 'layout.pdf'), second);
  const original = readFileSync(pdf);
  const env = { ...process.env, PDF_EDITOR_USER_DATA: userData };

  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [ROOT, ...extraArgs, pdf],
    env,
    cwd: ROOT,
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text())); // z. B. CSP-Verstöße

    // 1. Per Kommandozeile übergebene Datei ist geöffnet, Titel = Dateiname
    await waitForDocument(page, 'dokument.pdf');
    await expect.poll(() => mainWindowTitle(app)).toBe('dokument.pdf – PDF-Editor');

    // 2. Renderer-Isolation: kein Node, keine Pfade, kein Netz
    const security = await page.evaluate(async () => {
      let net = 'blockiert';
      try {
        await fetch('https://example.com/');
        net = 'erreichbar';
      } catch {}
      return {
        require: typeof window.require,
        process: typeof window.process,
        bridge: Object.keys(window.pdfEditorDesktop).sort(),
        handle: JSON.stringify(window.pdfEditor.file.handle),
        origin: location.origin,
        net,
      };
    });
    expect(security.require).toBe('undefined');
    expect(security.process).toBe('undefined');
    expect(security.net).toBe('blockiert');
    expect(security.origin).toBe('app://pdf-editor');
    expect(Object.keys(JSON.parse(security.handle)).sort()).toEqual(['desktopId', 'kind', 'name']); // kein Pfad
    expect(security.bridge).toEqual(
      [
        'grantDroppedFile',
        'onCommand',
        'onOpenFile',
        'platform',
        'readFile',
        'ready',
        'setState',
        'showOpenDialog',
        'showSaveDialog',
        'writeFile',
      ].sort(),
    );

    // 3. Text bearbeiten → Titel zeigt „Bearbeitet“
    await page.locator('#lpBody .tool', { hasText: 'PDF bearbeiten' }).click();
    await idle(page);
    const block = await findBlock(page, 0, 'Zeilen läuft');
    const line = block.lines[1];
    const [x, y] = await clientPoint(page, 0, line.ex - 1, line.y + 3);
    await page.mouse.click(x, y);
    await page.waitForFunction(
      () => document.activeElement && document.activeElement.classList.contains('te'),
    );
    await page.keyboard.press('End');
    await page.keyboard.type(' Desktop');
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => !window.pdfEditor.edit.editor && !window.pdfEditor.edit._finishing);
    await idle(page);
    await expect.poll(() => mainWindowTitle(app)).toBe('dokument.pdf (Bearbeitet) – PDF-Editor');

    // 4. Strg+S überschreibt die geöffnete Datei (ohne Dialog)
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !window.pdfEditor.session.dirty);
    await expect.poll(() => mainWindowTitle(app)).toBe('dokument.pdf – PDF-Editor');
    const saved = readFileSync(pdf);
    expect(Buffer.compare(saved, original)).not.toBe(0);
    expect((await extractText(saved))[0]).toContain('Desktop');

    // 5. „Speichern unter“ (Strg+Umschalt+S) über den nativen Dialog, danach speichert Strg+S dorthin
    const copy = path.join(dir, 'kopie.pdf');
    await app.evaluate(({ dialog }, copy) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: copy.replace(/\.pdf$/, '') }); // ohne Endung
    }, copy);
    await page.keyboard.press('Control+Shift+s');
    await expect.poll(() => mainWindowTitle(app)).toBe('kopie.pdf – PDF-Editor');
    expect(readFileSync(copy).length).toBeGreaterThan(1000);
    expect(readFileSync(pdf).equals(saved)).toBe(true);

    // 6. Menü „Datei > Öffnen …“ mit nativem Dialog
    await app.evaluate(({ dialog, Menu }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      Menu.getApplicationMenu().getMenuItemById('open').click();
    }, pdf);
    await waitForDocument(page, 'dokument.pdf');
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('save').enabled)).toBe(
      true,
    );

    // 6b. „Anzeigen und drucken“: eigenes Fenster mit dem PDF-Betrachter (blob:-URL), ohne Bridge
    const previewOpened = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('print').click());
    const preview = await previewOpened;
    await expect.poll(() => preview.url()).toMatch(/^blob:app:\/\/pdf-editor\//);
    expect(await preview.evaluate(() => typeof window.pdfEditorDesktop)).toBe('undefined');
    await preview.close();

    // 7. Zweite Instanz mit anderer Datei → öffnet im laufenden Fenster, Prozess endet sofort
    const child = spawn(ELECTRON, [ROOT, ...extraArgs, second], { env, cwd: ROOT, stdio: 'ignore' });
    const exitCode = await new Promise((resolve) => child.on('exit', resolve));
    expect(exitCode).toBe(0);
    await waitForDocument(page, 'layout.pdf');
    expect(app.windows().length).toBe(1);

    // 8. „Zuletzt geöffnet“: Handle aus IndexedDB öffnet die Datei wieder
    await page.evaluate(() => window.pdfEditor.close());
    const recent = page.locator('#recentList .ri', { hasText: 'dokument.pdf' });
    await recent.waitFor();
    await recent.click();
    await waitForDocument(page, 'dokument.pdf');
    expect(await page.evaluate(() => window.pdfEditor.session.numPages)).toBeGreaterThan(0);

    // 9. Ungespeicherte Änderung → native Rückfrage beim Schließen („Abbrechen“ hält das Fenster offen)
    await page.evaluate(() => {
      window.pdfEditor.session.version++;
      window.pdfEditor.updateHist();
    });
    await expect.poll(() => mainWindowTitle(app)).toContain('(Bearbeitet)');
    await app.evaluate(({ dialog, BrowserWindow }) => {
      globalThis.__asked = [];
      dialog.showMessageBox = async (_win, options) => {
        globalThis.__asked.push(options.message);
        return { response: globalThis.__asked.length === 1 ? 2 : 1 }; // erst Abbrechen, dann Nicht speichern
      };
      BrowserWindow.getAllWindows()[0].close();
    });
    await expect.poll(() => app.evaluate(() => globalThis.__asked.length)).toBe(1);
    expect(await app.evaluate(() => globalThis.__asked[0])).toBe(
      'Möchten Sie die Änderungen an „dokument.pdf“ speichern?',
    );
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed;
    expect(readFileSync(pdf).equals(saved)).toBe(true); // „Nicht speichern“ ändert nichts
    // erwartet: nur die beiden CSP-Meldungen des absichtlich blockierten fetch() aus Schritt 2
    expect(errors.filter((e) => !e.includes('https://example.com/'))).toEqual([]);
  } finally {
    await app.close().catch(() => {});
  }
});

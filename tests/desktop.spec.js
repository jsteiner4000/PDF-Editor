/**
 * Smoke-Test der Desktop-App (Electron, Playwright `_electron`):
 * Start mit PDF als Kommandozeilenargument, Text bearbeiten, Speichern überschreibt die Datei,
 * Fenstertitel mit „Bearbeitet“, Rückfrage beim Schließen, zweite Instanz öffnet im laufenden
 * Fenster, „Zuletzt geöffnet“, Sicherheitsgrenzen des Renderers. Zweiter Test: Fehlerfälle
 * (schreibgeschützt, Symlink), Absturz des Renderers, Alt-Taste und Menübefehle.
 *
 * Unter Linux ohne Anzeige wird der Test übersprungen, außer er läuft unter xvfb
 * (z. B. `xvfb-run -a npx playwright test tests/desktop.spec.js`).
 */
import { test, expect, _electron as electron } from '@playwright/test';
import { spawn } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  existsSync,
  lstatSync,
  symlinkSync,
} from 'node:fs';
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
    args: [ROOT, ...extraArgs, second, pdf], // mehrere Dateien: die letzte wird geöffnet
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
    // bei Fehlschlag keine native Rückfrage offen lassen („Nicht speichern“)
    await app
      .evaluate(({ dialog }) => (dialog.showMessageBox = async () => ({ response: 1 })))
      .catch(() => {});
    await app.close().catch(() => {});
  }
});

/** Startet die App mit eigenem Datenordner; liefert App, Fenster und Arbeitsordner. */
async function launchWith(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'pdf-editor-desktop-'));
  const paths = files.map((name) => {
    const target = path.join(dir, name);
    copyFileSync(path.join(ROOT, 'tests', 'fixtures', 'dokument.pdf'), target);
    return target;
  });
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [ROOT, ...extraArgs, ...paths],
    env: { ...process.env, PDF_EDITOR_USER_DATA: path.join(dir, 'userdata') },
    cwd: ROOT,
  });
  const page = await app.firstWindow();
  await page.waitForFunction(() => window.pdfEditor && window.pdfEditor.library.items.size >= 10, null, {
    timeout: 30_000,
  });
  await page.evaluate(() => {
    window.__toastLog = [];
    new MutationObserver((records) => {
      for (const r of records)
        for (const n of r.addedNodes)
          if (n.classList && n.classList.contains('toast')) window.__toastLog.push(n.textContent);
    }).observe(document.getElementById('toasts'), { childList: true });
  });
  return { app, page, dir, paths };
}

const makeDirty = (page) =>
  page.evaluate(() => {
    window.pdfEditor.session.version++;
    window.pdfEditor.updateHist();
  });

test('Desktop-App: Fehlerfälle, Absturz, Alt-Taste, Menü', async () => {
  const { app, page, dir, paths } = await launchWith(['schreibgeschuetzt.pdf']);
  const [readonly] = paths;
  try {
    await waitForDocument(page, 'schreibgeschuetzt.pdf');

    // In-App-Menü „Datei“ ist in der Desktop-App ausgeblendet (natives Menü)
    await expect(page.locator('#bFile')).toBeHidden();

    // Schalter „Aktive Inhalte beim Speichern entfernen“: im nativen Menü, Zustand wird gespiegelt
    const stripItem = () =>
      app.evaluate(({ Menu }) => {
        const item = Menu.getApplicationMenu().getMenuItemById('stripActive');
        return { label: item.label, checked: item.checked, enabled: item.enabled };
      });
    expect(await stripItem()).toEqual({
      label: 'Aktive Inhalte beim Speichern entfernen',
      checked: true,
      enabled: true,
    });
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('stripActive').click());
    await expect.poll(() => page.evaluate(() => window.pdfEditor.stripActive)).toBe(false);
    await expect.poll(async () => (await stripItem()).checked).toBe(false);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('stripActive').click());
    await expect.poll(() => page.evaluate(() => window.pdfEditor.stripActive)).toBe(true);
    await expect.poll(async () => (await stripItem()).checked).toBe(true);

    // Schreibgeschützte Datei: klare Meldung ohne Pfad, Datei unverändert
    chmodSync(readonly, 0o444);
    const before = readFileSync(readonly);
    await makeDirty(page);
    expect(await page.evaluate(() => window.pdfEditor.save())).toBe(false);
    const toastLog = await page.evaluate(() => window.__toastLog);
    expect(toastLog.join('\n')).toContain('Die Datei ist schreibgeschützt.');
    expect(toastLog.join('\n')).not.toContain(dir);
    expect(readFileSync(readonly).equals(before)).toBe(true);
    chmodSync(readonly, 0o644);

    // Symbolischer Link: Ziel wird geschrieben, der Link bleibt erhalten (nicht unter Windows)
    if (process.platform !== 'win32') {
      const link = path.join(dir, 'verknuepfung.pdf');
      symlinkSync(readonly, link);
      await app.evaluate(({ dialog, Menu }, file) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
        Menu.getApplicationMenu().getMenuItemById('open').click();
      }, link);
      // ungespeicherte Änderung → In-App-Rückfrage; „Nicht speichern“
      // (die App fragt beim Öffnen zweimal: vor dem Dialog und vor dem Laden)
      for (let i = 0; i < 2; i++)
        await page.locator('.backdrop .btn', { hasText: 'Nicht speichern' }).click({ timeout: 5000 });
      await waitForDocument(page, 'verknuepfung.pdf');
      await makeDirty(page);
      expect(await page.evaluate(() => window.pdfEditor.save())).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(readonly).equals(before)).toBe(false);
    }

    // Menübefehle werden bei offenem App-Dialog ignoriert; Strg+1 / Strg+2 im Menü
    await page.evaluate(() => window.pdfEditor.setZoom(2));
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('zoomActual').click());
    await expect.poll(() => page.evaluate(() => window.pdfEditor.zoom)).toBe(1);
    expect(
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('zoomSelection').enabled),
    ).toBe(true);
    await page.evaluate(() => window.pdfEditor.props());
    await page.locator('.backdrop').waitFor();
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('zoomIn').click());
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.pdfEditor.zoom)).toBe(1);
    await page.keyboard.press('Escape');
    await page.locator('.backdrop').waitFor({ state: 'detached' });

    // Alt-Taste: Loslassen nach Alt+Klick erreicht das Menü nicht; Alt allein schon
    const alt = await app.evaluate(async ({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const seen = [];
      wc.on(
        'before-input-event',
        (e, i) => i.key === 'Alt' && i.type === 'keyUp' && seen.push(e.defaultPrevented),
      );
      const wait = () => new Promise((r) => setTimeout(r, 100));
      const send = async (ev) => (wc.sendInputEvent(ev), wait());
      await send({ type: 'keyDown', keyCode: 'Alt' });
      await send({ type: 'keyUp', keyCode: 'Alt' });
      await send({ type: 'keyDown', keyCode: 'Alt', modifiers: ['alt'] });
      await send({ type: 'mouseDown', x: 600, y: 400, button: 'left', clickCount: 1, modifiers: ['alt'] });
      await send({ type: 'mouseUp', x: 600, y: 400, button: 'left', clickCount: 1, modifiers: ['alt'] });
      await send({ type: 'keyUp', keyCode: 'Alt' });
      return seen;
    });
    if (process.platform !== 'darwin') expect(alt).toEqual([false, true]);

    // Vorschaufenster nur für PDFs: ein blob: mit HTML wird sofort geschlossen
    await page.evaluate(() =>
      window.open(URL.createObjectURL(new Blob(['<p>kein PDF</p>'], { type: 'text/html' })), '_blank'),
    );
    await page.waitForTimeout(1500);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);

    // Renderer-Absturz: Hinweis mit „Neu laden“, danach schließt das Fenster ohne Speichern-Rückfrage
    await makeDirty(page);
    await app.evaluate(({ dialog, BrowserWindow }) => {
      globalThis.__asked = [];
      dialog.showMessageBox = async (_win, options) => (
        globalThis.__asked.push(options.message),
        { response: 0 }
      );
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer();
    });
    await expect
      .poll(() => app.evaluate(() => globalThis.__asked))
      .toEqual(['Der PDF-Editor ist unerwartet abgestürzt.']);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const wc = BrowserWindow.getAllWindows()[0].webContents;
          return !wc.isCrashed() && !wc.isLoading() && wc.getURL();
        }),
      )
      .toBe('app://pdf-editor/');
    await expect.poll(() => mainWindowTitle(app)).toBe('PDF-Editor');
    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
    await closed;
    expect(await app.evaluate(() => globalThis.__asked).catch(() => 'beendet')).toBe('beendet');
  } finally {
    // bei Fehlschlag keine native Rückfrage offen lassen („Nicht speichern“)
    await app
      .evaluate(({ dialog }) => (dialog.showMessageBox = async () => ({ response: 1 })))
      .catch(() => {});
    await app.close().catch(() => {});
  }
});

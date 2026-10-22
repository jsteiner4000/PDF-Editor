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
import { PDFDocument, PDFName } from 'pdf-lib';
import { idle, clientPoint, findBlock, extractText } from './helpers.js';
import { exampleProject } from './fixtures/wiring-example.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = createRequire(import.meta.url)('electron'); // Pfad zur Electron-Binary
const noDisplay = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
// Als root (Container/CI) startet Chromium nur ohne OS-Sandbox; die Renderer-Sandbox-Option bleibt aktiv.
const extraArgs = process.getuid && process.getuid() === 0 ? ['--no-sandbox'] : [];

test.describe.configure({ mode: 'serial' });
test.skip(noDisplay, 'Keine Anzeige (DISPLAY) – mit xvfb-run starten');
test.skip(!existsSync(path.join(ROOT, 'dist', 'PDF-Editor.html')), 'dist/PDF-Editor.html fehlt');

const mainWindowTitle = (app) =>
  app.evaluate(({ BrowserWindow }) => globalThis.__plantpdf.win().getTitle());

const tabCount = (app) => app.evaluate(() => globalThis.__plantpdf.tabs().length);

/** Seite (Playwright) des aktiven Tabs im vorderen Fenster. */
async function activePage(app) {
  for (let i = 0; i < 150; i++) {
    const id = await app.evaluate(() => (globalThis.__plantpdf.tabs().find((t) => t.active && t.win === globalThis.__plantpdf.winId()) || {}).id);
    for (const p of app.windows()) {
      const self = await p.evaluate(() => window.pdfEditor && window.pdfEditor.tabHost && window.pdfEditor.tabHost.self).catch(() => null);
      if (self === id) return p;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`aktiver Tab nicht gefunden (${app.windows().length} Seiten)`);
}

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
    let page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text())); // z. B. CSP-Verstöße

    // 1. Per Kommandozeile übergebene Datei ist geöffnet, Titel = Dateiname
    await waitForDocument(page, 'dokument.pdf');
    await expect.poll(() => mainWindowTitle(app)).toBe('dokument.pdf – PlantPDF');

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
        'installUpdate',
        'makePdf',
        'onCommand',
        'onOpenFile',
        'platform',
        'popupMenu',
        'readFile',
        'ready',
        'setState',
        'showOpenDialog',
        'showSaveDialog',
        'tabs',
        'writeFile',
      ].sort(),
    );

    // 3. Text bearbeiten → Titel zeigt „Bearbeitet“
    await page.locator('#rbBar .rb[data-tool="edit"]').click();
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
    await expect.poll(() => mainWindowTitle(app)).toBe('dokument.pdf (Bearbeitet) – PlantPDF');

    // 4. Strg+S überschreibt die geöffnete Datei (ohne Dialog)
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => !window.pdfEditor.session.dirty);
    await expect.poll(() => mainWindowTitle(app)).toBe('dokument.pdf – PlantPDF');
    const saved = readFileSync(pdf);
    expect(Buffer.compare(saved, original)).not.toBe(0);
    expect((await extractText(saved))[0]).toContain('Desktop');

    // 5. „Speichern unter“ (Strg+Umschalt+S) über den nativen Dialog, danach speichert Strg+S dorthin
    const copy = path.join(dir, 'kopie.pdf');
    await app.evaluate(({ dialog }, copy) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: copy.replace(/\.pdf$/, '') }); // ohne Endung
    }, copy);
    await page.keyboard.press('Control+Shift+s');
    await expect.poll(() => mainWindowTitle(app)).toBe('kopie.pdf – PlantPDF');
    expect(readFileSync(copy).length).toBeGreaterThan(1000);
    expect(readFileSync(pdf).equals(saved)).toBe(true);

    // 6. Menü „Datei > Öffnen …“ mit nativem Dialog: weitere Datei → eigener Tab
    await app.evaluate(({ dialog, Menu }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      Menu.getApplicationMenu().getMenuItemById('open').click();
    }, pdf);
    await expect.poll(() => tabCount(app)).toBe(2);
    let tab = await activePage(app);
    await waitForDocument(tab, 'dokument.pdf');
    await expect(tab.locator('#tabs .xtab')).toHaveCount(2);
    expect(await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('save').enabled)).toBe(true);
    // die erste Datei läuft im ersten Tab unverändert weiter
    expect(await page.evaluate(() => window.pdfEditor.file.name)).toBe('kopie.pdf');

    // 6b. „Anzeigen und drucken“: eigenes Fenster mit dem PDF-Betrachter (blob:-URL), ohne Bridge
    const previewOpened = app.waitForEvent('window');
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('print').click());
    const preview = await previewOpened;
    await expect.poll(() => preview.url()).toMatch(/^blob:app:\/\/pdf-editor\//);
    expect(await preview.evaluate(() => typeof window.pdfEditorDesktop)).toBe('undefined');
    await preview.close();

    // 7. Zweite Instanz mit anderer Datei → neuer Tab im laufenden Fenster, Prozess endet sofort
    const child = spawn(ELECTRON, [ROOT, ...extraArgs, second], { env, cwd: ROOT, stdio: 'ignore' });
    const exitCode = await new Promise((resolve) => child.on('exit', resolve));
    expect(exitCode).toBe(0);
    await expect.poll(() => tabCount(app)).toBe(3);
    await waitForDocument(await activePage(app), 'layout.pdf');
    expect(await app.evaluate(() => globalThis.__plantpdf.windows())).toBe(1);
    // schon offene Datei noch einmal → kein neuer Tab, der vorhandene kommt nach vorn
    const again = spawn(ELECTRON, [ROOT, ...extraArgs, pdf], { env, cwd: ROOT, stdio: 'ignore' });
    await new Promise((resolve) => again.on('exit', resolve));
    await expect.poll(async () => (await activePage(app)).evaluate(() => window.pdfEditor.file.name)).toBe('dokument.pdf');
    expect(await tabCount(app)).toBe(3);

    // 8. Dokument schließen schließt seinen Tab; „Zuletzt geöffnet“ auf der Startseite (Haus-Symbol)
    tab = await activePage(app);
    await tab
      .evaluate(() => {
        setTimeout(() => window.pdfEditor.close(), 0);
      })
      .catch(() => {});
    await expect.poll(() => tabCount(app)).toBe(2);
    await (await activePage(app)).locator('#tHome').click();
    await expect.poll(() => tabCount(app)).toBe(3);
    const start = await activePage(app);
    await start.waitForFunction(() => window.pdfEditor && window.pdfEditor.library.items.size >= 10, null, { timeout: 30_000 });
    const recent = start.locator('#recentList .ri', { hasText: 'dokument.pdf' });
    await recent.waitFor();
    await recent.click();
    // öffnet in der Startseite (sie wird zum Dokument-Tab)
    await waitForDocument(start, 'dokument.pdf');
    expect(await start.evaluate(() => window.pdfEditor.session.numPages)).toBeGreaterThan(0);
    page = start;

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
      globalThis.__plantpdf.win().close();
    });
    await expect.poll(() => app.evaluate(() => globalThis.__asked.length)).toBe(1);
    expect(await app.evaluate(() => globalThis.__asked[0])).toBe(
      'Möchten Sie die Änderungen an „dokument.pdf“ speichern?',
    );
    expect(await app.evaluate(({ BrowserWindow }) => globalThis.__plantpdf.windows())).toBe(1);

    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => globalThis.__plantpdf.win().close());
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
  const launched = await launchWith(['schreibgeschuetzt.pdf']);
  const { app, dir, paths } = launched;
  let { page } = launched;
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

    // Eigene Titelleiste (Windows/Linux): Menüs in der Kopfzeile = das native Menü
    if (process.platform !== 'darwin') {
      expect(await page.evaluate(() => document.documentElement.classList.contains('frame'))).toBe(true);
      const native = await app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()
          .items.filter((i) => i.visible)
          .map((i) => i.label),
      );
      expect(await page.locator('.menubar .mb:not(.mb-all)').allTextContents()).toEqual(native);
      // Klick öffnet das Untermenü (bis es geschlossen wird, gilt der Knopf als aufgeklappt). Auf
      // kleinen Bildschirmen (z. B. 1024 px im CI) steht statt der fünf Menüs ein Menüknopf.
      const compact = await page.locator('.menubar .mb-all').isVisible();
      const first = compact ? page.locator('.menubar .mb-all') : page.locator('.menubar .mb', { hasText: 'Datei' });
      await first.click();
      await expect(first).toHaveAttribute('aria-expanded', 'true');
      await app.evaluate(({ Menu, BrowserWindow }, compact) => {
        const menu = Menu.getApplicationMenu();
        (compact ? menu : menu.items[0].submenu).closePopup(globalThis.__plantpdf.win());
      }, compact);
      await expect(first).toHaveAttribute('aria-expanded', 'false');
      // F10 setzt den Fokus in die Menüleiste, Pfeil rechts wechselt, Esc kehrt zurück
      await page.locator('#scroller').focus();
      await page.keyboard.press('F10');
      await expect(first).toBeFocused();
      if (!compact) {
        await page.keyboard.press('ArrowRight');
        await expect(page.locator('.menubar .mb', { hasText: 'Bearbeiten' })).toBeFocused();
      }
      await page.keyboard.press('Escape');
      await expect(page.locator('#scroller')).toBeFocused();
    }

    // Menü „Werkzeuge“: aktiv mit geöffneter PDF; „Ansicht“ zeigt den Bereich mit Häkchen
    const menuState = () =>
      app.evaluate(({ Menu }) => {
        const m = Menu.getApplicationMenu();
        return { edit: m.getMenuItemById('tool:edit').enabled, pdf: m.getMenuItemById('ws:pdf').checked };
      });
    await expect.poll(menuState).toEqual({ edit: true, pdf: true });
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('tool:organize').click());
    await expect.poll(() => page.evaluate(() => window.pdfEditor.tool)).toBe('organize');
    await page.locator('#oDone').click();

    // Einstellungen im nativen Menü: Dunkel gilt auch für Titelleiste und Systemdialoge
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('settings').click());
    await page.locator('.dlg .theme[data-v="dark"]').click();
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('dark');
    await page.locator('.dlg .theme[data-v="system"]').click();
    await expect.poll(() => app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe('system');
    await page.locator('.dlg .btn.primary').click();

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
      // öffnet in einem eigenen Tab – die ungespeicherte Änderung im ersten Tab bleibt, keine Rückfrage
      await expect.poll(() => tabCount(app)).toBe(2);
      const linked = await activePage(app);
      await waitForDocument(linked, 'verknuepfung.pdf');
      expect(await page.evaluate(() => window.pdfEditor.session.dirty)).toBe(true);
      await makeDirty(linked);
      expect(await linked.evaluate(() => window.pdfEditor.save())).toBe(true);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(readFileSync(readonly).equals(before)).toBe(false);
      // weiter im neuen Tab; die Änderung im ersten Tab verwerfen (keine Rückfrage beim Schließen)
      await page.evaluate(() => {
        const s = window.pdfEditor.session;
        s.savedVersion = s.version;
        window.pdfEditor.updateHist();
      });
      page = linked;
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
      const wc = globalThis.__plantpdf.contents();
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
    expect(await app.evaluate(({ BrowserWindow }) => globalThis.__plantpdf.windows())).toBe(1);

    // Renderer-Absturz: Hinweis mit „Neu laden“, danach schließt das Fenster ohne Speichern-Rückfrage
    await makeDirty(page);
    await app.evaluate(({ dialog, BrowserWindow }) => {
      globalThis.__asked = [];
      dialog.showMessageBox = async (_win, options) => (
        globalThis.__asked.push(options.message),
        { response: 0 }
      );
      globalThis.__plantpdf.contents().forcefullyCrashRenderer();
    });
    await expect
      .poll(() => app.evaluate(() => globalThis.__asked))
      .toEqual(['PlantPDF ist unerwartet abgestürzt.']);
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) => {
          const wc = globalThis.__plantpdf.contents();
          return !wc.isCrashed() && !wc.isLoading() && wc.getURL();
        }),
      )
      .toBe('app://pdf-editor/');
    await expect.poll(() => mainWindowTitle(app)).toBe('PlantPDF');
    const closed = app.waitForEvent('close');
    await app.evaluate(({ BrowserWindow }) => globalThis.__plantpdf.win().close());
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

test('Desktop-App: Schnelldruck (Windows-Verb „Drucken“, z. B. Outlook) ohne Fenster', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pdf-editor-print-'));
  const pdf = path.join(dir, 'ausdruck.pdf');
  copyFileSync(path.join(ROOT, 'tests', 'fixtures', 'dokument.pdf'), pdf);
  const pages = (await PDFDocument.load(readFileSync(pdf))).getPageCount();

  // 1. Programm läuft nicht: druckt (hier in eine PDF) und beendet sich wieder
  const out = path.join(dir, 'gedruckt.pdf');
  const env = {
    ...process.env,
    PDF_EDITOR_USER_DATA: path.join(dir, 'userdata'),
    PDF_EDITOR_PRINT_TO_PDF: out,
  };
  const child = spawn(ELECTRON, [ROOT, ...extraArgs, `--pdfix-print=${pdf}`], {
    env,
    cwd: ROOT,
    stdio: 'ignore',
  });
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => (child.kill(), reject(new Error('Schnelldruck beendet sich nicht'))),
      60_000,
    );
    child.on('exit', (code) => (clearTimeout(timer), resolve(code)));
  });
  expect(exitCode).toBe(0);
  expect(existsSync(out)).toBe(true);
  expect((await PDFDocument.load(readFileSync(out))).getPageCount()).toBe(pages);

  // 1b. Mehrere Dateien kurz nacheinander (Outlook, mehrere Anhänge): alle werden gedruckt
  const outMulti = path.join(dir, 'mehrere.pdf');
  const envMulti = { ...env, PDF_EDITOR_PRINT_TO_PDF: outMulti };
  const first = spawn(ELECTRON, [ROOT, ...extraArgs, `--pdfix-print=${pdf}`], {
    env: envMulti,
    cwd: ROOT,
    stdio: 'ignore',
  });
  const firstExit = new Promise((resolve) => first.on('exit', resolve));
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const more = spawn(ELECTRON, [ROOT, ...extraArgs, `--pdfix-print=${pdf}`], {
    env: envMulti,
    cwd: ROOT,
    stdio: 'ignore',
  });
  expect(await new Promise((resolve) => more.on('exit', resolve))).toBe(0);
  expect(await firstExit).toBe(0);
  expect(existsSync(outMulti)).toBe(true);
  expect(existsSync(outMulti.replace(/\.pdf$/, '-2.pdf'))).toBe(true);

  // 2. Programm läuft schon: druckt im Hintergrund, das geöffnete Dokument bleibt
  const out2 = path.join(dir, 'gedruckt-2.pdf');
  const env2 = { ...env, PDF_EDITOR_PRINT_TO_PDF: out2 };
  const second = path.join(dir, 'layout.pdf');
  copyFileSync(path.join(ROOT, 'tests', 'fixtures', 'layout.pdf'), second);
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [ROOT, ...extraArgs, second],
    env: env2,
    cwd: ROOT,
  });
  try {
    const page = await app.firstWindow();
    await waitForDocument(page, 'layout.pdf');
    const other = spawn(ELECTRON, [ROOT, ...extraArgs, `--pdfix-print=${pdf}`], {
      env: env2,
      cwd: ROOT,
      stdio: 'ignore',
    });
    expect(await new Promise((resolve) => other.on('exit', resolve))).toBe(0);
    await expect.poll(() => existsSync(out2), { timeout: 30_000 }).toBe(true);
    await expect(page.locator('.toast', { hasText: 'an den Drucker gesendet' })).toBeVisible();
    expect(await page.evaluate(() => window.pdfEditor.file.name)).toBe('layout.pdf');
    expect(app.windows().length).toBe(1);
  } finally {
    await app.close().catch(() => {});
  }
});

test('Desktop-App: Dokumentation erstellen – PDF mit Projektdaten, wieder bearbeitbar', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'pdf-editor-studio-'));
  const app = await electron.launch({
    executablePath: ELECTRON,
    args: [ROOT, ...extraArgs],
    env: { ...process.env, PDF_EDITOR_USER_DATA: path.join(dir, 'userdata') },
    cwd: ROOT,
  });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));
    await page.waitForFunction(() => window.pdfEditor && window.pdfEditor.library.items.size >= 10);
    await page.evaluate((p) => window.pdfEditor.studio.open(p), exampleProject());
    await expect(page.locator('#studio .sd-page')).toHaveCount(2);
    // PDF über den Hauptprozess (ohne Speichern-Dialog)
    const b64 = await page.evaluate(async () => {
      const bytes = await window.pdfEditor.studio.buildPdf();
      let s = '';
      for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const bytes = Buffer.from(b64, 'base64');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(2);
    const [w, h] = [doc.getPage(0).getWidth(), doc.getPage(0).getHeight()];
    expect(Math.abs(w - 595.28) < 1 && Math.abs(h - 841.89) < 1).toBe(true);
    expect(doc.getTitle()).toBe('Anschlussplan Testaufbau');
    expect(String(doc.catalog.get(PDFName.of('PDFixProject')))).toMatch(/ 0 R$/);
    const text = (await extractText(bytes)).join('\n');
    expect(text).toContain('Anschlussplan');
    expect(text).toContain('Belegung der Arduino-Anschlüsse');
    expect(text).toContain('Seite 2 von 2');

    // Wieder öffnen (eigener Tab): PlantPDF bietet die Dokumentation zum Weiterbearbeiten an
    await page.evaluate(async (b64) => {
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      await window.pdfEditor.openBytes(bytes, 'plan.pdf', null);
    }, b64);
    await expect.poll(() => tabCount(app)).toBe(2);
    const pdfTab = await activePage(app);
    await expect(pdfTab.locator('#sdOffer')).toBeVisible();
    await pdfTab.locator('#sdOffer .btn.primary').click();
    // dieselbe Dokumentation ist schon offen: ihr Tab kommt nach vorn (kein zweiter)
    await expect.poll(async () => (await activePage(app)) === page).toBe(true);
    expect(await tabCount(app)).toBe(2);
    await expect(page.locator('#studio')).toBeVisible();
    expect(await page.evaluate(() => window.pdfEditor.studio.project.sections[0].hub.pins.length)).toBe(20);
    // Menü „Werkzeuge › Lageplan“: aus, solange es keinen Lageplan gibt; danach startet es das Werkzeug
    const siteItem = () => app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('site:fence').enabled);
    expect(await siteItem()).toBe(false);
    await page.evaluate(() => window.pdfEditor.studio.addSection('site'));
    await expect.poll(siteItem).toBe(true);
    await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('site:fence').click());
    await expect.poll(() => page.evaluate(() => window.pdfEditor.studio.armed)).toBe('tool:fence');
    await expect(page.locator('#sdArm')).toContainText('Eckpunkte');
    await page.keyboard.press('Escape');
    expect(errors).toEqual([]);
  } finally {
    await app.close();
  }
});

test('Desktop-App: Tabs – zweite PDF im neuen Tab, umordnen, herausziehen, zurückziehen, Rückfrage je Tab', async () => {
  const { app, page, paths } = await launchWith(['a.pdf', 'b.pdf']);
  try {
    // beim Start mit zwei Dateien öffnet die letzte; die erste kommt per Menü in einen zweiten Tab
    await waitForDocument(page, 'b.pdf');
    await app.evaluate(({ dialog, Menu }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      Menu.getApplicationMenu().getMenuItemById('open').click();
    }, paths[0]);
    await expect.poll(() => tabCount(app)).toBe(2);
    const a = await activePage(app);
    await waitForDocument(a, 'a.pdf');
    const names = (p) => p.locator('#tabs .xtab .nm').allTextContents();
    await expect.poll(() => names(a)).toEqual(['b.pdf', 'a.pdf']);
    await expect(a.locator('#tabs .xtab.on .nm')).toHaveText('a.pdf');

    // Klick auf den anderen Tab wechselt; Fenstertitel folgt
    await a.locator('#tabs .xtab', { hasText: 'b.pdf' }).click();
    await expect.poll(() => mainWindowTitle(app)).toBe('b.pdf – PlantPDF');

    // Umordnen per Ziehen in der Leiste
    const b = await activePage(app);
    const box = await b.locator('#tabs .xtab', { hasText: 'b.pdf' }).boundingBox();
    const target = await b.locator('#tabs .xtab', { hasText: 'a.pdf' }).boundingBox();
    await b.mouse.move(box.x + 30, box.y + box.height / 2);
    await b.mouse.down();
    for (let i = 1; i <= 8; i++) await b.mouse.move(box.x + 30 + ((target.x + target.width - 20 - box.x - 30) * i) / 8, box.y + box.height / 2);
    await b.mouse.up();
    await expect.poll(() => names(b)).toEqual(['a.pdf', 'b.pdf']);

    // Herausziehen (losgelassen außerhalb des Fensters): eigenes Fenster
    const bounds = await app.evaluate(() => globalThis.__plantpdf.win().getContentBounds());
    const id = await b.evaluate(() => window.pdfEditor.tabHost.self);
    await b.evaluate(([id, x, y]) => window.pdfEditorDesktop.tabs.drop(id, x, y), [id, bounds.x + 200, bounds.y + bounds.height + 300]);
    await expect.poll(() => app.evaluate(() => globalThis.__plantpdf.windows())).toBe(2);
    const tabs = await app.evaluate(() => globalThis.__plantpdf.tabs());
    expect(new Set(tabs.map((t) => t.win)).size).toBe(2);
    // der verschobene Tab behält seinen Zustand (keine neue Ansicht)
    expect(await b.evaluate(() => window.pdfEditor.file.name)).toBe('b.pdf');

    // Zurückziehen auf die Tab-Leiste des ersten Fensters: wieder ein Fenster mit zwei Tabs
    const first = await app.evaluate(() => {
      const t = globalThis.__plantpdf.tabs().find((x) => x.name === 'a.pdf');
      return t.win;
    });
    const firstBounds = await app.evaluate((_e, wid) => globalThis.__plantpdf.boundsOf(wid), first);
    await b.evaluate(([id, x, y]) => window.pdfEditorDesktop.tabs.drop(id, x, y), [id, firstBounds.x + 400, firstBounds.y + 20]);
    await expect.poll(() => app.evaluate(() => globalThis.__plantpdf.windows())).toBe(1);
    expect(await tabCount(app)).toBe(2);

    // Fenster schließen: Rückfrage für jeden geänderten Tab (beide), „Abbrechen“ beim zweiten hält offen
    await makeDirty(a);
    await makeDirty(b);
    await app.evaluate(({ dialog }) => {
      globalThis.__asked = [];
      dialog.showMessageBox = async (_win, options) => {
        globalThis.__asked.push(options.message);
        return { response: globalThis.__asked.length === 1 ? 1 : 2 }; // erst „Nicht speichern“, dann „Abbrechen“
      };
      globalThis.__plantpdf.win().close();
    });
    await expect.poll(() => app.evaluate(() => globalThis.__asked.length)).toBe(2);
    expect(await app.evaluate(() => globalThis.__plantpdf.windows())).toBe(1);
  } finally {
    await app.evaluate(({ dialog }) => (dialog.showMessageBox = async () => ({ response: 1 }))).catch(() => {});
    await app.close().catch(() => {});
  }
});

// Playwright-Konfiguration für die Regressionstests (Original 1.0 vs. Neubau).
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests',
  testMatch: /.*\.spec\.js/,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : 4,
  reporter: [['list']],
  outputDir: 'test-results',
  use: {
    browserName: 'chromium',
    headless: true,
    viewport: { width: 1400, height: 1000 },
    deviceScaleFactor: 1,
    acceptDownloads: true,
    locale: 'de-DE',
    timezoneId: 'Europe/Berlin',
  },
});

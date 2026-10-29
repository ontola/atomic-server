import { defineConfig } from '@playwright/test';

/**
 * Config for the documentation screenshots (`pnpm docs:screenshots`).
 * Not part of the e2e suite: it has its own testDir and runs one worker, in
 * order, because scenes share a server and a fake model endpoint.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '*.spec.ts',
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    screenshot: 'only-on-failure',
    locale: 'en-US',
    timezoneId: 'Europe/Amsterdam',
    actionTimeout: 15_000,
    launchOptions: { args: ['--force-color-profile=srgb'] },
  },
});

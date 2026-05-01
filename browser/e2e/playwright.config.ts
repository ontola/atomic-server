import type { PlaywrightTestConfig } from '@playwright/test';
import { devices } from '@playwright/test';

const config: PlaywrightTestConfig = {
  use: {
    screenshot: 'only-on-failure',
    viewport: { width: 1200, height: 800 },
    locale: 'en-GB',
    timezoneId: 'Europe/Amsterdam',
    actionTimeout: 5000,
    trace: 'retain-on-failure',
    storageState: {
      cookies: [],
      origins: [
        {
          origin: 'http://localhost:5173',
          localStorage: [{ name: 'viewTransitionsDisabled', value: 'true' }],
        },
        {
          origin: 'http://localhost:9883',
          localStorage: [{ name: 'viewTransitionsDisabled', value: 'true' }],
        },
        {
          origin: 'http://atomic:9883',
          localStorage: [{ name: 'viewTransitionsDisabled', value: 'true' }],
        },
      ],
    },
  },
  reporter: [
    [
      'html',
      {
        // attachmentsBaseURL: '://external-storage.com/',
        // outputFolder: '/artifact/test-report',
        open: 'never',
      },
    ],
  ],
  retries: 0,
  // timeout: 1000 * 120, // 2 minutes
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // CI sets ATOMIC_TEST_INSECURE_ORIGIN to the http:// origin of the
        // atomic-server (e.g. `http://atomic:9883` in the dagger pipeline).
        // The SPA's WASM ClientDb uses `crypto.subtle`, which only works in
        // "secure contexts" — `localhost`/`*.localhost` qualify, but a
        // dagger service-binding alias like `atomic` does not. We tell
        // chromium to treat that origin as secure so the WASM init can
        // complete; otherwise every test times out at `beforeEach`.
        launchOptions: process.env.ATOMIC_TEST_HOST_MAP
          ? {
              // CI sets ATOMIC_TEST_HOST_MAP to a chromium host-resolver-rules
              // string like `MAP atomic.localhost atomic` so the browser
              // resolves a `*.localhost` hostname (which it treats as a
              // secure context, exposing `crypto.subtle`) to the actual
              // dagger service. Without a secure origin the SPA's WASM
              // ClientDb fails to init and every test hangs.
              args: [`--host-resolver-rules=${process.env.ATOMIC_TEST_HOST_MAP}`],
            }
          : undefined,
      },
    },
  ],
  // projects: [
  //   {
  //     name: 'chromium',
  //     use: { ...devices['Desktop Chrome'] },
  //   },
  //   {
  //     name: 'firefox',
  //     use: { ...devices['Desktop Firefox'] },
  //   },
  //   {
  //     name: 'webkit',
  //     use: { ...devices['Desktop Safari'] },
  //   },
  // ],
  fullyParallel: true,
};

export default config;

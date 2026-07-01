import type { PlaywrightTestConfig } from '@playwright/test';
import { devices } from '@playwright/test';

const config: PlaywrightTestConfig = {
  // Default `expect` timeout. Playwright's built-in is 5s; bump to 10s
  // so retrying assertions match the action timeout below. Tests that
  // need a longer specific budget still pass `{ timeout: ... }` directly.
  expect: { timeout: 10000 },
  use: {
    screenshot: 'only-on-failure',
    viewport: { width: 1200, height: 800 },
    locale: 'en-GB',
    timezoneId: 'Europe/Amsterdam',
    // 10s actionTimeout. The atomic-server runs as a single process behind
    // every test (dev-drives, commits, search index, WS handshake all on
    // one box). On CI the server is in a smaller container and runs
    // noticeably slower than a dev laptop — the default 5s budget started
    // catching real round-trips, not bugs. 10s covers the slow path
    // without hiding genuine hangs.
    actionTimeout: 10000,
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
  // Up to 2 retries on CI — the dagger container has noticeably less
  // CPU than a dev laptop, and the shared atomic-server occasionally
  // surfaces transient WS / search-index / multi-context-sync races
  // that don't reproduce serially. Two retries (3 attempts total)
  // catches genuinely flaky paths without hiding real regressions:
  // a regression fails three times. Matches nextest's `retries = 2`.
  retries: process.env.CI ? 2 : 0,
  // Per-test budget — not a race-prevention timeout. Playwright's
  // default is 30s; some tests (chatroom invite flow, share menu,
  // tables) legitimately run 25–35s when the shared atomic-server is
  // under suite-wide load. Bumping to 60s gives them headroom without
  // masking real hangs. Specific assertions inside tests still have
  // their own targeted timeouts.
  timeout: 60_000,
  projects: [
    {
      name: 'chromium',
      // No `testMatch` — chromium runs the whole suite (incl. the locks spec).
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
              args: [
                `--host-resolver-rules=${process.env.ATOMIC_TEST_HOST_MAP}`,
              ],
            }
          : undefined,
      },
    },
    // Firefox runs ONLY the ClientDb locks spec — it guards the hardened
    // Firefox leadership path (no Chromium lock-steal). The rest of the suite
    // stays chromium-only (the SPA targets Chromium-class browsers). Skipped
    // when ATOMIC_TEST_HOST_MAP is set: that's the dagger CI's non-localhost
    // origin, where the secure-context (`crypto.subtle`) workaround is a
    // chromium-only `--host-resolver-rules` flag, so the WASM ClientDb can't
    // init on Firefox there. Locally (localhost is a secure context) it runs.
    ...(process.env.ATOMIC_TEST_HOST_MAP
      ? []
      : [
          {
            name: 'firefox',
            testMatch: /client-db-locks\.spec\.ts/,
            use: { ...devices['Desktop Firefox'] },
          },
        ]),
  ],
  fullyParallel: true,
  // 2 workers for speed. CI uses 1 worker + retries=2; locally we
  // prefer the speed and depend on the tests themselves to be
  // robust against the contention storms the shared atomic-server
  // produces.
  workers: process.env.CI ? 1 : 2,
};

export default config;

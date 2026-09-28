import { Agent } from '@tomic/lib';
import {
  applyCpuThrottle,
  envCpuThrottle,
  registerPerfPage,
} from './perf-attach';
import { test as base, expect, type Page, type TestInfo } from './fixtures';
import {
  currentDriveTitle,
  devDrive,
  FRONTEND_URL,
  getDevDriveSecret,
  installCommitWatcher,
} from './test-utils';

/**
 * One agent and drive per worker, for specs that only LOOK at a drive.
 *
 * `before` (`/app/dev-drive`) pays for a cold boot, a key pair and a
 * server-side `createDrive` in every test: about 3.5s on an idle box, against
 * 0.7s to open an existing drive as an existing agent. Measured on the e2e
 * server on 28 September 2026, 5 rounds each. A spec that never writes to the
 * drive it is given does not need a fresh one per test.
 *
 * Tests in one worker share the drive, so do not use this where a test
 * creates, renames or counts resources, or where another test's leftovers
 * could satisfy or break an assertion. Each test still gets its own browser
 * context, so localStorage, IndexedDB and routes never carry over.
 */
export type SharedDevDrive = {
  secret: string;
  subject: string;
  /** Everything the app kept in localStorage: server, drive and settings. */
  localStorage: Record<string, string>;
};

export const test = base.extend<object, { sharedDevDrive: SharedDevDrive }>({
  sharedDevDrive: [
    async ({ browser }, use) => {
      const context = await browser.newContext();
      const page = await context.newPage();

      await installCommitWatcher(page);
      await devDrive(page);
      const secret = await getDevDriveSecret(page);
      const subject = await Agent.privateDriveSubjectFromSecret(secret);
      const localStorage = await page.evaluate(() =>
        Object.fromEntries(
          Object.keys(window.localStorage).map(key => [
            key,
            window.localStorage.getItem(key) ?? '',
          ]),
        ),
      );

      // The drive is created by the app, so let its own writes settle before
      // other contexts start reading it.
      await expect
        .poll(() =>
          page.evaluate(() => window.store.getSyncStatus().pendingDirtyCount),
        )
        .toBe(0);
      await context.close();
      await use({ secret, subject, localStorage });
    },
    { scope: 'worker', timeout: 120_000 },
  ],
});

export * from '@playwright/test';

/**
 * Drop-in for `before` that opens the worker's shared drive as its agent.
 *
 * The agent is written to IndexedDB in its plaintext-fallback form, which is
 * what `getAgentFromIDB` reads when no CryptoKey pair is stored. A
 * `storageState` copy does not work: non-extractable keys do not survive JSON.
 * The write happens on a static page first and is awaited, so it cannot race
 * the app's own read.
 */
export const beforeShared = async (
  { page, sharedDevDrive }: { page: Page; sharedDevDrive: SharedDevDrive },
  testInfo?: TestInfo,
): Promise<void> => {
  const throttle = envCpuThrottle();
  if (throttle) await applyCpuThrottle(page, throttle);

  if (testInfo) registerPerfPage(testInfo, page);

  await installCommitWatcher(page);
  await test.step('Open the shared agent and drive', async () => {
    const { secret, subject, localStorage } = sharedDevDrive;

    await page.goto(`${FRONTEND_URL}/robots.txt`);
    await page.evaluate(
      async ({ agentSecret, driveSubject, settings }) => {
        for (const [key, value] of Object.entries(settings)) {
          window.localStorage.setItem(key, value);
        }

        window.localStorage.setItem(
          'atomic-test.dev-drive-secret',
          agentSecret,
        );
        const parsed = JSON.parse(atob(agentSecret));
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
          const open = indexedDB.open('keyval-store');
          open.onupgradeneeded = () => open.result.createObjectStore('keyval');
          open.onsuccess = () => resolve(open.result);
          open.onerror = () => reject(open.error);
        });
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction('keyval', 'readwrite');
          tx.objectStore('keyval').put(
            {
              privateKey: parsed.privateKey,
              subject: parsed.subject,
              initialDrive: parsed.initialDrive,
              privateDrive: driveSubject,
            },
            'atomic.agent.fallback',
          );
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      },
      { agentSecret: secret, driveSubject: subject, settings: localStorage },
    );
    await page.goto(
      `${FRONTEND_URL}/app/show?subject=${encodeURIComponent(subject)}`,
    );
    await expect(currentDriveTitle(page)).toBeVisible({ timeout: 30_000 });
  });
};

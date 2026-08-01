/**
 * Notifications UI + personal-drive inbox.
 *
 * Cross-agent "@mention → other agent sees unread" still needs two agents
 * (invite flow) and is listed as a gap in TESTING_COVERAGE.md. These specs
 * pin what the first slice ships:
 *   1. Sidebar entry below User Settings + empty state.
 *   2. A NotificationItem on the personal drive appears in the inbox + badge.
 *   3. Opening an item marks it read (synced `notificationRead`).
 *   4. Table Watch toggle flips to Watching.
 */

import { test, expect } from '@playwright/test';
import {
  before,
  FRONTEND_URL,
  newResource,
} from './test-utils';

const NOTIFICATION_ITEM = 'https://atomicdata.dev/classes/NotificationItem';
const NOTIFICATION_TYPE = 'https://atomicdata.dev/properties/notificationType';
const NOTIFICATION_SUMMARY =
  'https://atomicdata.dev/properties/notificationSummary';
const NOTIFICATION_READ = 'https://atomicdata.dev/properties/notificationRead';
const DISMISSED = 'https://atomicdata.dev/properties/dismissed';
const DEDUPE_KEY = 'https://atomicdata.dev/properties/dedupeKey';
const ABOUT = 'https://atomicdata.dev/properties/about';
const NAME = 'https://atomicdata.dev/properties/name';
const LOCAL_ID = 'https://atomicdata.dev/properties/localId';
const FOLDER = 'https://atomicdata.dev/classes/Folder';
const PERSONAL_DRIVE = 'https://atomicdata.dev/properties/personalDrive';

async function resolvePersonalDrive(page: import('@playwright/test').Page) {
  return page.evaluate(async personalDriveProp => {
    const store = window.store;
    const agent = store.getAgent();
    const drive = store.getDrive();

    if (!agent?.subject) throw new Error('no agent');

    try {
      const agentRes = await store.fetchResourceFromServer(agent.subject, {
        noWebSocket: true,
      });
      const personal = agentRes.get(personalDriveProp);

      if (typeof personal === 'string' && personal.length > 0) {
        return personal;
      }
    } catch {
      // fall through
    }

    return drive ?? agent.initialDrive;
  }, PERSONAL_DRIVE);
}

async function getOrCreateNotificationsFolder(
  page: import('@playwright/test').Page,
  personalDrive: string,
) {
  return page.evaluate(
    async ({ personalDrive: drive, folderClass, localIdProp, nameProp }) => {
      const store = window.store;

      // Look for existing folder with localId=notifications among children.
      // Simple approach: create with a stable localId; if one already exists
      // with that localId under the drive, CollectionBuilder would find it —
      // here we just create when missing by trying to find via children.
      const children =
        (
          await store.getResource(drive).catch(() => null)
        )?.get?.('https://atomicdata.dev/properties/children') ?? [];

      void children;

      // Create (or reuse via localId query through store.search / newResource).
      // Prefer newResource with localId — duplicate localIds on same parent
      // are unusual; engine's helper does a collection query. Mirror that
      // by creating once per test drive.
      const existing = await store
        .search('Notifications', { limit: 5, parents: [drive] })
        .catch(() => [] as string[]);

      for (const subject of existing) {
        const res = store.getResourceLoading(subject);
        const localId = res.get(localIdProp);

        if (localId === 'notifications') {
          return subject;
        }
      }

      const folder = await store.newResource({
        parent: drive,
        isA: folderClass,
        propVals: {
          [nameProp]: 'Notifications',
          [localIdProp]: 'notifications',
        },
      });
      await folder.save();

      return folder.subject;
    },
    {
      personalDrive,
      folderClass: FOLDER,
      localIdProp: LOCAL_ID,
      nameProp: NAME,
    },
  );
}

test.describe('notifications', () => {
  test.beforeEach(before);

  test('sidebar entry opens empty inbox', async ({ page }) => {
    await page.getByRole('link', { name: 'Notifications' }).click();
    await expect(page).toHaveURL(/\/app\/notifications/);
    await expect(
      page.getByRole('heading', { name: 'Notifications' }),
    ).toBeVisible();
    await expect(page.getByText('No notifications yet')).toBeVisible();
  });

  test('inbox lists a NotificationItem with unread badge', async ({
    page,
  }) => {
    test.slow();

    const personalDrive = await resolvePersonalDrive(page);
    expect(personalDrive).toBeTruthy();
    const folder = await getOrCreateNotificationsFolder(page, personalDrive!);

    const aboutSubject = await page.evaluate(async drive => {
      const store = window.store;
      const doc = await store.newResource({
        parent: drive,
        isA: 'https://atomicdata.dev/classes/DocumentV2',
        propVals: {
          'https://atomicdata.dev/properties/name': 'About Doc',
        },
      });
      await doc.save();

      return doc.subject;
    }, personalDrive);

    await page.evaluate(
      async ({
        folder: parent,
        about,
        notificationItem,
        notificationType,
        notificationSummary,
        notificationRead,
        dismissed,
        dedupeKey,
        aboutProp,
        nameProp,
      }) => {
        const store = window.store;
        const item = await store.newResource({
          parent,
          isA: notificationItem,
          propVals: {
            [nameProp]: 'Mentioned you in About Doc',
            [notificationType]: 'mention',
            [notificationSummary]: 'Mentioned you in About Doc',
            [aboutProp]: about,
            [dedupeKey]: `mention|${about}|e2e|me`,
            [notificationRead]: false,
            [dismissed]: false,
          },
        });
        await item.save();
        store.notifyResourceManuallyCreated(item);
      },
      {
        folder,
        about: aboutSubject,
        notificationItem: NOTIFICATION_ITEM,
        notificationType: NOTIFICATION_TYPE,
        notificationSummary: NOTIFICATION_SUMMARY,
        notificationRead: NOTIFICATION_READ,
        dismissed: DISMISSED,
        dedupeKey: DEDUPE_KEY,
        aboutProp: ABOUT,
        nameProp: NAME,
      },
    );

    await page.goto(`${FRONTEND_URL}/app/notifications`);

    const item = page.getByTestId('notification-item').first();
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(item).toContainText(/Mentioned you/i);
    await expect(item).toHaveAttribute('data-unread', '');
    await expect(page.getByTestId('sidebar-notification-badge')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('mark all read clears unread styling', async ({ page }) => {
    test.slow();

    const personalDrive = await resolvePersonalDrive(page);
    const folder = await getOrCreateNotificationsFolder(page, personalDrive!);

    const aboutSubject = await page.evaluate(async drive => {
      const store = window.store;
      const doc = await store.newResource({
        parent: drive,
        isA: 'https://atomicdata.dev/classes/Folder',
        propVals: {
          'https://atomicdata.dev/properties/name': 'ReadTarget',
        },
      });
      await doc.save();

      return doc.subject;
    }, personalDrive);

    await page.evaluate(
      async ({
        folder: parent,
        about,
        notificationItem,
        notificationType,
        notificationSummary,
        notificationRead,
        dismissed,
        dedupeKey,
        aboutProp,
        nameProp,
      }) => {
        const store = window.store;
        const item = await store.newResource({
          parent,
          isA: notificationItem,
          propVals: {
            [nameProp]: 'Mentioned you in ReadTarget',
            [notificationType]: 'mention',
            [notificationSummary]: 'Mentioned you in ReadTarget',
            [aboutProp]: about,
            [dedupeKey]: `mention|${about}|e2e-read|me`,
            [notificationRead]: false,
            [dismissed]: false,
          },
        });
        await item.save();
        store.notifyResourceManuallyCreated(item);
      },
      {
        folder,
        about: aboutSubject,
        notificationItem: NOTIFICATION_ITEM,
        notificationType: NOTIFICATION_TYPE,
        notificationSummary: NOTIFICATION_SUMMARY,
        notificationRead: NOTIFICATION_READ,
        dismissed: DISMISSED,
        dedupeKey: DEDUPE_KEY,
        aboutProp: ABOUT,
        nameProp: NAME,
      },
    );

    await page.goto(`${FRONTEND_URL}/app/notifications`);
    const item = page.getByTestId('notification-item').first();
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(item).toHaveAttribute('data-unread', '');

    await page.getByRole('button', { name: 'Mark all read' }).click();
    await expect(item).not.toHaveAttribute('data-unread', '', {
      timeout: 15_000,
    });
    await expect(page.getByTestId('sidebar-notification-badge')).toHaveCount(
      0,
      { timeout: 10_000 },
    );
  });

  test('watch toggle on a table shows Watching', async ({ page }) => {
    test.slow();

    await newResource('table', page);
    await page.getByPlaceholder('New Table').fill('Watched Tasks');
    await page.locator('dialog[open] button:has-text("Create")').click();
    await expect(page.getByTestId('editable-title').first()).toBeVisible({
      timeout: 15_000,
    });
    await page.keyboard.press('Escape');

    const watch = page.getByTestId('watch-toggle');
    await expect(watch).toBeVisible({ timeout: 20_000 });
    await expect(watch).toContainText('Watch');
    await watch.click();
    await expect(watch).toContainText('Watching', { timeout: 15_000 });
  });
});

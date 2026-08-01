/**
 * Notifications UI + personal-drive inbox.
 *
 * Cross-agent "@mention → other agent sees unread" via invite is still a
 * gap (two distinct agents). These specs pin shipped behaviour:
 *   1. Sidebar entry below User Settings + empty state.
 *   2. A NotificationItem on the personal drive appears in the inbox + badge.
 *   3. Opening an item marks it read (synced `notificationRead`).
 *   4. Table Watch toggle flips to Watching.
 *   5. Watch → simulated other-agent row → inbox item (engine path).
 *   6. Mention ResourceUpdated (other actor) → inbox item (engine path).
 *   7. Mark read on device A clears badge on device B (same agent, two contexts).
 */

import { test, expect } from '@playwright/test';
import {
  before,
  FRONTEND_URL,
  getDevDriveSecret,
  newResource,
  openNewSubjectWindow,
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
const CREATED_BY = 'https://atomicdata.dev/properties/createdBy';
const PARENT = 'https://atomicdata.dev/properties/parent';
const DOCUMENT = 'https://atomicdata.dev/classes/DocumentV2';
const MENTIONS = 'https://atomicdata.dev/properties/mentions';

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

async function seedUnreadItem(
  page: import('@playwright/test').Page,
  opts: { folder: string; about: string; summary: string; dedupeKey: string },
) {
  await page.evaluate(
    async ({
      folder: parent,
      about,
      summary,
      dedupeKey: key,
      notificationItem,
      notificationType,
      notificationSummary,
      notificationRead,
      dismissed,
      dedupeKeyProp,
      aboutProp,
      nameProp,
    }) => {
      const store = window.store;
      const item = await store.newResource({
        parent,
        isA: notificationItem,
        propVals: {
          [nameProp]: summary,
          [notificationType]: 'mention',
          [notificationSummary]: summary,
          [aboutProp]: about,
          [dedupeKeyProp]: key,
          [notificationRead]: false,
          [dismissed]: false,
        },
      });
      await item.save();
      store.notifyResourceManuallyCreated(item);
    },
    {
      folder: opts.folder,
      about: opts.about,
      summary: opts.summary,
      dedupeKey: opts.dedupeKey,
      notificationItem: NOTIFICATION_ITEM,
      notificationType: NOTIFICATION_TYPE,
      notificationSummary: NOTIFICATION_SUMMARY,
      notificationRead: NOTIFICATION_READ,
      dismissed: DISMISSED,
      dedupeKeyProp: DEDUPE_KEY,
      aboutProp: ABOUT,
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
    await expect(page.getByTestId('notifications-empty')).toBeVisible();
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

    await seedUnreadItem(page, {
      folder,
      about: aboutSubject,
      summary: 'Mentioned you in About Doc',
      dedupeKey: `mention|${aboutSubject}|e2e|me`,
    });

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

    await seedUnreadItem(page, {
      folder,
      about: aboutSubject,
      summary: 'Mentioned you in ReadTarget',
      dedupeKey: `mention|${aboutSubject}|e2e-read|me`,
    });

    await page.goto(`${FRONTEND_URL}/app/notifications`);
    const item = page.getByTestId('notification-item').first();
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(item).toHaveAttribute('data-unread', '');

    await page.getByTestId('mark-all-read').click();
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
    await expect(watch).toHaveAttribute('data-watching', 'false', {
      timeout: 10_000,
    });
    await watch.click();
    await expect(watch).toHaveAttribute('data-watching', 'true', {
      timeout: 15_000,
    });
  });

  test('watch table + other-agent child materializes inbox item', async ({
    page,
  }) => {
    test.slow();

    await newResource('table', page);
    await page.getByPlaceholder('New Table').fill('Watch Fire Table');
    await page.locator('dialog[open] button:has-text("Create")').click();
    await expect(page.getByTestId('editable-title').first()).toBeVisible({
      timeout: 15_000,
    });
    await page.keyboard.press('Escape');

    const watch = page.getByTestId('watch-toggle');
    await expect(watch).toBeVisible({ timeout: 20_000 });
    await watch.click();
    await expect(watch).toHaveAttribute('data-watching', 'true', {
      timeout: 15_000,
    });

    const tableSubject = await page.evaluate(() => {
      const url = new URL(window.location.href);

      return url.searchParams.get('subject') ?? window.store.getDrive();
    });
    expect(tableSubject).toBeTruthy();

    await page.evaluate(
      async ({ table, createdByProp, parentProp, nameProp, docClass }) => {
        const store = window.store;
        const engine = (
          window as Window & {
            __notificationEngine?: {
              reloadWatches: () => Promise<void>;
              flushPendingWatches: () => Promise<void>;
            };
          }
        ).__notificationEngine;

        if (!engine) {
          throw new Error('__notificationEngine not ready');
        }

        await engine.reloadWatches();

        const child = await store.newResource({
          parent: table,
          isA: docClass,
          propVals: {
            [nameProp]: 'Foreign Row',
            [parentProp]: table,
          },
        });
        await child.set(createdByProp, 'did:ad:agent:otherE2EActor', false);
        store.notifyResourceUpdated(child);
        await new Promise(r => setTimeout(r, 250));
        await engine.flushPendingWatches();
      },
      {
        table: tableSubject,
        createdByProp: CREATED_BY,
        parentProp: PARENT,
        nameProp: NAME,
        docClass: DOCUMENT,
      },
    );

    await page.goto(`${FRONTEND_URL}/app/notifications`);
    const item = page.getByTestId('notification-item').first();
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(item).toContainText(/Update in Watch Fire Table|updates in/i);
  });

  test('mention ResourceUpdated materializes inbox item', async ({ page }) => {
    test.slow();

    const personalDrive = await resolvePersonalDrive(page);
    const myAgent = await page.evaluate(() => window.store.getAgent()?.subject);
    expect(myAgent).toBeTruthy();

    await page.evaluate(
      async ({
        drive,
        me,
        createdByProp,
        mentionsProp,
        nameProp,
        docClass,
      }) => {
        const store = window.store;
        const engine = (
          window as Window & { __notificationEngine?: unknown }
        ).__notificationEngine;

        if (!engine) {
          throw new Error('__notificationEngine not ready');
        }

        const doc = await store.newResource({
          parent: drive,
          isA: docClass,
          propVals: {
            [nameProp]: 'Mention Host Doc',
            [mentionsProp]: [me],
          },
        });
        await doc.set(createdByProp, 'did:ad:agent:mentionActorE2E', false);
        store.notifyResourceUpdated(doc);
        await new Promise(r => setTimeout(r, 400));
      },
      {
        drive: personalDrive,
        me: myAgent,
        createdByProp: CREATED_BY,
        mentionsProp: MENTIONS,
        nameProp: NAME,
        docClass: DOCUMENT,
      },
    );

    await page.goto(`${FRONTEND_URL}/app/notifications`);
    const item = page.getByTestId('notification-item').first();
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(item).toContainText(/Mentioned you in Mention Host Doc/i);
    await expect(page.getByTestId('sidebar-notification-badge')).toBeVisible({
      timeout: 10_000,
    });
  });

  test('mark read on A clears badge on B after sync', async ({
    page,
    browser,
  }) => {
    test.slow();

    const secret = await getDevDriveSecret(page);
    const personalDrive = await resolvePersonalDrive(page);
    const folder = await getOrCreateNotificationsFolder(page, personalDrive!);

    const aboutSubject = await page.evaluate(async drive => {
      const store = window.store;
      const doc = await store.newResource({
        parent: drive,
        isA: 'https://atomicdata.dev/classes/Folder',
        propVals: {
          'https://atomicdata.dev/properties/name': 'SyncReadTarget',
        },
      });
      await doc.save();

      return doc.subject;
    }, personalDrive);

    await seedUnreadItem(page, {
      folder,
      about: aboutSubject,
      summary: 'Mentioned you in SyncReadTarget',
      dedupeKey: `mention|${aboutSubject}|e2e-sync-read|me`,
    });

    await page.goto(`${FRONTEND_URL}/app/notifications`);
    await expect(page.getByTestId('notification-item').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('sidebar-notification-badge')).toBeVisible({
      timeout: 10_000,
    });

    const page2 = await openNewSubjectWindow(
      browser,
      `${FRONTEND_URL}/app/notifications`,
      secret,
    );

    await expect(page2.getByTestId('notification-item').first()).toBeVisible({
      timeout: 25_000,
    });
    await expect(page2.getByTestId('sidebar-notification-badge')).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId('mark-all-read').click();
    await expect(page.getByTestId('sidebar-notification-badge')).toHaveCount(
      0,
      { timeout: 15_000 },
    );

    await expect(page2.getByTestId('sidebar-notification-badge')).toHaveCount(
      0,
      { timeout: 30_000 },
    );

    await page2.context().close();
  });
});

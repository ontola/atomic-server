/**
 * Notifications UI + personal-drive inbox.
 *
 * Specs:
 *   1. Sidebar entry below User Settings + empty state.
 *   2. A NotificationItem on the personal drive appears in the inbox + badge.
 *   3. Opening an item marks it read (synced `notificationRead`).
 *   4. Table Watch toggle flips to Watching.
 *   5. Watch → simulated other-agent row → inbox item (engine path).
 *   6. Mention ResourceUpdated (other actor) → inbox item (engine path).
 *   7. Mark read on device A clears badge on device B (same agent, two contexts).
 *   8. Invite: A mentions B → B reconciles backlog → unread (two agents).
 *   9. Send message button is on the notifications page.
 *  10. DirectMessage from another actor materializes an inbox item.
 *  11. AccessRequest from another actor shows Grant in the inbox.
 */

import { test, expect } from '@playwright/test';
import {
  acceptInvite,
  appUrlOnFrontend,
  before,
  contextMenuClick,
  currentDriveTitle,
  FRONTEND_URL,
  getDevDriveSecret,
  newResource,
  signIn,
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
): Promise<string> {
  return page.evaluate(
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

      return item.subject;
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
  // Two-drive `/app/dev-drive` + invitee context; keep before() inside budget
  // when Vite is mid-HMR after a lib rebuild.
  test.describe.configure({ timeout: 180_000 });
  test.beforeEach(before);

  test('dev-drive workspace is not the personal inbox drive', async ({
    page,
  }) => {
    const { current, personal } = await page.evaluate(async personalDriveProp => {
      const store = window.store;
      const agent = store.getAgent();

      if (!agent?.subject) throw new Error('no agent');

      const agentRes = await store.fetchResourceFromServer(agent.subject, {
        noWebSocket: true,
      });

      return {
        current: store.getDrive(),
        personal: agentRes.get(personalDriveProp),
      };
    }, PERSONAL_DRIVE);

    expect(personal).toBeTruthy();
    expect(current).toBeTruthy();
    expect(current).not.toBe(personal);
    await expect(currentDriveTitle(page)).toHaveText('Dev drive');

    const folderOnWorkspace = await page.evaluate(
      async ({ drive, localIdProp }) => {
        const store = window.store;
        const hits = await store
          .search('Notifications', { limit: 5, parents: [drive] })
          .catch(() => [] as string[]);

        for (const subject of hits) {
          const res = store.getResourceLoading(subject);

          if (res.get(localIdProp) === 'notifications') {
            return subject;
          }
        }

        return null;
      },
      { drive: current, localIdProp: LOCAL_ID },
    );

    expect(folderOnWorkspace).toBeNull();
  });

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

    const created = await page.evaluate(
      async ({
        table,
        createdByProp,
        parentProp,
        nameProp,
        docClass,
        notificationItem,
      }) => {
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

        for (const res of store.resources.values()) {
          if (
            res.getClasses?.().includes(notificationItem) &&
            res.get?.(nameProp)?.toString().includes('Watch Fire Table')
          ) {
            return { ok: true };
          }
        }

        return { ok: false };
      },
      {
        table: tableSubject,
        createdByProp: CREATED_BY,
        parentProp: PARENT,
        nameProp: NAME,
        docClass: DOCUMENT,
        notificationItem: NOTIFICATION_ITEM,
      },
    );

    expect(
      created,
      `watch materialization failed: ${JSON.stringify(created)}`,
    ).toMatchObject({ ok: true });

    // In-app nav keeps the same Store (full reload can race OPFS index).
    await page.getByRole('link', { name: 'Notifications' }).click();
    await expect(page).toHaveURL(/\/app\/notifications/);
    const item = page.getByTestId('notification-item').first();
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(item).toContainText(/Update in Watch Fire Table|updates in/i);
  });

  test('mention ResourceUpdated materializes inbox item', async ({ page }) => {
    test.slow();

    await page.waitForFunction(
      () =>
        !!(window as Window & { __notificationEngine?: unknown })
          .__notificationEngine,
      null,
      { timeout: 20_000 },
    );

    const personalDrive = await resolvePersonalDrive(page);
    const myAgent = await page.evaluate(() => window.store.getAgent()?.subject);
    expect(myAgent).toBeTruthy();

    const created = await page.evaluate(
      async ({
        drive,
        me,
        createdByProp,
        mentionsProp,
        nameProp,
        docClass,
        notificationItem,
        isAProp,
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
          },
        });
        // validate:false — ontology fetch can lag on fresh drives.
        await doc.set(mentionsProp, [me], false);
        await doc.set(createdByProp, 'did:ad:agent:mentionActorE2E', false);

        const debug = {
          mentions: doc.get(mentionsProp),
          createdBy: doc.get(createdByProp),
          me,
        };

        store.notifyResourceUpdated(doc);

        // Poll local store for a NotificationItem (engine upsert is async).
        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 250));

          for (const res of store.resources.values()) {
            if (
              res.getClasses?.().includes(notificationItem) &&
              res.get?.(nameProp)?.toString().includes('Mention Host Doc')
            ) {
              return { ok: true, debug, count: 1 };
            }
          }
        }

        return { ok: false, debug, count: 0 };
      },
      {
        drive: personalDrive,
        me: myAgent,
        createdByProp: CREATED_BY,
        mentionsProp: MENTIONS,
        nameProp: NAME,
        docClass: DOCUMENT,
        notificationItem: NOTIFICATION_ITEM,
      },
    );

    expect(
      created,
      `mention materialization failed: ${JSON.stringify(created)}`,
    ).toMatchObject({ ok: true });

    // In-app nav keeps the same Store (full reload can race OPFS index).
    await page.getByRole('link', { name: 'Notifications' }).click();
    await expect(page).toHaveURL(/\/app\/notifications/);
    const item = page.getByTestId('notification-item').first();
    await expect(
      item,
      `created=${JSON.stringify(created)}`,
    ).toBeVisible({ timeout: 20_000 });
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

    const seededSubject = await seedUnreadItem(page, {
      folder,
      about: aboutSubject,
      summary: 'Mentioned you in SyncReadTarget',
      dedupeKey: `mention|${aboutSubject}|e2e-sync-read|me`,
    });

    await page.waitForFunction(
      () => window.store.getSyncStatus().pendingDirtyCount === 0,
      undefined,
      { timeout: 20_000 },
    );

    await page.goto(`${FRONTEND_URL}/app/notifications`);
    await expect(page.getByTestId('notification-item').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByTestId('sidebar-notification-badge')).toBeVisible({
      timeout: 10_000,
    });

    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    await page2.goto(FRONTEND_URL);
    await signIn(page2, secret);
    await expect(page2.getByRole('link', { name: /Connected Sync/ })).toBeVisible(
      { timeout: 30_000 },
    );

    await page2.goto(`${FRONTEND_URL}/app/notifications`);
    await page2.waitForFunction(
      async subject => {
        try {
          const res = await window.store.fetchResourceFromServer(subject, {
            noWebSocket: true,
          });

          if (res.error) {
            return false;
          }

          window.store.notifyResourceUpdated(res);

          return true;
        } catch {
          return false;
        }
      },
      seededSubject,
      { timeout: 30_000 },
    );
    await expect(page2.getByTestId('notification-item').first()).toBeVisible({
      timeout: 20_000,
    });
    await expect(page2.getByTestId('sidebar-notification-badge')).toBeVisible({
      timeout: 15_000,
    });

    await page.getByTestId('mark-all-read').click();
    await expect(page.getByTestId('sidebar-notification-badge')).toHaveCount(
      0,
      { timeout: 15_000 },
    );

    await page2.evaluate(async subject => {
      const res = await window.store.fetchResourceFromServer(subject, {
        noWebSocket: true,
      });

      if (!res.error) {
        window.store.notifyResourceUpdated(res);
      }
    }, seededSubject);

    await expect(page2.getByTestId('sidebar-notification-badge')).toHaveCount(
      0,
      { timeout: 30_000 },
    );

    await ctx2.close();
  });

  test('A mentions B via invite; B reconciles unread', async ({
    page,
    browser,
    context,
  }) => {
    test.slow();

    await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(FRONTEND_URL).origin,
    });

    const driveSubject = await page.evaluate(() => window.store.getDrive());
    expect(driveSubject).toBeTruthy();

    // Share the drive via context menu (same path as e2e authorization invite).
    await currentDriveTitle(page).click();
    await contextMenuClick('share', page);
    await expect(
      page.getByRole('button', { name: 'Create Invite' }),
    ).toBeVisible({ timeout: 10_000 });
    await page.getByRole('button', { name: 'Create Invite' }).click();
    await page.getByLabel('Allow edits').check();
    await page.getByRole('button', { name: 'Create' }).click();
    await expect(page.locator('text=Invite created and copied ')).toBeVisible();

    const inviteUrl = await page.evaluate(() =>
      document
        .querySelector('[data-code-content]')
        ?.getAttribute('data-code-content'),
    );
    expect(inviteUrl).toBeTruthy();

    await page.waitForFunction(
      () => window.store.getSyncStatus().pendingDirtyCount === 0,
      undefined,
      { timeout: 30_000 },
    );

    const context2 = await browser.newContext();
    await context2.grantPermissions(['clipboard-read', 'clipboard-write'], {
      origin: new URL(FRONTEND_URL).origin,
    });
    const page2 = await context2.newPage();
    await page2.goto(appUrlOnFrontend(inviteUrl as string));
    await acceptInvite(page2);
    await page2.waitForURL(/\/app\//, { timeout: 15_000 });

    const agentB = await page2.evaluate(() => window.store.getAgent()?.subject);
    expect(agentB).toMatch(/^did:ad:agent:/);

    await page2.waitForFunction(
      () =>
        !!(window as Window & { __notificationEngine?: unknown })
          .__notificationEngine,
      null,
      { timeout: 20_000 },
    );

    // Pause B's engine so A's mention is discovered via reverse query on
    // restart (reconcileMentionBacklog), not live ResourceUpdated.
    await page2.evaluate(() => {
      (
        window as Window & {
          __notificationEngine?: { stop: () => void };
        }
      ).__notificationEngine?.stop();
    });

    // Mention B on a drive child — B has drive write via the invite above.
    const docSubject = await page.evaluate(
      async ({ drive, agentB: mentioned, mentionsProp, nameProp, docClass }) => {
        const store = window.store;
        const doc = await store.newResource({
          parent: drive,
          isA: docClass,
          propVals: {
            [nameProp]: 'Cross Agent Ping',
          },
        });
        await doc.set(mentionsProp, [mentioned], false);
        await doc.save();

        return doc.subject;
      },
      {
        drive: driveSubject,
        agentB,
        mentionsProp: MENTIONS,
        nameProp: NAME,
        docClass: DOCUMENT,
      },
    );

    await page.waitForFunction(
      () => window.store.getSyncStatus().pendingDirtyCount === 0,
      undefined,
      { timeout: 15_000 },
    );

    // B loads the mentioned doc and restarts the engine → backlog reconcile.
    await page2.evaluate(async doc => {
      const store = window.store;
      const engine = (
        window as Window & {
          __notificationEngine?: {
            start: () => Promise<void>;
            reconcileMentionBacklog: () => Promise<void>;
          };
        }
      ).__notificationEngine;

      if (!engine) {
        throw new Error('__notificationEngine missing after stop');
      }

      await store.fetchResourceFromServer(doc);
      await engine.start();
      // start() already reconciles; call again after fetch to be sure.
      await engine.reconcileMentionBacklog();
    }, docSubject);

    await page2.getByRole('link', { name: 'Notifications' }).click();
    await expect(page2).toHaveURL(/\/app\/notifications/);
    const item = page2.getByTestId('notification-item').first();
    await expect(item).toBeVisible({ timeout: 30_000 });
    await expect(item).toContainText(/Mentioned you in Cross Agent Ping/i);
    await expect(page2.getByTestId('sidebar-notification-badge')).toBeVisible({
      timeout: 15_000,
    });

    await context2.close();
  });

  test('send message button is on the notifications page', async ({ page }) => {
    await page.getByRole('link', { name: 'Notifications' }).click();
    await expect(page).toHaveURL(/\/app\/notifications/);
    await expect(page.getByTestId('send-message')).toBeVisible({
      timeout: 15_000,
    });
    await page.getByTestId('send-message').click();
    await expect(page.getByRole('heading', { name: 'Send message' })).toBeVisible();
  });

  test('direct message ResourceUpdated materializes inbox item', async ({
    page,
  }) => {
    test.slow();

    await page.waitForFunction(
      () =>
        !!(window as Window & { __notificationEngine?: unknown })
          .__notificationEngine,
      null,
      { timeout: 20_000 },
    );

    const personalDrive = await resolvePersonalDrive(page);
    const myAgent = await page.evaluate(() => window.store.getAgent()?.subject);
    expect(myAgent).toBeTruthy();

    const created = await page.evaluate(
      async ({
        drive,
        me,
        createdByProp,
        mentionsProp,
        nameProp,
        descProp,
        isAProp,
        messageClass,
        notificationItem,
      }) => {
        const store = window.store;
        const engine = (
          window as Window & { __notificationEngine?: unknown }
        ).__notificationEngine;

        if (!engine) {
          throw new Error('__notificationEngine not ready');
        }

        const msg = await store.newResource({
          parent: drive,
          isA: messageClass,
          propVals: {
            [nameProp]: 'Hello from e2e',
            [descProp]: 'Ping from the other seat',
          },
        });
        await msg.set(mentionsProp, [me], false);
        await msg.set(createdByProp, 'did:ad:agent:messageActorE2E', false);
        store.notifyResourceUpdated(msg);

        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 250));

          for (const res of store.resources.values()) {
            if (
              res.getClasses?.().includes(notificationItem) &&
              String(res.get?.(nameProp) ?? '').includes('Sent you a message')
            ) {
              return { ok: true };
            }
          }
        }

        return { ok: false };
      },
      {
        drive: personalDrive,
        me: myAgent,
        createdByProp: CREATED_BY,
        mentionsProp: MENTIONS,
        nameProp: NAME,
        descProp: 'https://atomicdata.dev/properties/description',
        isAProp: 'https://atomicdata.dev/properties/isA',
        messageClass: 'https://atomicdata.dev/classes/DirectMessage',
        notificationItem: NOTIFICATION_ITEM,
      },
    );

    expect(created).toMatchObject({ ok: true });

    await page.getByRole('link', { name: 'Notifications' }).click();
    await expect(page).toHaveURL(/\/app\/notifications/);
    const item = page.getByTestId('notification-item').first();
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(item).toContainText(/Sent you a message/i);
  });

  test('access request ResourceUpdated shows Grant in inbox', async ({
    page,
  }) => {
    test.slow();

    await page.waitForFunction(
      () =>
        !!(window as Window & { __notificationEngine?: unknown })
          .__notificationEngine,
      null,
      { timeout: 20_000 },
    );

    const personalDrive = await resolvePersonalDrive(page);
    const myAgent = await page.evaluate(() => window.store.getAgent()?.subject);
    expect(myAgent).toBeTruthy();

    const created = await page.evaluate(
      async ({
        drive,
        me,
        createdByProp,
        mentionsProp,
        nameProp,
        aboutProp,
        rightProp,
        requestClass,
        notificationItem,
      }) => {
        const store = window.store;
        const engine = (
          window as Window & { __notificationEngine?: unknown }
        ).__notificationEngine;

        if (!engine) {
          throw new Error('__notificationEngine not ready');
        }

        const target = await store.newResource({
          parent: drive,
          isA: 'https://atomicdata.dev/classes/DocumentV2',
          propVals: {
            [nameProp]: 'Private Notes',
          },
        });
        await target.save();

        const req = await store.newResource({
          parent: drive,
          isA: requestClass,
          propVals: {
            [nameProp]: 'Access request: Private Notes',
            [aboutProp]: target.subject,
            [rightProp]: 'write',
          },
        });
        await req.set(mentionsProp, [me], false);
        await req.set(createdByProp, 'did:ad:agent:accessActorE2E', false);
        store.notifyResourceUpdated(req);

        for (let i = 0; i < 40; i++) {
          await new Promise(r => setTimeout(r, 250));

          for (const res of store.resources.values()) {
            if (
              res.getClasses?.().includes(notificationItem) &&
              String(res.get?.(nameProp) ?? '').includes('Requested write access')
            ) {
              return { ok: true };
            }
          }
        }

        return { ok: false };
      },
      {
        drive: personalDrive,
        me: myAgent,
        createdByProp: CREATED_BY,
        mentionsProp: MENTIONS,
        nameProp: NAME,
        aboutProp: ABOUT,
        rightProp: 'https://atomicdata.dev/properties/requestedRight',
        requestClass: 'https://atomicdata.dev/classes/AccessRequest',
        notificationItem: NOTIFICATION_ITEM,
      },
    );

    expect(created).toMatchObject({ ok: true });

    await page.getByRole('link', { name: 'Notifications' }).click();
    await expect(page).toHaveURL(/\/app\/notifications/);
    const item = page.getByTestId('notification-item').first();
    await expect(item).toBeVisible({ timeout: 20_000 });
    await expect(item).toContainText(/Requested write access to Private Notes/i);
    await expect(page.getByTestId('grant-access')).toBeVisible();
  });
});

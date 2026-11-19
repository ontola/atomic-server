import type { Page } from '@playwright/test';
import { SIGNALING, signalingRoom } from './resource-peer-test-utils';
import { test, expect } from './fixtures';
import {
  before,
  FRONTEND_URL,
  getDevDriveSecret,
  openSubject,
  signIn,
  waitForClientDbFlush,
  waitForClientDbReady,
  waitForServerConnected,
  waitForSynced,
} from './test-utils';

async function peerStatus(page: Page, subject: string) {
  return page.evaluate(resourceSubject => {
    const store = window.store;

    return store.getResourceCopies(store.getResourceLoading(resourceSubject))
      .peers;
  }, subject);
}

async function capturePeerState(page: Page, subject: string, label: string) {
  const snapshot = await page.evaluate(resourceSubject => {
    const store = window.store;
    const resource = store.getResourceLoading(resourceSubject);
    const doc = resource.getLoroDoc();

    return {
      status: store.getResourceCopies(resource).peers,
      version: [...(doc?.oplogVersion().toJSON() ?? [])],
      pendingTransactions: doc?.getPendingTxnLength(),
    };
  }, subject);
  await test.info().attach(label, {
    body: JSON.stringify(snapshot, null, 2),
    contentType: 'application/json',
  });
}

async function stablePanel(page: Page) {
  const dialog = page.getByRole('dialog', { name: 'Copies & sync' });
  await expect(dialog).toHaveCSS('opacity', '1');

  return dialog;
}

test.beforeEach(before);

test('only distinct live browser copies confirm the exact local-only resource version', async ({
  page,
  context,
  browser,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 1300 });
  const relay = signalingRoom();
  await relay.install(context);
  const secret = await getDevDriveSecret(page);
  const drive = await page.evaluate(() => window.store.getDrive()!);
  const listUrl = page.url();
  const remoteContext = await browser.newContext();

  try {
    await relay.install(remoteContext);
    const remote = await remoteContext.newPage();
    await remote.goto(`${FRONTEND_URL}/app/welcome`);
    await signIn(remote, secret);
    await openSubject(remote, drive);

    // The drive's ACL is bootstrapped through the server on both devices. The
    // target resource is created only AFTER both copies become browser-only.
    for (const current of [page, remote]) {
      await waitForClientDbReady(current);
      await waitForServerConnected(current);
      await waitForSynced(current);
      await current.waitForFunction(() => {
        const status = window.store.getSyncStatus();

        return (
          !status.syncInProgress &&
          !status.pendingDirtyCount &&
          !status.blockedCount
        );
      });
      await expect
        .poll(
          () =>
            current.evaluate(async driveSubject => {
              try {
                await window.store.makeDriveLocal(driveSubject);

                return true;
              } catch (error) {
                // Background hydration can start after the idle check. The public
                // operation refuses atomically; retry that explicit readiness guard.
                if (
                  error instanceof Error &&
                  error.message ===
                    'Wait for changes to finish syncing before disconnecting.'
                )
                  return false;
                throw error;
              }
            }, drive),
          { timeout: 20_000 },
        )
        .toBe(true);
      await waitForClientDbFlush(current, { required: true });
    }

    // Enable discovery after both local copies are ready. New tabs and reloads
    // inherit the ordinary browser setting from localStorage.
    for (const current of [page, remote]) {
      await current.evaluate(
        url => localStorage.setItem('peer-signaling-url', url),
        SIGNALING,
      );
    }

    await expect.poll(relay.memberCount, { timeout: 20_000 }).toBe(2);
    const subject = await page.evaluate(async driveSubject => {
      const resource = await window.store.newResource({
        parent: driveSubject,
        isA: 'https://atomicdata.dev/classes/Folder',
        propVals: {
          'https://atomicdata.dev/properties/name': 'Peer-only notes',
        },
      });
      await resource.save();

      return resource.subject;
    }, drive);
    await waitForClientDbFlush(page, { required: true });
    await expect
      .poll(() => peerStatus(page, subject), { timeout: 20_000 })
      .toMatchObject({ state: 'confirmed', confirmedCount: 1 });
    await expect
      .poll(() =>
        remote.evaluate(
          resourceSubject =>
            window.store.resources
              .get(resourceSubject)
              ?.get('https://atomicdata.dev/properties/name'),
          subject,
        ),
      )
      .toBe('Peer-only notes');
    const copies = await page.evaluate(
      async args => {
        const store = window.store;
        const inventory = await store
          .getDefaultWebSocket()!
          .driveInventory(args.drive, '');

        return {
          status: store.getResourceCopies(
            store.getResourceLoading(args.subject),
          ),
          serverSubjects: inventory.map(item => item.subject),
        };
      },
      { drive, subject },
    );
    expect(copies.status.local.state).toBe('confirmed');
    expect(copies.status.server.state).toBe('not-configured');
    expect(copies.serverSubjects).not.toContain(subject);
    const resources = page.locator('section').filter({
      has: page.getByRole('heading', { name: 'Resources', exact: true }),
    });
    const indicator = resources.getByRole('button', {
      name: /^Copies and sync for Peer-only notes/,
    });
    await expect(indicator).toHaveAttribute(
      'data-peer-sync-state',
      'confirmed',
    );
    await indicator.click();
    const panel = page.getByTestId('resource-sync-panel');
    await expect(
      panel
        .getByRole('list', { name: 'Peer resource copies' })
        .getByText('Latest changes received', { exact: true }),
    ).toBeVisible();
    await expect(panel.getByText('Confirmed peer copies: 1')).toBeVisible();
    await expect(panel.getByText('No server configured')).toBeVisible();
    await stablePanel(page);
    await page.screenshot({
      path: test.info().outputPath('resource-peers-desktop.png'),
      fullPage: true,
      animations: 'disabled',
    });

    // Pause the receiver, not the wire or receipt implementation. This forces a
    // real gap between saving a newer local version and remote application.
    const debuggerSession = await remoteContext.newCDPSession(remote);
    await debuggerSession.send('Debugger.enable');
    await debuggerSession.send('Debugger.pause');

    try {
      await page.evaluate(async resourceSubject => {
        const resource = window.store.getResourceLoading(resourceSubject);
        await resource.set(
          'https://atomicdata.dev/properties/name',
          'Peer-only notes newer',
          false,
        );
        await resource.save();
      }, subject);
      await waitForClientDbFlush(page, { required: true });
      await expect
        .poll(() => peerStatus(page, subject))
        .toMatchObject({ state: 'pending', confirmedCount: 0 });
      await expect(indicator).toHaveAttribute(
        'data-peer-sync-state',
        'pending',
      );
      await expect(panel.getByRole('status')).toHaveText(
        'Changes waiting for peers',
      );
      await expect(
        panel.getByText('Latest changes received', { exact: true }),
      ).toHaveCount(0);
      await stablePanel(page);
      await page.screenshot({
        path: test.info().outputPath('resource-peers-pending.png'),
        fullPage: true,
        animations: 'disabled',
      });
    } finally {
      await debuggerSession.send('Debugger.resume');
      await debuggerSession.detach();
    }

    await expect
      .poll(() => peerStatus(page, subject), { timeout: 20_000 })
      .toMatchObject({ state: 'confirmed', confirmedCount: 1 });
    await expect
      .poll(() =>
        remote.evaluate(
          resourceSubject =>
            window.store.resources
              .get(resourceSubject)
              ?.get('https://atomicdata.dev/properties/name'),
          subject,
        ),
      )
      .toBe('Peer-only notes newer');
    await expect(indicator).toHaveAttribute(
      'data-peer-sync-state',
      'confirmed',
    );
    await page.keyboard.press('Escape');
    await expect(panel).not.toBeVisible();
    await page
      .getByRole('button', { name: 'Show / hide sidebar', exact: false })
      .click();
    await page.setViewportSize({ width: 390, height: 844 });
    await indicator.click();
    await expect(indicator).toHaveAttribute(
      'data-peer-sync-state',
      'confirmed',
    );
    await expect(panel.getByText('Confirmed peer copies: 1')).toBeVisible();
    await capturePeerState(page, subject, 'peer-mobile-open');
    const dialog = await stablePanel(page);
    const bounds = await dialog.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
    await page.screenshot({
      path: test.info().outputPath('resource-peers-mobile.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await panel
      .getByRole('link', { name: 'Manage sync and backup' })
      .scrollIntoViewIfNeeded();
    await expect(panel.getByText('Peer 1', { exact: true })).toBeInViewport();
    await expect(
      panel.getByRole('link', { name: 'Manage sync and backup' }),
    ).toBeInViewport();
    await expect(indicator).toHaveAttribute(
      'data-peer-sync-state',
      'confirmed',
    );
    await expect(panel.getByText('Confirmed peer copies: 1')).toBeVisible();
    await stablePanel(page);
    await page.screenshot({
      path: test.info().outputPath('resource-peers-mobile-detail.png'),
      fullPage: true,
      animations: 'disabled',
    });
    await page.keyboard.press('Escape');

    const sharedTab = await context.newPage();
    await sharedTab.goto(listUrl);
    await waitForClientDbReady(sharedTab);
    await expect.poll(relay.memberCount, { timeout: 20_000 }).toBe(3);
    await expect
      .poll(() => peerStatus(page, subject))
      .toMatchObject({ state: 'confirmed', confirmedCount: 1 });
    await remoteContext.close();
    await expect
      .poll(() => peerStatus(page, subject), { timeout: 20_000 })
      .toMatchObject({
        state: 'unknown',
        connectedCount: 0,
        confirmedCount: 0,
        peers: [],
      });
    await expect(indicator).toHaveAttribute('data-peer-sync-state', 'unknown');
    await page.reload();
    await waitForClientDbReady(page);
    await expect.poll(relay.memberCount, { timeout: 20_000 }).toBe(2);
    await expect
      .poll(() => peerStatus(page, subject))
      .toMatchObject({
        state: 'unknown',
        connectedCount: 0,
        confirmedCount: 0,
        peers: [],
      });
    await expect(indicator).toHaveAttribute('data-peer-sync-state', 'unknown');
    await indicator.click();
    await expect(
      panel.getByText('Resource copies not confirmed'),
    ).toBeVisible();
    await sharedTab.close();
  } finally {
    relay.dispose();
    await remoteContext.close();
  }
});

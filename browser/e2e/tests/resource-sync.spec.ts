import { test, expect } from './fixtures';
import {
  before,
  waitForClientDbFlush,
  waitForClientDbReady,
  waitForServerConnected,
  waitForSynced,
} from './test-utils';

test.beforeEach(before);

test('resource copies distinguish an acknowledged save from a later offline edit', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await waitForClientDbReady(page);
  const subject = await page.evaluate(async () => {
    const resource = await window.store.newResource({
      parent: window.store.getDrive(),
      isA: 'https://atomicdata.dev/classes/Folder',
      propVals: {
        'https://atomicdata.dev/properties/name': 'Project notes',
      },
    });
    await resource.save();

    return resource.subject;
  });
  await waitForSynced(page);

  const resources = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Resources', exact: true }),
  });
  const indicator = resources.getByRole('button', {
    name: /^Copies and sync for Project notes:/,
  });
  await expect(indicator).toBeVisible();
  const listUrl = page.url();
  await indicator.click();
  const panel = page.getByTestId('resource-sync-panel');
  await expect(panel).toBeVisible();

  try {
    await expect(
      panel.getByText('Latest changes saved', { exact: true }),
    ).toBeVisible();
    await expect(
      panel.getByText('Saved on this device', { exact: true }),
    ).toBeVisible();
  } catch (error) {
    const diagnostics = await page.evaluate(resourceSubject => {
      const store = window.store;
      const resource = store.getResourceLoading(resourceSubject);
      const doc = resource.getLoroDoc();

      return JSON.stringify(
        {
          subject: resource.subject,
          status: store.getResourceCopies(resource),
          save: store.getSaveState(resource),
          version: doc?.oplogVersion().toJSON(),
          pendingTxnLength: doc?.getPendingTxnLength(),
        },
        (_key, value) => (value instanceof Map ? [...value] : value),
        2,
      );
    }, subject);
    await test.info().attach('resource-sync-receipts', {
      body: diagnostics,
      contentType: 'application/json',
    });
    throw error;
  }

  expect(page.url()).toBe(listUrl);

  await page.screenshot({
    path: test.info().outputPath('resource-sync-desktop.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(indicator).toBeFocused();
  await indicator.press('Enter');
  await expect(panel).toBeVisible();
  expect(page.url()).toBe(listUrl);

  await page.evaluate(() => window.store.disconnect());
  await expect
    .poll(() =>
      page.evaluate(() => window.store.getSyncStatus().serverConnected),
    )
    .toBe(false);
  await page.evaluate(async resourceSubject => {
    const resource = window.store.getResourceLoading(resourceSubject);
    await resource.set(
      'https://atomicdata.dev/properties/name',
      'Project notes — offline edit',
      false,
    );
    await resource.save();
  }, subject);

  await expect(panel.getByRole('status')).toHaveText('Changes waiting to sync');
  await expect(
    panel.getByText('Latest changes saved', { exact: true }),
  ).toHaveCount(0);
  await expect(
    panel.getByText('Saved on this device', { exact: true }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  await expect(async () => {
    const bounds = await page
      .getByRole('dialog', { name: 'Copies & sync' })
      .boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(844);
  }).toPass({ timeout: 10_000 });
  await page.screenshot({
    path: test.info().outputPath('resource-sync-mobile.png'),
    fullPage: true,
    animations: 'disabled',
  });
  const manageSync = panel.getByRole('link', {
    name: 'Manage sync and backup',
  });
  await manageSync.scrollIntoViewIfNeeded();
  await expect(manageSync).toBeInViewport();
  await page.screenshot({
    path: test.info().outputPath('resource-sync-mobile-footer.png'),
    fullPage: true,
    animations: 'disabled',
  });
  await panel.getByRole('button', { name: 'Close copies and sync' }).click();
  await expect(panel).not.toBeVisible();
  expect(page.url()).toBe(listUrl);
});

test('resource confirmations survive offline reloads without confirming a newer offline edit', async ({
  page,
  context,
  browserDiagnostics,
}) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  browserDiagnostics.expect(
    'error',
    /^Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/,
    'Two offline reloads each probe the server resource from app setup and the copies panel.',
    4,
    /\/server$/,
    { optional: true },
  );
  browserDiagnostics.expect(
    'error',
    /^Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/,
    'Each offline reload requests the drive plugin list while the server is unavailable.',
    2,
    /\/plugin-list\?drive=/,
    { optional: true },
  );
  browserDiagnostics.expect(
    'error',
    /^Failed to load resource: net::ERR_INTERNET_DISCONNECTED$/,
    'The three locally served fonts may be requested again on each of two offline reloads.',
    6,
    /\/assets\/[^/?]+\.woff2$/,
    { optional: true },
  );
  // Cache the real app shell before creating the resource. The later reloads
  // must work with all network access disabled, including HTTP and WebSockets.
  await expect
    .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), {
      timeout: 30_000,
    })
    .toBe(true);
  await waitForClientDbReady(page);
  await waitForSynced(page);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForClientDbReady(page);
  await waitForServerConnected(page);

  const subject = await page.evaluate(async () => {
    const resource = await window.store.newResource({
      parent: window.store.getDrive(),
      isA: 'https://atomicdata.dev/classes/Folder',
      propVals: {
        'https://atomicdata.dev/properties/name': 'Reload proof',
      },
    });
    await resource.save();

    return resource.subject;
  });
  const resources = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'Resources', exact: true }),
  });
  const indicator = resources.getByRole('button', {
    name: /^Copies and sync for Reload proof/,
  });
  await indicator.click();
  const panel = page.getByTestId('resource-sync-panel');
  await expect(
    panel.getByText('Saved on this device', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText('Latest changes saved', { exact: true }),
  ).toBeVisible();
  // Ordinary sync readiness includes persisting the server receipt.
  await waitForSynced(page);
  const serverConfirmedAt = await page.evaluate(resourceSubject => {
    const resource = window.store.getResourceLoading(resourceSubject);

    return window.store.getResourceCopies(resource).server.confirmedAt;
  }, subject);
  expect(serverConfirmedAt).toEqual(expect.any(Number));

  await page.evaluate(() => window.store.disconnect());
  await expect
    .poll(() =>
      page.evaluate(() => window.store.getSyncStatus().serverConnected),
    )
    .toBe(false);
  await context.setOffline(true);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForClientDbReady(page);
  await indicator.click();
  await expect(panel.getByText('Currently offline')).toBeVisible();
  await expect(
    panel.getByText('Saved on this device', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText('Latest changes saved', { exact: true }),
  ).toBeVisible();
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  expect(
    await page.evaluate(resourceSubject => {
      const resource = window.store.getResourceLoading(resourceSubject);

      return window.store.getResourceCopies(resource).server.confirmedAt;
    }, subject),
  ).toBe(serverConfirmedAt);
  await page.screenshot({
    path: test.info().outputPath('resource-sync-offline-reload.png'),
    fullPage: true,
    animations: 'disabled',
  });

  await page.evaluate(async resourceSubject => {
    const resource = window.store.getResourceLoading(resourceSubject);
    await resource.set(
      'https://atomicdata.dev/properties/name',
      'Reload proof — offline edit',
      false,
    );
    await resource.save();
  }, subject);
  await expect(panel.getByRole('status')).toHaveText('Changes waiting to sync');
  await expect(
    panel.getByText('Saved on this device', { exact: true }),
  ).toBeVisible();
  await waitForClientDbFlush(page, { required: true });

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForClientDbReady(page);
  await indicator.click();
  await expect(panel.getByText('Reload proof — offline edit')).toBeVisible();
  await expect(panel.getByText('Currently offline')).toBeVisible();
  await expect(panel.getByRole('status')).toHaveText('Changes waiting to sync');
  await expect(
    panel.getByText('Saved on this device', { exact: true }),
  ).toBeVisible();
  await expect(
    panel.getByText('Latest changes saved', { exact: true }),
  ).toHaveCount(0);
  expect(await page.evaluate(() => navigator.onLine)).toBe(false);
  expect(
    await page.evaluate(resourceSubject => {
      const resource = window.store.getResourceLoading(resourceSubject);

      return window.store.getResourceCopies(resource);
    }, subject),
  ).toMatchObject({
    local: { state: 'confirmed' },
    server: { state: 'pending', confirmedAt: serverConfirmedAt },
  });
  await page.screenshot({
    path: test.info().outputPath('resource-sync-offline-edit-reload.png'),
    fullPage: true,
    animations: 'disabled',
  });
});

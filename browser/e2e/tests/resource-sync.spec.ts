import { test, expect } from './fixtures';
import { before, waitForClientDbReady, waitForSynced } from './test-utils';

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
  } catch (error) {
    const diagnostics = await page.evaluate(resourceSubject => {
      const store = window.store;
      const resource = store.getResourceLoading(resourceSubject);
      const doc = resource.getLoroDoc();

      return JSON.stringify(
        {
          subject: resource.subject,
          status: store.getResourceSyncStatus(resource),
          save: store.getSaveState(resource),
          version: doc?.oplogVersion().toJSON(),
          pendingTxnLength: doc?.getPendingTxnLength(),
          evidence: Reflect.get(store, 'resourceSyncStatus').evidence.get(
            resource.subject,
          ),
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

  await expect(
    panel.getByText('Saved on this device', { exact: true }),
  ).toBeVisible();
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

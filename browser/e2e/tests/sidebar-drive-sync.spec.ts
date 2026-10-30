import { test, expect } from './fixtures';
import { before } from './test-utils';

test.describe('sidebar drive sync', () => {
  test.beforeEach(before);

  test('a local-only drive stays unsynced while the server is connected', async ({
    page,
  }, testInfo) => {
    await page.waitForFunction(
      () => window.store?.getSyncStatus().serverConnected === true,
      undefined,
      { timeout: 30_000 },
    );

    const serverDrive = await page.evaluate(() => window.store.getDrive()!);
    const drive = await page.evaluate(async () => {
      const store = window.store;
      const local = await store.createDrive('Local-only sync regression', {
        personal: false,
        localOnly: true,
      });
      store.setDrive(local.subject);
      await store.getClientDb()!.flush();

      return local.subject;
    });

    await expect
      .poll(
        () =>
          page.evaluate(
            subject => ({
              selected: window.store.getDrive() === subject,
              localOnly: window.store.isLocalOnlyDrive(subject),
              connected: window.store.getSyncStatus().serverConnected,
            }),
            drive,
          ),
        { timeout: 30_000 },
      )
      .toEqual({ selected: true, localOnly: true, connected: true });

    const syncButton = page.getByTestId('sidebar-sync-button');
    await expect(syncButton).toHaveAttribute(
      'title',
      'Sync: Not syncing with a server',
    );
    await expect(syncButton.locator('svg title')).toHaveText(
      'Not syncing with a server',
    );
    await expect(syncButton.locator('svg')).toHaveCSS(
      'color',
      'rgb(207, 91, 91)',
    );
    await syncButton.click();
    await expect(
      page.getByRole('heading', { name: 'Sync', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('Only on this device', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('This drive hasn’t been synced.', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText('Always-on · in use', { exact: false }),
    ).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath('local-only-sync.png'),
      fullPage: true,
    });

    await page.evaluate(async subject => {
      const store = window.store;
      const local = await store.getResource(subject);
      await local.set(
        'https://atomicdata.dev/properties/description',
        'A locally persisted change',
      );
      await local.save();
      await store.getClientDb()!.flush();
    }, drive);
    await page.getByText('Developer', { exact: true }).click();
    const localActivity = page
      .locator('details')
      .filter({ has: page.getByText('Recent activity', { exact: true }) })
      .locator('span')
      .filter({ hasText: /^Saved locally$/ })
      .first();
    await expect(localActivity).toBeVisible();
    await expect(localActivity.locator('..')).not.toContainText('outgoing');
    await expect(localActivity.locator('..')).not.toContainText('↑');

    await page.reload();
    await expect(syncButton).toHaveAttribute(
      'title',
      'Sync: Not syncing with a server',
      { timeout: 30_000 },
    );
    await expect
      .poll(
        () =>
          page.evaluate(async subject => {
            const store = window.store;
            const local = await store.getResource(subject);

            return {
              selected: store.getDrive() === subject,
              localOnly: store.isLocalOnlyDrive(subject),
              connected: store.getSyncStatus().serverConnected,
              description: local.get(
                'https://atomicdata.dev/properties/description',
              ),
            };
          }, drive),
        { timeout: 30_000 },
      )
      .toEqual({
        selected: true,
        localOnly: true,
        connected: true,
        description: 'A locally persisted change',
      });
    await expect(
      page.getByText('Only on this device', { exact: true }),
    ).toBeVisible();

    await page.evaluate(subject => window.store.setDrive(subject), serverDrive);
    await expect(syncButton).toHaveAttribute(
      'title',
      'Sync: Synced with server',
      { timeout: 30_000 },
    );
    await expect(syncButton.locator('svg title')).toHaveText(
      'Synced with server',
    );
  });
});

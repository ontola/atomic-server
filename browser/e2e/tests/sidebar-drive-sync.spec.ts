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
    await localActivity.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: testInfo.outputPath('saved-locally-activity.png'),
      fullPage: true,
    });

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
  test('missing attachment stays red until the server holds its bytes', async ({
    page,
  }, testInfo) => {
    const syncButton = page.getByTestId('sidebar-sync-button');
    await expect(syncButton).toHaveAttribute(
      'title',
      'Sync: Synced with server',
      { timeout: 60_000 },
    );

    // Let the metadata commit succeed while pretending the blob PUT succeeded.
    // The proof endpoint must check the server's actual bytes, not this response.
    const blobRoute = '**/blob/**';
    await page.route(blobRoute, route =>
      route.request().method() === 'PUT'
        ? route.fulfill({ status: 204 })
        : route.continue(),
    );
    const missingProof = page.waitForResponse(
      async response => {
        if (
          !response.url().includes('/drive-sync-confirmation?') ||
          !response.ok()
        )
          return false;

        try {
          return (await response.json()).confirmed === false;
        } catch {
          return false;
        }
      },
      { timeout: 60_000 },
    );
    const attachment = await page.evaluate(async () => {
      const store = window.store;
      const [subject] = await store.uploadFiles(
        [
          new File(
            ['Attachment bytes for sync verification'],
            'confirmation.txt',
            { type: 'text/plain' },
          ),
        ],
        store.getDrive()!,
      );
      const file = await store.getResource(subject);

      return {
        subject,
        download: String(
          file.get('https://atomicdata.dev/properties/downloadURL'),
        ),
      };
    });
    const response = await missingProof;
    expect(await response.json()).toMatchObject({
      version: 1,
      hashVersion: 2,
      confirmed: false,
    });
    expect((await page.request.get(attachment.download)).status()).toBe(404);
    await expect(syncButton).toHaveAttribute(
      'title',
      'Sync: Sync not confirmed',
      { timeout: 30_000 },
    );
    await expect(syncButton.locator('svg')).toHaveCSS(
      'color',
      'rgb(207, 91, 91)',
    );
    await page.screenshot({
      path: testInfo.outputPath('missing-attachment-sync.png'),
      fullPage: true,
    });

    await page.unroute(blobRoute);
    await page.evaluate(async subject => {
      const file = await window.store.getResource(subject);
      await window.store.maybePushBlobForResource(file);
    }, attachment.subject);
    await expect
      .poll(
        async () => (await page.request.get(attachment.download)).status(),
        { timeout: 30_000 },
      )
      .toBe(200);
    await expect(syncButton).toHaveAttribute(
      'title',
      'Sync: Synced with server',
      { timeout: 60_000 },
    );
  });
});

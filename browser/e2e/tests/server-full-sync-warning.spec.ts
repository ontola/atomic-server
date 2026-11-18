import { standaloneTest as test, expect } from './deployment-fixtures';
import { before, FRONTEND_URL, waitForSynced } from './test-utils';

test.beforeEach(before);

test('a full sync clears the drive warning on a standalone server', async ({
  page,
}) => {
  const folderName = 'Folder saved on the server';
  const folderSubject = await page.evaluate(async name => {
    const store = window.store;
    const folder = await store.newResource({
      deferGenesis: true,
      parent: store.getDrive()!,
      isA: 'https://atomicdata.dev/classes/Folder',
    });
    await folder.set('https://atomicdata.dev/properties/name', name, false);
    await folder.save();

    return folder.subject;
  }, folderName);
  await waitForSynced(page);

  const savedName = await page.evaluate(async subject => {
    const folder = await window.store.fetchResourceFromServer(subject);

    return folder.get('https://atomicdata.dev/properties/name');
  }, folderSubject);
  expect(savedName).toBe(folderName);

  await page.goto(`${FRONTEND_URL}/app/sync`);
  const lastFullSync = page.getByTestId('server-last-full-sync');
  const warning = page.getByTestId('vault-no-backup-status');
  await expect(lastFullSync).toBeVisible({ timeout: 30_000 });
  await expect(warning).toBeHidden();

  await page.reload();
  await expect(lastFullSync).toBeVisible({ timeout: 30_000 });
  await expect(warning).toBeHidden();

  if (process.env.ATOMIC_SERVER_FULL_SYNC_SCREENSHOT) {
    await lastFullSync.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: process.env.ATOMIC_SERVER_FULL_SYNC_SCREENSHOT,
    });
  }
});

import { standaloneTest as test, expect } from './deployment-fixtures';
import { before, FRONTEND_URL } from './test-utils';

test.beforeEach(before);

test('Sync shows confirmation only for the peer that verified the drive', async ({
  page,
}) => {
  const drive = await page.evaluate(() => window.store.getDrive());
  const verifiedPeer = '1'.repeat(64);
  const activePeer = '2'.repeat(64);
  const timestamp = Date.now() - 60_000;
  const property = 'https://atomicdata.dev/properties/peer/';

  await page.route('**/server', async route => {
    const response = await route.fetch();
    const body = await response.json();
    body['https://atomicdata.dev/properties/server/peers'] = [
      { id: verifiedPeer, name: 'Confirmed device' },
      { id: activePeer, name: 'Active device' },
    ].map(({ id, name }) => ({
      [`${property}nodeId`]: `atomic:node:${id}`,
      [`${property}deviceName`]: name,
      [`${property}live`]: true,
      [`${property}lastSeen`]: timestamp,
    }));
    await route.fulfill({ response, json: body });
  });
  await page.route(
    url =>
      url.pathname === '/drive-usage' &&
      url.searchParams.get('peerFullSyncsOnly') === 'true',
    async route => {
      expect(new URL(route.request().url()).searchParams.get('subject')).toBe(
        drive,
      );
      await route.fulfill({
        json: { peerFullSyncs: { [verifiedPeer]: timestamp } },
      });
    },
  );

  await page.goto(`${FRONTEND_URL}/app/sync`);
  await expect(
    page.getByText('Confirmed device', { exact: true }),
  ).toBeVisible();
  await expect(page.getByText('Active device', { exact: true })).toBeVisible();
  const confirmation = page.getByTestId('peer-last-full-sync');
  await expect(confirmation).toHaveCount(1);
  await expect(confirmation).toHaveAttribute(
    'datetime',
    new Date(timestamp).toISOString(),
  );
  await expect(page.getByText(/^Last sync activity /)).toHaveCount(1);

  if (process.env.ATOMIC_PEER_FULL_SYNC_SCREENSHOT) {
    await expect(
      page.locator('#boot-splash:not(.boot-splash-leaving)'),
    ).toHaveCount(0);
    await page.setViewportSize({ width: 1280, height: 900 });
    await confirmation.scrollIntoViewIfNeeded();
    await page.screenshot({
      animations: 'disabled',
      path: process.env.ATOMIC_PEER_FULL_SYNC_SCREENSHOT,
    });
  }
});

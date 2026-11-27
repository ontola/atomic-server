import { test, expect } from '@playwright/test';
import {
  before,
  currentDriveTitle,
  waitForServerConnected,
  waitForSynced,
} from './test-utils';

test('website versions deduplicate without creating sidebar resources', async ({
  page,
}) => {
  await before({ page });
  // The drive title can render from local state before the connection and
  // initial writes settle. This direct model call needs acknowledged writes;
  // createWebsite correctly refuses an offline or queued save.
  await waitForServerConnected(page);
  await waitForSynced(page);
  const saved = await page.evaluate(async () => {
    const { createWebsite, starterWebsite, readWebsite } =
      window.atomicE2E.websiteModel;
    const { buildWebsiteArtifact, saveWebsiteRelease } =
      window.atomicE2E.websiteExport;
    const store = window.store;
    const drive = store.getDrive()!;
    const config = starterWebsite('Version navigation');
    const site = await createWebsite(store, drive, config);
    const artifact = await buildWebsiteArtifact(store, site.subject, config);
    const first = await saveWebsiteRelease(store, drive, site, artifact);
    const again = await saveWebsiteRelease(store, drive, site, {
      ...artifact,
      createdAt: new Date().toISOString(),
    });
    const { terms } = await readWebsite(store, drive, site);

    return {
      subject: site.subject,
      first,
      again,
      release: site.get(terms.properties.release!),
      source: terms.source,
    };
  });
  expect(saved.again.state!.deployments).toHaveLength(1);
  expect(saved.again.state!.revision).toBe(saved.first.state!.revision);
  expect(saved.release).toBeFalsy();
  expect(saved.source).toBe('fixed');
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(saved.subject)}`,
  );
  await expect(
    page.getByRole('button', { name: /Show (all|fewer) versions/ }),
  ).toHaveCount(0);
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(saved.subject)}&view=website-version:${saved.first.deployment}`,
  );
  await expect(
    page.getByRole('link', { name: 'Back to website' }),
  ).toBeVisible();
  await expect(
    page
      .frameLocator('iframe[title="Website preview"]')
      .getByRole('heading', { name: 'Version navigation' })
      .first(),
  ).toBeVisible();
});

test('website authoring waits for the connection acknowledgement after the drive has rendered', async ({
  page,
}) => {
  await before({ page });
  await waitForServerConnected(page);
  await waitForSynced(page);

  // The old setup mistook a locally rendered drive for write readiness. Hold
  // the real server's replies, including AUTH_OK, while that drive loads again.
  let holding = true;
  const replies: Array<() => void> = [];
  await page.routeWebSocket('**/ws', socket => {
    const server = socket.connectToServer();
    socket.onMessage(message => server.send(message));
    server.onMessage(message => {
      if (holding) replies.push(() => socket.send(message));
      else socket.send(message);
    });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(currentDriveTitle(page)).toBeVisible();
  await expect.poll(() => replies.length).toBeGreaterThan(0);
  expect(
    await page.evaluate(() => window.store.getSyncStatus().serverConnected),
  ).toBe(false);

  const ready = waitForServerConnected(page);
  holding = false;
  for (const reply of replies.splice(0)) reply();
  await ready;
  await waitForSynced(page);
  const created = await page.evaluate(async () => {
    const store = window.store;
    const { createWebsite, starterWebsite } = window.atomicE2E.websiteModel;
    const site = await createWebsite(
      store,
      store.getDrive()!,
      starterWebsite('Acknowledged website'),
    );

    return {
      subject: site.subject,
      pending: store.outbox.hasPending(site.subject),
    };
  });
  expect(created.subject).toMatch(/^atomic:/);
  expect(created.pending).toBe(false);
});

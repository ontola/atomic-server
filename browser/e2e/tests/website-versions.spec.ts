import { test, expect } from '@playwright/test';
import { before } from './test-utils';

test('website versions deduplicate without creating sidebar resources', async ({
  page,
}) => {
  await before({ page });
  const saved = await page.evaluate(async () => {
    const { createWebsite, starterWebsite } =
      window.atomicE2E.websiteModel;
    const { buildWebsiteArtifact, saveAppRelease } =
      window.atomicE2E.websiteExport;
    const store = window.store;
    const drive = store.getDrive()!;
    const config = starterWebsite('Version navigation');
    const site = await createWebsite(store, drive, config);
    const artifact = await buildWebsiteArtifact(store, site.subject, config);
    const first = await saveAppRelease(store, site, artifact);
    const again = await saveAppRelease(store, site, {
      ...artifact,
      createdAt: new Date().toISOString(),
    });

    return {
      subject: site.subject,
      first,
      again,
    };
  });
  expect(saved.again.state!.deployments).toHaveLength(1);
  expect(saved.again.state!.revision).toBe(saved.first.state!.revision);
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
    page.getByRole('link', { name: 'Back to app' }),
  ).toBeVisible();
  await expect(
    page
      .frameLocator('iframe[title="App preview"]')
      .getByRole('heading', { name: 'Version navigation' })
      .first(),
  ).toBeVisible();
});

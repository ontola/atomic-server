import { test, expect } from '@playwright/test';
import { before } from './test-utils';

test('website versions deduplicate without creating sidebar resources', async ({
  page,
}) => {
  await before({ page });
  const saved = await page.evaluate(async () => {
    const { createWebsite, starterWebsite, readWebsite } =
      await import('/src/chunks/Website/websiteModel.ts');
    const { buildWebsiteArtifact, saveWebsiteRelease } =
      await import('/src/chunks/Website/websiteExport.ts');
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
    const { schema } = await readWebsite(store, drive, site);

    return {
      subject: site.subject,
      first,
      again,
      release: site.get(schema.properties!['website-release']),
    };
  });
  expect(saved.again.state.deployments).toHaveLength(1);
  expect(saved.again.state.revision).toBe(saved.first.state.revision);
  expect(saved.release).toBeFalsy();
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

import { test, expect } from '@playwright/test';
import { before } from './test-utils';

test('website sidebar shows five recent versions and can expand the rest', async ({
  page,
}) => {
  await before({ page });
  const subject = await page.evaluate(async () => {
    const { createWebsite, starterWebsite } =
      await import('/src/chunks/Website/websiteModel.ts');
    const { buildWebsiteArtifact, saveWebsiteRelease } =
      await import('/src/chunks/Website/websiteExport.ts');
    const store = window.store;
    const drive = store.getDrive()!;
    const config = starterWebsite('Version navigation');
    const site = await createWebsite(store, drive, config);
    const artifact = await buildWebsiteArtifact(store, site.subject, config);
    for (let i = 0; i < 7; i++) {
      await saveWebsiteRelease(store, drive, site, {
        ...artifact,
        createdAt: new Date(Date.UTC(2026, 8, 15, 12, i)).toISOString(),
      });
    }
    return site.subject;
  });
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(subject)}`,
  );
  const versions = page.getByText(/^Version · /).locator('visible=true');
  await expect(versions).toHaveCount(5);
  await page.getByRole('button', { name: 'Show all versions (7)' }).click();
  await expect(versions).toHaveCount(7);
  await page.getByRole('button', { name: 'Show fewer versions' }).click();
  await expect(versions).toHaveCount(5);
});

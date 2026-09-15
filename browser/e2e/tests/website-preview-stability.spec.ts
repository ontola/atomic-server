import { test, expect } from '@playwright/test';
import { before } from './test-utils';

test('opening Design with AI preserves the preview document', async ({
  page,
}) => {
  await before({ page });
  const subject = await page.evaluate(async () => {
    const { createWebsite, starterWebsite } =
      await import('/src/chunks/Website/websiteModel.ts');
    return (
      await createWebsite(
        window.store,
        window.store.getDrive()!,
        starterWebsite('Stable preview'),
      )
    ).subject;
  });
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(subject)}`,
  );
  const preview = page.frameLocator('iframe[title="Website preview"]');
  await expect(
    preview.getByRole('heading', { name: 'Stable preview' }).first(),
  ).toBeVisible();
  await page
    .locator('iframe[title="Website preview"]')
    .evaluate((frame: HTMLIFrameElement) => {
      frame.contentDocument!.body.setAttribute('data-preserved-preview', 'yes');
    });
  await page
    .getByRole('button', { name: 'Design with AI', exact: true })
    .click();
  // Allow the panel's mount, context reads and resource notifications to settle.
  await page.waitForTimeout(2000);
  await expect(preview.locator('body')).toHaveAttribute(
    'data-preserved-preview',
    'yes',
  );
  await expect(page.getByText('Preparing preview…')).toHaveCount(0);
});

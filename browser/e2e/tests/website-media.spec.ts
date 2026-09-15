import { test, expect } from '@playwright/test';
import { before } from './test-utils';

test('selected private image renders in a published gallery', async ({
  page,
  request,
}) => {
  test.skip(!process.env.WEBSITE_HOSTING_E2E, 'Needs isolated hosting server');
  await before({ page });
  const subject = await page.evaluate(async () => {
    const { createWebsite, starterWebsite } =
      await import('/src/chunks/Website/websiteModel.ts');
    const bytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
      ),
      c => c.charCodeAt(0),
    );
    const store = window.store;
    const drive = store.getDrive()!;
    const [photo] = await store.uploadFiles(
      [new File([bytes], 'bread.png', { type: 'image/png' })],
      drive,
    );
    const config = starterWebsite('Bakery gallery');
    config.pages[0].media = [{ subject: photo, alt: 'Fresh bread' }];
    const website = await createWebsite(store, drive, config);
    return website.subject;
  });
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(subject)}`,
  );
  const image = page
    .frameLocator('iframe[title="Website preview"]')
    .getByAltText('Fresh bread');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth))
    .toBe(1);
  await page.getByRole('button', { name: 'Publish site', exact: true }).click();
  const link = page.getByRole('link', { name: 'View site', exact: true });
  await expect(link).toBeVisible();
  const target = new URL((await link.getAttribute('href'))!);
  const response = await request.get(`http://127.0.0.1:${target.port}/`, {
    headers: { Host: target.host },
  });
  expect(response.ok()).toBeTruthy();
  expect(await response.text()).toContain('data:image/png;base64,');
  const visitor = await page.context().browser()!.newContext();
  const site = await visitor.newPage();
  await site.goto(target.href);
  await expect
    .poll(() =>
      site
        .getByAltText('Fresh bread')
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBe(1);
  await visitor.close();
});

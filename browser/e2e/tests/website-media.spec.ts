import { test, expect } from '@playwright/test';
import { before } from './test-utils';

test('selected private image renders in a published gallery', async ({
  page,
  request,
}) => {
  test.skip(!process.env.WEBSITE_HOSTING_E2E, 'Needs isolated hosting server');
  await before({ page });
  const subject = await page.evaluate(async () => {
    const { createWebsite, starterWebsite } = window.atomicE2E.websiteModel;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    canvas.getContext('2d')!.fillRect(0, 0, 1, 1);
    const bytes = await new Promise<Blob>(resolve =>
      canvas.toBlob(blob => resolve(blob!), 'image/png'),
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
  await expect(
    page.getByRole('button', { name: 'Up to date', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'More', exact: true }).click();
  const popupPromise = page.waitForEvent('popup');
  await page.getByTestId('menu-item-website-view').click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  const target = new URL(popup.url());
  await popup.close();
  const response = await request.get(`http://127.0.0.1:${target.port}/`, {
    headers: { Host: target.host },
  });
  expect(response.ok()).toBeTruthy();
  const html = await response.text();
  expect(html).not.toContain('data:image');
  expect(html).toContain('/assets/');
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
  const imageURL = await site.getByAltText('Fresh bread').getAttribute('src');
  expect(imageURL).toMatch(
    /^\/_releases\/[a-f0-9]{64}\/assets\/[a-f0-9]{64}\.png$/,
  );
  const asset = await request.get(
    `http://127.0.0.1:${target.port}${imageURL}`,
    { headers: { Host: target.host } },
  );
  expect(asset.headers()['content-type']).toBe('image/png');
  expect((await asset.body()).length).toBeGreaterThan(0);
  await visitor.close();
});

test('large original photos are optimized in the browser without changing the source', async ({
  page,
}) => {
  await before({ page });
  const result = await page.evaluate(async () => {
    const { optimizeWebsiteImage } = window.atomicE2E.optimizeWebsiteImage;
    const canvas = document.createElement('canvas');
    canvas.width = 3200;
    canvas.height = 2400;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#b87333';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const jpeg = await new Promise<Blob>(resolve =>
      canvas.toBlob(b => resolve(b!), 'image/jpeg', 0.95),
    );
    const original = new Blob([jpeg, new Uint8Array(6_550_619 - jpeg.size)], {
      type: 'image/jpeg',
    });
    const optimized = await optimizeWebsiteImage(original);
    const bitmap = await createImageBitmap(optimized);
    const dimensions = [bitmap.width, bitmap.height];
    bitmap.close();

    return {
      original: original.size,
      optimized: optimized.size,
      mime: optimized.type,
      dimensions,
    };
  });
  expect(result.original).toBe(6_550_619);
  expect(result.optimized).toBeLessThanOrEqual(600_000);
  expect(result.mime).toBe('image/webp');
  expect(result.dimensions).toEqual([1920, 1440]);
});

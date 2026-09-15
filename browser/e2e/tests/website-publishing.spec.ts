import { test, expect } from '@playwright/test';
import { before, waitForSynced } from './test-utils';

// Requires an isolated node with ATOMIC_WEBSITE_ORIGIN=http://sites.localhost:PORT.
test('publish, update, rollback and unpublish a website', async ({
  page,
  request,
}) => {
  test.skip(
    !process.env.WEBSITE_HOSTING_E2E,
    'Requires a website hosting node',
  );
  await before({ page });
  await page
    .getByRole('button', { name: 'New Document', exact: true })
    .first()
    .click();
  await page.locator('#document-editor').waitFor();
  await page.locator('#document-editor').fill('Bakery bread costs five euros.');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByPlaceholder(/filter actions/i).fill('website');
  await page.getByTestId('menu-item-new-website').click();
  const createRelease = async () => {
    const button = page.getByRole('button', {
      name: 'Prepare release',
      exact: true,
    });
    await expect(button).toBeEnabled({ timeout: 30000 });
    await button.click();
    await page
      .getByRole('button', { name: 'Create release', exact: true })
      .click();
    await expect(
      page.getByText('Frozen release', { exact: true }),
    ).toBeVisible();
  };
  await createRelease();
  const websiteURL = page.url();
  await page
    .getByRole('button', { name: 'Upload saved release', exact: true })
    .click();
  const preview = page.frameLocator('iframe[title="Uploaded website preview"]');
  await expect(
    preview.getByText('Bakery bread costs five euros.'),
  ).toBeVisible();
  await expect(
    page.getByText('Website is not published', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Publish reviewed release', exact: true })
    .click();
  const link = page.getByRole('link', { name: 'Open website', exact: true });
  await expect(link).toBeVisible();
  const target = new URL((await link.getAttribute('href'))!);
  const visitor = await page.context().browser()!.newContext();
  const publicPage = await visitor.newPage();
  await publicPage.goto(target.toString());
  await expect(
    publicPage.getByText('Bakery bread costs five euros.'),
  ).toBeVisible();
  await visitor.close();
  const getPublic = () =>
    request.get(`http://127.0.0.1:${target.port}/`, {
      headers: { Host: target.host },
    });
  await expect
    .poll(async () => (await getPublic()).text())
    .toContain('Bakery bread costs five euros.');
  await page.getByRole('link', { name: 'Edit document', exact: true }).click();
  await page.locator('#document-editor').fill('Bakery bread costs six euros.');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.keyboard.press('Escape');
  await waitForSynced(page);
  await page.goto(websiteURL);
  await expect(
    page
      .frameLocator('iframe[title="Website preview"]')
      .getByText('Bakery bread costs six euros.'),
  ).toBeVisible();
  expect(await (await getPublic()).text()).toContain(
    'Bakery bread costs five euros.',
  );
  await createRelease();
  await page
    .getByRole('button', { name: 'Upload saved release', exact: true })
    .click();
  await expect(
    preview.getByText('Bakery bread costs six euros.'),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Publish reviewed release', exact: true })
    .click();
  await expect
    .poll(async () => (await getPublic()).text())
    .toContain('Bakery bread costs six euros.');
  await page
    .getByLabel('Review an uploaded release', { exact: true })
    .selectOption({ label: 'Release 1' });
  await expect(
    preview.getByText('Bakery bread costs five euros.'),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Publish reviewed release', exact: true })
    .click();
  await expect
    .poll(async () => (await getPublic()).text())
    .toContain('Bakery bread costs five euros.');
  await page
    .getByRole('button', { name: 'Unpublish website', exact: true })
    .click();
  await expect.poll(async () => (await getPublic()).status()).toBe(404);
});

import { test, expect } from './fixtures';
import { before } from './test-utils';

test('hide templates preference removes templates from New and survives reload', async ({
  page,
}) => {
  await before({ page });
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/app/new`);
  await expect(
    page.getByRole('region', { name: 'Templates', exact: true }),
  ).toBeVisible();
  await page.goto(`${origin}/app/settings?q=templates`);
  await page
    .getByRole('checkbox', { name: 'Hide templates on new resource page' })
    .check();
  await page.goto(`${origin}/app/new`);
  await expect(
    page.getByRole('searchbox', {
      name: 'Search templates and resource types',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Templates', exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('searchbox', {
      name: 'Search templates and resource types',
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Templates', exact: true }),
  ).toHaveCount(0);
  await page.goto(`${origin}/app/settings?q=templates`);
  await page
    .getByRole('checkbox', { name: 'Hide templates on new resource page' })
    .uncheck();
  await page.goto(`${origin}/app/new`);
  await expect(
    page.getByRole('region', { name: 'Templates', exact: true }),
  ).toBeVisible();
});

import { expect, test, type Page } from './fixtures';
import { enableIntegrationDiscovery } from './integration-settings-utils';
import {
  before,
  clickAccountMenuItem,
  getCurrentSubject,
  waitForDriveSettled,
  waitForSynced,
} from './test-utils';
import {
  GITHUB_ICON,
  PLATFORM,
  finishConsent,
  mockIntegrationProxy,
  openConsent,
} from './fixtures/syncablesProxy';

const appFrame = (page: Page) => page.locator('iframe[title="App"]:visible');
const accountChooser = (page: Page) => appFrame(page).contentFrame();
const card = (page: Page) =>
  page.locator(`[data-proxy-platform="${PLATFORM}"]`);
const sidebar = (page: Page) => page.getByTestId('sidebar');

async function install(page: Page) {
  await waitForSynced(page);
  await waitForDriveSettled(page);
  await enableIntegrationDiscovery(page);
  await clickAccountMenuItem(page, 'Apps');
  await card(page).getByRole('button', { name: 'Add GitHub to drive' }).click();
  await expect(
    accountChooser(page).getByRole('heading', { name: 'Connected principals' }),
  ).toBeVisible({ timeout: 45_000 });
}

test('installs the authorized principal once through the sandboxed catalog chooser', async ({
  page,
}, testInfo) => {
  test.setTimeout(150_000);
  const requests = await mockIntegrationProxy(page);
  await before({ page }, testInfo);
  await install(page);
  const setupUrl = page.url();
  const setup = await getCurrentSubject(page);
  const chooser = accountChooser(page);
  const name = { name: 'GitHub · michiel', exact: true };
  await expect(appFrame(page)).toHaveAttribute('sandbox', /\ballow-scripts\b/);
  await expect(appFrame(page)).not.toHaveAttribute(
    'sandbox',
    /\ballow-same-origin\b/,
  );
  expect(await chooser.locator('html').evaluate(() => window.origin)).toBe(
    'null',
  );
  await expect(
    sidebar(page).getByRole('button', { name: 'GitHub', exact: true }),
  ).toHaveCount(0);
  expect(requests.iconRequests).toEqual([GITHUB_ICON]);
  await testInfo.attach('catalog-account-chooser', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await openConsent(page, chooser, 'Connect account');
  await page.getByRole('link', { name: 'Decline', exact: true }).click();
  await expect(page).toHaveURL(setupUrl);
  expect(requests.redeemed).toHaveLength(0);

  await openConsent(page, chooser, 'Connect account');
  const principal = await finishConsent(page);
  expect(principal).not.toBe(setup);
  await expect(sidebar(page).getByRole('button', name)).toHaveCount(1);
  await expect(appFrame(page)).toHaveCount(0);
  await testInfo.attach('catalog-principal-app', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });

  await page.goto(setupUrl);
  await expect(chooser.getByRole('button', name)).toBeVisible();
  await openConsent(page, chooser, 'Connect account');
  expect(await finishConsent(page)).toBe(principal);
  await expect(sidebar(page).getByRole('button', name)).toHaveCount(1);
  expect(requests.redeemed).toHaveLength(2);
  expect(requests.providerRequests.length).toBeGreaterThan(0);
  expect(requests.providerRequests.every(path => path === '/user')).toBe(true);
});

test('installs a separate Public App and reopens it without OAuth or provider reads', async ({
  page,
}, testInfo) => {
  test.setTimeout(100_000);
  const requests = await mockIntegrationProxy(page);
  await before({ page }, testInfo);
  await install(page);
  const setupUrl = page.url();
  const setup = await getCurrentSubject(page);
  const name = { name: 'GitHub · Public', exact: true };
  await accountChooser(page)
    .getByRole('button', { name: 'Public', exact: true })
    .click();
  await expect(page.getByRole('heading', name)).toBeVisible();
  const subject = await getCurrentSubject(page);
  expect(subject).not.toBe(setup);
  await expect(sidebar(page).getByRole('button', name)).toHaveCount(1);

  await page.goto(setupUrl);
  await accountChooser(page).getByRole('button', name).click();
  await expect(page.getByRole('heading', name)).toBeVisible();
  expect(await getCurrentSubject(page)).toBe(subject);
  expect(requests.redeemed).toHaveLength(0);
  expect(requests.providerRequests).toHaveLength(0);
});

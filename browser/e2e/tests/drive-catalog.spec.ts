import { test, expect } from './fixtures';
import { before, FRONTEND_URL } from './test-utils';

test('account drives can be removed, stay removed after reload and reconnect, and restored', async ({
  page,
  context,
}) => {
  await before({ page });
  const agent = await page.evaluate(() => window.store.getAgent()!.subject);
  const local = await page.evaluate(() => window.store.getDrive()!);
  const remote = 'did:ad:catalog-remote';
  let removed = false;
  let serviceRemovalCalls = 0;
  let published: { drive_subject: string }[] = [];
  await context.route('http://localhost:3037/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    let json: unknown = [];
    if (path === '/api/drives/remove') serviceRemovalCalls++;
    if (path === '/api/me') json = { email: 'catalog@example.com' };
    if (path === '/api/recovery-secret')
      json = { agent_subject: agent, drive_subject: local, wrappers: [] };

    if (path === '/api/drives/catalog') {
      published = route.request().postDataJSON();
      json = {
        drives: removed
          ? []
          : [{ drive_subject: remote, drive_name: 'Account-only project' }],
        removed: removed ? [remote] : [],
      };
    }

    await route.fulfill({
      json,
      headers: {
        'Access-Control-Allow-Origin': FRONTEND_URL,
        'Access-Control-Allow-Credentials': 'true',
      },
    });
  });
  await context.addInitScript(() => {
    (
      window as unknown as { __ATOMIC_MANAGED__: { portalUrl: string } }
    ).__ATOMIC_MANAGED__ = { portalUrl: 'http://localhost:3037' };
  });
  await page.goto(`${FRONTEND_URL}/app/agent`);
  const list = page.getByTestId('my-drives');
  await expect(
    list.getByRole('radio', { name: 'Account-only project' }),
  ).toBeVisible();
  await expect
    .poll(() => published.some(e => e.drive_subject === local))
    .toBe(true);
  await page
    .getByRole('button', { name: 'Manage drives', exact: true })
    .click();
  await expect(list.getByRole('checkbox', { name: /Private/ })).toBeDisabled();
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await page
    .getByRole('button', { name: 'Remove selected (1)', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText('Account-only project');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(
    list.getByRole('checkbox', { name: /Account-only project/ }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Remove selected (1)', exact: true })
    .click();
  await page
    .getByRole('button', { name: 'Remove from list', exact: true })
    .click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(
    list.getByRole('checkbox', { name: /Account-only project/ }),
  ).toHaveCount(0);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Manage drives', exact: true }),
  ).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(
    list.getByRole('radio', { name: /Account-only project/ }),
  ).toHaveCount(0);
  await page.getByText('Removed from My drives (1)', { exact: true }).click();
  await page.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(
    list.getByRole('radio', { name: /Account-only project/ }),
  ).toBeVisible();
  expect(serviceRemovalCalls).toBe(0);
  removed = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(
    list.getByRole('radio', { name: 'Account-only project' }),
  ).toHaveCount(0);
});

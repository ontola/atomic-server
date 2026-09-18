import { test, expect } from '@playwright/test';
import { enableIntegrationDiscovery } from './integration-settings-utils';
import { waitForClientDbFlush } from './test-utils';
const FRONTEND_URL = process.env.FRONTEND_URL ?? 'http://localhost:6747';
test.use({ serviceWorkers: 'block' });

// Clockify through LocalThought, end to end, against the local mock proxy:
// consent, PKCE redemption, the workspace/account picker, the bounded
// time-entries fetch, the Timer view and the Manage panel. The server's
// plugin endpoints are blocked throughout, so this also proves the flow needs
// no server-side plugin, secret or HTTP call (#1534). AtomicServer itself
// stays reachable: unlike the Calendar spec this one also runs against a
// separately served frontend, which loads the catalog and the drive's
// preferences from it. No real credentials are used.
test('Clockify connects through LocalThought, picks a workspace and imports completed entries into a Timer view', async ({
  page,
}) => {
  test.setTimeout(180_000);
  // The mock proxy is an ES module; a static import would make this spec
  // ESM too, and then it could not import the CommonJS test helpers.
  const { mockProxy } =
    await import('../../../integrations/localthought/mock-proxy.mjs');
  const proxy = mockProxy({ frontendOrigin: new URL(FRONTEND_URL).origin });
  await new Promise<void>(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as { port: number }).port;
  const proxyOrigin = `http://127.0.0.1:${port}`;
  // Pin the proxy origin the app calls (see google-calendar-import.spec.ts
  // for why the build-time default cannot be trusted here).
  const configuredProxy = 'https://localthought.io';
  await page.addInitScript(origin => {
    localStorage.setItem('integration-proxy-url', origin);
  }, configuredProxy);
  await page.goto(`${FRONTEND_URL}/app/dev-drive`);
  await page.waitForURL(/app\/show\?subject=/, { timeout: 60000 });
  const driveUrl = page.url();
  await enableIntegrationDiscovery(page);
  await page.goto(new URL('/app/integrations', page.url()).href);
  await page
    .locator('[data-integration="clockify"]')
    .waitFor({ timeout: 30000 });
  await waitForClientDbFlush(page);
  await page.clock.install();
  await page.routeWebSocket('**/*', socket => socket.close());
  const forbidden: string[] = [];
  const providerPaths: string[] = [];
  let failRefresh = false;
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());

    // The retired server plugin's endpoints: none may be touched.
    if (
      /^\/(integration-proxy|plugin-run|plugin-secret|plugin-release-pin)(\/|$)/.test(
        url.pathname,
      )
    ) {
      forbidden.push(url.pathname);

      return route.abort();
    }

    if (url.origin === configuredProxy) {
      if (url.pathname.startsWith('/proxy/'))
        providerPaths.push(`${request.method()} ${url.pathname}${url.search}`);

      const response = await route.fetch({
        url: `${proxyOrigin}${url.pathname}${url.search}`,
        maxRedirects: 0,
      });

      if (failRefresh && url.pathname.startsWith('/proxy/'))
        return route.fulfill({
          response,
          status: 503,
          body: '{"error":"temporarily unavailable"}',
        });

      return route.fulfill({ response });
    }

    return route.continue();
  });

  try {
    await page.goto(driveUrl);
    await page.waitForURL(/app\/show\?subject=/, { timeout: 60000 });
    await page.getByRole('link', { name: 'Integrations', exact: true }).click();
    const card = page.locator('[data-integration="clockify"]');
    // The visibility preference is written to the private drive in the
    // background and can lag a reload; the page's own toggle applies at once.
    const experimental = page.getByRole('checkbox', {
      name: 'Show experimental plugins',
    });
    await experimental.waitFor({ timeout: 30000 });
    if (!(await experimental.isChecked())) await experimental.check();
    await card.waitFor({ timeout: 30000 });
    // The card is a LocalThought platform: no API-key field, no evidence panel.
    await expect(card.getByLabel('Clockify API key')).toHaveCount(0);
    await card.getByRole('button', { name: 'Set up connection' }).click();
    const dialog = page.getByRole('dialog').last();
    const steps = dialog.getByLabel('Setup progress');
    await expect(steps.locator('[aria-current="step"]')).toHaveText(/API key/);
    await page
      .getByRole('button', { name: 'Install and connect', exact: true })
      .click();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync Clockify with your Atomic Data Hub',
        exact: true,
      })
      .click();

    // Step 2: the connected-account card, and ids picked from lists rather
    // than typed. The account has one option and is filled in by itself.
    await expect(steps.locator('[aria-current="step"]')).toHaveText(
      /Choose what to sync/,
    );
    await expect(
      dialog.getByText('key sealed by LocalThought, read access only'),
    ).toBeVisible();
    const workspace = dialog.getByLabel('Workspace', { exact: true });
    await expect(workspace).toContainText('Test workspace');
    await expect(workspace).toContainText('Personal');
    await workspace.selectOption({ label: 'Test workspace' });
    await expect(dialog.getByLabel('Account', { exact: true })).toHaveValue(
      'bbbbbbbbbbbbbbbbbbbbbbbb',
    );
    await expect(dialog.getByLabel('Entries from')).toHaveValue('7');
    // Two-way sync is presented, but not selectable yet.
    await expect(dialog.getByLabel(/Two-way sync/)).toBeDisabled();
    await expect(dialog.getByLabel(/Import only/)).toBeChecked();
    await page
      .getByRole('button', { name: 'Complete installation', exact: true })
      .click();
    await expect(steps.locator('[aria-current="step"]')).toHaveText(/Import/);
    await expect(
      page.getByText('Installed. Your records are syncing in the background.'),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Open folder', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toBeVisible({ timeout: 60000 });
    const folderUrl = page.url();

    // The look-back window reached the provider as start/end bounds.
    const bounded = providerPaths.filter(p => /time-entries\?/.test(p));
    expect(bounded.length).toBeGreaterThan(0);
    expect(bounded.every(p => /[?&]start=\d{4}-/.test(p))).toBe(true);
    expect(bounded.every(p => /[?&]end=\d{4}-/.test(p))).toBe(true);

    const openTable = async () => {
      await page
        .locator('[data-test="folder-list"]')
        .getByRole('link', { name: 'Clockify', exact: true })
        .click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Last synced' }),
      ).toBeVisible({ timeout: 60000 });
    };

    await openTable();
    // Opens in the Timer view: the timer toolbar is there, and so is the
    // link back to Clockify.
    await expect(page.getByTestId('timer-start-new')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Open in Clockify', exact: true }),
    ).toHaveAttribute('href', 'https://app.clockify.me/tracker');
    // Two completed entries within seven days; the running timer, the break
    // and the twenty-day-old entry are not imported.
    await expect(page.getByText('Fix plugin source loading')).toBeVisible();
    await expect(page.getByText('Weekly sync')).toBeVisible();
    await expect(page.getByText('Still running')).toHaveCount(0);
    await expect(page.getByText('Lunch')).toHaveCount(0);
    await expect(page.getByText('Plugin catalog evidence')).toHaveCount(0);

    // The Manage panel: status, the locked two-way controls, the mapping,
    // the connection and the run log.
    await page.getByText('Manage sync', { exact: true }).click();
    const manage = page.getByLabel('Clockify sync');
    await expect(manage).toContainText('Up to date');
    await expect(manage).toContainText('Needs two-way sync');
    await expect(manage.getByLabel('Schedule')).toBeDisabled();
    await expect(manage).toContainText('Start · End (Duration derived)');
    await expect(manage).toContainText('Test Person');
    await expect(manage).toContainText('Test workspace');
    // Opening the folder and the table each refresh, so later runs report
    // no changes; the first run is the one that created the two rows.
    await expect(manage).toContainText('2 pulled · 2 changed');

    // Widening the look-back is a browser-side setting; the next run picks
    // up the older entry, and nothing already imported is touched.
    await manage.getByLabel('Look back').selectOption('30');
    await page.getByRole('button', { name: 'Sync now', exact: true }).click();
    await expect(page.getByText('Plugin catalog evidence')).toBeVisible({
      timeout: 60000,
    });
    await expect(page.getByText('Fix plugin source loading')).toBeVisible();

    // A provider change arrives on the next scheduled refresh.
    proxy.clockify.state.entries[1].description = 'Weekly sync (renamed)';
    await page.clock.fastForward(5 * 60 * 1000);
    await expect(page.getByText('Weekly sync (renamed)')).toBeVisible({
      timeout: 60000,
    });
    expect(providerPaths.every(p => p.startsWith('GET '))).toBe(true);

    // A failed refresh leaves the imported entries readable; reopening the
    // folder retries and recovers.
    failRefresh = true;
    await page.goto(folderUrl);
    await expect(
      page.getByRole('status').filter({ hasText: 'Sync needs attention' }),
    ).toBeVisible({ timeout: 60000 });
    failRefresh = false;
    await page.reload();
    await expect(
      page.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toBeVisible({ timeout: 60000 });
    await openTable();
    await expect(page.getByText('Weekly sync (renamed)')).toBeVisible();
    expect(forbidden).toEqual([]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      proxy.close(error => (error ? reject(error) : resolve())),
    );
  }
});

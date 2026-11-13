import { expect, test, type Page, type Route } from '@playwright/test';
import { before, FRONTEND_URL } from './test-utils';

const PROXY = 'https://syncables-test.example';
const CONNECTION = 'test-github-connection';

interface MockState {
  connected: boolean;
  delegations: { agent: string; label: string }[];
  issueRequests: number;
  repositoryRequests: number;
}

/**
 * In-process provider + proxy fixture: intercept HTTP *only*, keeping the real
 * Atomic node, signed application commits and null-origin iframe intact.
 * This tests the browser-to-host flow without using a real GitHub credential.
 */
async function mockIntegrationProxy(
  page: Page,
): Promise<MockState> {
  const state: MockState = {
    connected: false,
    delegations: [],
    issueRequests: 0,
    repositoryRequests: 0,
  };
  const repos = [
    {
      id: 456,
      name: 'atomic-server',
      full_name: 'ontola/atomic-server',
      owner: { id: 123, login: 'ontola', type: 'Organization' },
      has_issues: true,
    },
    {
      id: 789,
      name: 'notes',
      full_name: 'michiel/notes',
      owner: { id: 321, login: 'michiel', type: 'User' },
      has_issues: true,
    },
  ];

  await page.route(PROXY + '/**', async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const headers = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers':
        request.headers()['access-control-request-headers'] || '*',
      'cache-control': 'no-store',
    };
    const send = (data: unknown, status = 200) =>
      route.fulfill({
        status,
        headers,
        contentType: 'application/json',
        body: JSON.stringify(data),
      });

    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers });
      return;
    }
    if (url.pathname === '/catalog/apps') {
      await send({
        version: 1,
        platforms: [
          {
            id: 'github-issues',
            name: 'GitHub',
            description: 'Mirror repositories and issues',
            document: '/catalog/github-issues.yaml',
          },
        ],
      });
      return;
    }
    if (url.pathname === '/catalog') {
      await send(['github-issues']);
      return;
    }
    if (url.pathname === '/connections') {
      await send({
        connections: state.connected
          ? [
              {
                connection_id: CONNECTION,
                platform: 'github-issues',
                delegations: state.delegations,
              },
            ]
          : [],
        runtimes: [],
      });
      return;
    }
    if (url.pathname === '/connect' && request.method() === 'GET') {
      const callback = url.searchParams.get('redirect_uri');
      if (!callback) throw new Error('Missing OAuth callback');
      const back = new URL(callback);
      back.searchParams.set('connection_code', 'fixture-pkce-code');
      await route.fulfill({
        status: 302,
        headers: { ...headers, location: back.href },
      });
      return;
    }
    if (url.pathname === '/connect/redeem' && request.method() === 'POST') {
      state.connected = true;
      await send({
        connection_id: CONNECTION,
        platform: 'github-issues',
      });
      return;
    }
    if (
      url.pathname === '/connections/' + CONNECTION + '/agents' &&
      request.method() === 'POST'
    ) {
      const body = request.postDataJSON() as { agent: string; label?: string };
      state.delegations = [{ agent: body.agent, label: body.label || 'Syncables' }];
      await send({ connection_id: CONNECTION, agent: body.agent });
      return;
    }
    if (
      url.pathname === '/proxy/' + CONNECTION + '/github-issues/user/repos' &&
      request.method() === 'GET'
    ) {
      state.repositoryRequests++;
      await send(repos);
      return;
    }
    if (
      url.pathname ===
        '/proxy/' + CONNECTION + '/github-issues/repos/ontola/atomic-server/issues' &&
      request.method() === 'GET'
    ) {
      state.issueRequests++;
      await send([
        {
          id: 9001,
          number: 15,
          title: 'GitHub Issues E2E example',
          state: 'open',
          body: 'A real imported Atomic table row from the mock provider.',
          updated_at: '2026-11-13T10:00:00Z',
          html_url: 'https://github.com/ontola/atomic-server/issues/15',
        },
      ]);
      return;
    }

    await send({ error: 'unexpected request', path: url.pathname }, 404);
  });

  return state;
}

test.describe('built-in GitHub Syncables onboarding', () => {
  test.use({ serviceWorkers: 'block' });

  test('connects, discovers owners, and mirrors selected issues inside a sandbox', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);

    await page.addInitScript(proxy => {
      localStorage.setItem('integration-proxy-url', proxy);
    }, PROXY);
    const requests = await mockIntegrationProxy(page);
    await before({ page }, testInfo);
    await page.goto(FRONTEND_URL + '/app/apps?preview=plugins');

    const experimental = page.getByRole('checkbox', {
      name: 'Show experimental plugins',
    });
    await expect(experimental).toBeVisible();
    await experimental.check();

    const github = page.locator('[data-proxy-platform="github-issues"]');
    await expect(github).toContainText('GitHub');
    await github.getByRole('button', { name: 'Add GitHub to drive' }).click();

    const iframe = page.frameLocator(
      'iframe[title="Built-in Syncables collection view"]',
    );
    await expect(
      iframe.getByRole('heading', { name: 'No accounts connected' }),
    ).toBeVisible({ timeout: 30_000 });
    await iframe.getByRole('button', { name: 'Connect GitHub account' }).click();
    await expect(page.getByRole('heading', { name: 'Connect GitHub' })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', {
      name: 'Connect',
      exact: true,
    }).click();

    await expect(
      iframe.getByRole('button', { name: 'Browse organizations' }),
    ).toBeVisible({ timeout: 45_000 });
    await iframe.getByRole('button', { name: 'Browse organizations' }).click();

    await expect(iframe.getByText('ontola', { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect(iframe.getByText('michiel', { exact: true })).toBeVisible();
    await iframe
      .getByRole('row', { name: /ontola/ })
      .getByRole('button', { name: 'Open' })
      .click();

    await expect(
      iframe.getByText('atomic-server', { exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    await iframe
      .getByRole('row', { name: /atomic-server/ })
      .getByRole('button', { name: 'Sync issues' })
      .click();

    await expect(
      iframe.getByRole('button', { name: 'Sync now' }),
    ).toBeVisible({ timeout: 45_000 });
    await iframe.getByRole('button', { name: 'Sync now' }).click();
    await expect(iframe.getByText('1', { exact: true })).toBeVisible();

    await page.getByRole('tab', { name: 'Table' }).click();
    await expect(
      page.getByRole('main').getByText('GitHub Issues E2E example'),
    ).toBeVisible({ timeout: 45_000 });

    expect(requests.repositoryRequests).toBeGreaterThan(0);
    expect(requests.issueRequests).toBe(1);
  });
});

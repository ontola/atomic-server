import { createHash, createPublicKey, verify } from 'node:crypto';
import { expect, test, type Page, type Request, type Route } from './fixtures';
import { enableIntegrationDiscovery } from './integration-settings-utils';
import {
  before,
  clickAccountMenuItem,
  currentDriveTitle,
  FRONTEND_URL,
} from './test-utils';

const PROXY = 'https://syncables-test.example';
const PLATFORM = 'github-issues';
const FIRST_ISSUE_TITLE = 'GitHub Issues E2E example';
const UPDATED_ISSUE_TITLE = 'Updated GitHub Issues E2E example';
const RETAINED_ISSUE_TITLE = 'Issue omitted from the next read';
const PULL_REQUEST_TITLE = 'Pull request returned by the GitHub Issues API';

interface MockConnection {
  connection_id: string;
  platform: string;
  owner: string;
  label: string;
  key: string;
  delegations: [];
}

interface MockState {
  redeemed: string[];
  issueConnections: string[];
  repositoryRequests: number;
  expiredConnection?: string;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value);

/** Validate the proxy's wire contract even though GitHub is a fixture. */
function requestSigner(request: Request): string {
  const headers = request.headers();
  expect(headers['x-atomic-signature-version']).toBe('2');
  const key = Buffer.from(headers['x-atomic-public-key'], 'base64');
  expect(key).toHaveLength(32);
  const agent = headers['x-atomic-agent'].replace(
    /^(?:atomic:agent:|did:ad:agent:)/,
    '',
  );
  expect(Buffer.from(agent, 'base64')).toEqual(key);
  const timestamp = headers['x-atomic-timestamp'];
  expect(Number(timestamp)).toBeGreaterThan(Date.now() - 5 * 60_000);
  expect(Number(timestamp)).toBeLessThan(Date.now() + 5 * 60_000);
  const message = [
    'atomic-request-v2',
    request.method(),
    request.url(),
    timestamp,
    sha256(request.postDataBuffer() ?? Buffer.alloc(0)).digest('hex'),
  ];
  const connectionKey = headers['x-connection-key'];
  if (connectionKey) message.push(sha256(connectionKey).digest('hex'));
  const publicKey = createPublicKey({
    format: 'jwk',
    key: { kty: 'OKP', crv: 'Ed25519', x: key.toString('base64url') },
  });
  expect(
    verify(
      null,
      Buffer.from(message.join('\n')),
      publicKey,
      Buffer.from(headers['x-atomic-signature'], 'base64'),
    ),
  ).toBe(true);

  return 'atomic:agent:' + key.toString('base64url');
}

function issue(
  id: number,
  number: number,
  title: string,
  state: 'open' | 'closed' = 'open',
) {
  return {
    id,
    number,
    title,
    state,
    body: 'An imported Atomic table row from the mock provider.',
    updated_at:
      state === 'closed' ? '2026-11-14T10:00:00Z' : '2026-11-13T10:00:00Z',
    html_url: `https://github.com/ontola/atomic-server/issues/${number}`,
  };
}

/**
 * In-process provider + proxy fixture: intercept HTTP *only*, keeping the real
 * Atomic node, signed application commits and null-origin iframe intact.
 * This tests the browser-to-host flow without using a real GitHub credential.
 */
async function mockIntegrationProxy(page: Page): Promise<MockState> {
  const state: MockState = {
    redeemed: [],
    issueConnections: [],
    repositoryRequests: 0,
  };
  const connections = new Map<string, MockConnection>();
  let consentAttempts = 0;
  let pending: { challenge: string; code: string } | undefined;
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
      'access-control-expose-headers': 'link',
      'cache-control': 'no-store',
    };
    const send = (
      data: unknown,
      status = 200,
      extraHeaders?: Record<string, string>,
    ) =>
      route.fulfill({
        status,
        headers: { ...headers, ...extraHeaders },
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
            id: PLATFORM,
            name: 'GitHub',
            description: 'Mirror repositories and issues',
            document: '/catalog/github-issues.yaml',
          },
        ],
      });

      return;
    }

    if (url.pathname === '/catalog') {
      await send([PLATFORM]);

      return;
    }

    if (url.pathname === '/connections') {
      const owner = requestSigner(request);
      const owned = [...connections.values()]
        .filter(connection => connection.owner === owner)
        .map(connection => ({ ...connection, key: undefined }));
      await send({
        owner,
        connections: owned,
        runtimes: [],
      });

      return;
    }

    if (url.pathname === '/connect' && request.method() === 'GET') {
      const callback = url.searchParams.get('redirect_uri');
      if (!callback) throw new Error('Missing OAuth callback');
      const back = new URL(callback);
      expect(back.origin).toBe(new URL(FRONTEND_URL).origin);
      expect(back.pathname).toBe('/app/integrations');
      expect(back.searchParams.get('platform')).toBe(PLATFORM);
      expect(back.searchParams.get('integration_state')).toMatch(/^[\w-]{43}$/);
      expect(url.searchParams.get('platform')).toBe(PLATFORM);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      const challenge = url.searchParams.get('code_challenge') ?? '';
      expect(challenge).toMatch(/^[\w-]{43}$/);
      pending = {
        challenge,
        code: Buffer.alloc(32, ++consentAttempts).toString('base64url'),
      };

      const denied = new URL(back);
      denied.searchParams.set('error', 'access_denied');
      back.searchParams.set('connection_code', pending.code);
      await route.fulfill({
        headers,
        contentType: 'text/html',
        body: `<!doctype html><title>GitHub fixture</title>
          <h1>Authorize GitHub</h1>
          <a href="${back.href.replaceAll('&', '&amp;')}">Authorize</a>
          <a href="${denied.href.replaceAll('&', '&amp;')}">Decline</a>`,
      });

      return;
    }

    if (url.pathname === '/connect/redeem' && request.method() === 'POST') {
      const owner = requestSigner(request);
      const { code, code_verifier, connection_id, connection_key } =
        request.postDataJSON() as {
          code: string;
          code_verifier: string;
          connection_id: string;
          connection_key: string;
        };
      expect(code).toBe(pending?.code);
      expect(sha256(code_verifier).digest('base64url')).toBe(
        pending?.challenge,
      );
      pending = undefined;
      expect(connection_id).toMatch(/^[\w-]{43}$/);
      expect(connection_key).toMatch(/^k1\.[\w-]{43}$/);
      expect(connections.has(connection_id)).toBe(false);
      const connection: MockConnection = {
        connection_id,
        platform: PLATFORM,
        owner,
        label: 'michiel',
        key: connection_key,
        delegations: [],
      };
      connections.set(connection_id, connection);
      state.redeemed.push(connection_id);
      await send({
        connection_id,
        platform: PLATFORM,
        owner,
        label: connection.label,
      });

      return;
    }

    if (!url.pathname.startsWith('/proxy/')) {
      expect(
        url.pathname,
        'Built-in Syncables uses the owner connection directly',
      ).not.toMatch(/^\/connections\/[^/]+\/agents\b/);
      await send({ error: 'unexpected request', path: url.pathname }, 404);

      return;
    }

    const [, , connectionId, platform, ...endpoint] = url.pathname.split('/');
    const connection = connections.get(connectionId);
    if (!connection)
      throw new Error('Provider read without a redeemed connection');
    expect(platform).toBe(PLATFORM);
    expect(request.method()).toBe('GET');
    expect(request.frame()).toBe(page.mainFrame());
    expect(request.headers().authorization).toBeUndefined();
    expect(requestSigner(request)).toBe(connection.owner);
    expect(request.headers()['x-connection-key']).toBe(connection.key);
    const providerPath = '/' + endpoint.join('/');

    if (providerPath === '/user') {
      await send({ id: 321, login: 'michiel', type: 'User' });

      return;
    }

    if (providerPath === '/user/orgs') {
      await send([
        { id: 123, login: 'ontola' },
        { id: 124, login: 'reporting' },
      ]);

      return;
    }

    if (providerPath === '/user/repos') {
      state.repositoryRequests++;
      await send(repos);

      return;
    }

    if (providerPath === '/repositories/456/issues') {
      expect(url.searchParams.get('state')).toBe('all');
      state.issueConnections.push(connectionId);

      if (connectionId === state.expiredConnection) {
        await send({ error: 'credential_refresh_failed' }, 401);
      } else if (state.issueConnections.length === 1) {
        expect(url.searchParams.get('page')).toBe('1');
        const next = new URL('https://api.github.com/repositories/456/issues');
        next.search = url.search;
        next.searchParams.set('page', '2');
        await send(
          [
            issue(9001, 15, FIRST_ISSUE_TITLE),
            { ...issue(9003, 17, PULL_REQUEST_TITLE), pull_request: {} },
          ],
          200,
          { link: `<${next.href}>; rel="next"` },
        );
      } else if (state.issueConnections.length === 2) {
        expect(url.searchParams.get('page')).toBe('2');
        await send([
          issue(9001, 15, FIRST_ISSUE_TITLE),
          issue(9002, 16, RETAINED_ISSUE_TITLE),
        ]);
      } else {
        expect(url.searchParams.get('page')).toBe('1');
        await send([issue(9001, 15, UPDATED_ISSUE_TITLE, 'closed')]);
      }

      return;
    }

    await send({ error: 'unexpected request', path: url.pathname }, 404);
  });

  return state;
}

test.describe('built-in GitHub Syncables onboarding', () => {
  test('connects, discovers owners, and mirrors selected issues inside a sandbox', async ({
    page,
    browserDiagnostics,
  }, testInfo) => {
    test.setTimeout(180_000);

    await page.addInitScript(
      ({ origin, proxy }) => {
        if (window === window.top && location.origin === origin)
          localStorage.setItem('integration-proxy-url', proxy);
      },
      { origin: new URL(FRONTEND_URL).origin, proxy: PROXY },
    );
    const requests = await mockIntegrationProxy(page);
    await before({ page }, testInfo);
    const driveUrl = page.url();
    await enableIntegrationDiscovery(page);
    await expect(page).toHaveURL(driveUrl);
    await expect(currentDriveTitle(page)).toBeVisible();
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar.getByText('Apps', { exact: true })).toHaveCount(0);
    await clickAccountMenuItem(page, 'Apps');
    await expect(
      page.getByRole('heading', { name: 'Apps', exact: true }),
    ).toBeVisible();

    const github = page.locator(`[data-proxy-platform="${PLATFORM}"]`);
    await expect(github).toContainText('GitHub');
    await testInfo.attach('apps-discovery', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await github.getByRole('button', { name: 'Add GitHub to drive' }).click();

    const frame = page.getByTitle('Built-in Syncables collection view');
    const iframe = frame.contentFrame();
    const emptyAccounts = iframe.getByRole('heading', {
      name: 'No accounts connected',
    });
    await expect(emptyAccounts).toBeVisible({ timeout: 30_000 });
    const platformUrl = page.url();
    await expect(sidebar.getByText('GitHub', { exact: true })).toBeVisible();
    await expect(frame).toHaveAttribute('sandbox', /\ballow-scripts\b/);
    await expect(frame).not.toHaveAttribute('sandbox', /\ballow-same-origin\b/);
    expect(await iframe.locator('html').evaluate(() => window.origin)).toBe(
      'null',
    );

    await clickAccountMenuItem(page, 'Apps');
    await github.getByRole('button', { name: 'Open GitHub' }).click();
    await expect(page).toHaveURL(platformUrl);
    await expect(emptyAccounts).toBeVisible({ timeout: 30_000 });

    const openConsent = async (buttonName: string) => {
      await iframe
        .getByRole('button', { name: buttonName, exact: true })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Connect GitHub' });
      await dialog
        .getByRole('button', { name: 'Connect', exact: true })
        .click();
      await expect(
        page.getByRole('heading', { name: 'Authorize GitHub' }),
      ).toBeVisible();
    };

    await openConsent('Connect GitHub account');
    await page.getByRole('link', { name: 'Decline' }).click();
    await expect(page).toHaveURL(platformUrl);
    await expect(emptyAccounts).toBeVisible({ timeout: 30_000 });
    expect(requests.redeemed).toHaveLength(0);

    await openConsent('Connect GitHub account');
    await page.getByRole('link', { name: 'Authorize', exact: true }).click();
    await expect(page).toHaveURL(platformUrl, { timeout: 45_000 });
    await expect(
      iframe.getByRole('button', { name: 'Browse organizations' }),
    ).toBeVisible({ timeout: 45_000 });
    await testInfo.attach('github-accounts', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await iframe.getByRole('button', { name: 'Browse organizations' }).click();

    await expect(iframe.getByText('ontola', { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect(iframe.getByText('reporting', { exact: true })).toBeVisible();
    const personalOwner = iframe.getByRole('row', {
      name: /michiel.*Personal owner/,
    });
    await expect(personalOwner).toBeVisible();
    await testInfo.attach('github-owner-namespaces', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    const ownersUrl = page.url();
    await personalOwner.getByRole('button', { name: 'Open' }).click();
    await expect(iframe.getByText('notes', { exact: true })).toBeVisible({
      timeout: 45_000,
    });
    await expect(
      iframe.getByRole('row', { name: /ontola\/atomic-server/ }),
    ).toHaveCount(0);
    await page.goto(ownersUrl);
    await iframe
      .getByRole('row', { name: /ontola/ })
      .getByRole('button', { name: 'Open' })
      .click();

    await expect(
      iframe.getByText('atomic-server', { exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    await expect(
      iframe.getByRole('row', { name: /michiel\/notes/ }),
    ).toHaveCount(0);
    expect(requests.issueConnections).toHaveLength(0);
    await testInfo.attach('github-repositories', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await iframe
      .getByRole('row', { name: /atomic-server/ })
      .getByRole('button', { name: 'Sync issues' })
      .click();

    const syncNow = iframe.getByRole('button', { name: 'Sync now' });
    const tableTab = page.getByRole('tab', { name: 'Table', exact: true });
    const syncTab = page.getByRole('tab', { name: 'Sync', exact: true });
    const rows = page.getByRole('main');
    await expect(syncNow).toBeVisible({ timeout: 45_000 });
    await syncNow.click();
    await expect(iframe.getByText('2', { exact: true })).toBeVisible();
    await iframe.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(iframe.getByText('Paused', { exact: true })).toBeVisible();
    await page.reload();
    await expect(iframe.getByText('Paused', { exact: true })).toBeVisible({
      timeout: 30_000,
    });
    await expect(syncNow).toHaveCount(0);
    await testInfo.attach('github-issues-paused', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await tableTab.click();
    await expect(
      rows.getByText(FIRST_ISSUE_TITLE, { exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    await expect(
      rows.getByText(RETAINED_ISSUE_TITLE, { exact: true }),
    ).toBeVisible();
    await expect(
      rows.getByText(PULL_REQUEST_TITLE, { exact: true }),
    ).toHaveCount(0);
    expect(requests.issueConnections).toHaveLength(2);

    await syncTab.click();
    const resume = iframe.getByRole('button', { name: 'Resume', exact: true });
    await resume.click();
    await expect(resume).toHaveCount(0);
    await syncNow.click();
    await expect(
      iframe.getByText('0 added · 1 changed · 0 unchanged', { exact: true }),
    ).toBeVisible();
    await tableTab.click();
    await expect(
      rows.getByText(UPDATED_ISSUE_TITLE, { exact: true }),
    ).toBeVisible();
    await expect(
      rows.getByText(UPDATED_ISSUE_TITLE, { exact: true }),
    ).toHaveCount(1);
    await expect(
      rows.getByText(FIRST_ISSUE_TITLE, { exact: true }),
    ).toHaveCount(0);
    await expect(
      rows.getByText(RETAINED_ISSUE_TITLE, { exact: true }),
    ).toBeVisible();
    const updated = rows
      .getByRole('row')
      .filter({ hasText: UPDATED_ISSUE_TITLE });
    await expect(updated.getByText('15', { exact: true })).toBeVisible();
    await expect(updated.getByText('closed', { exact: true })).toBeVisible();
    await testInfo.attach('github-issues-table', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    expect(requests.redeemed).toHaveLength(1);
    expect(requests.repositoryRequests).toBeGreaterThan(0);
    const initialConnection = requests.redeemed[0];
    expect(requests.issueConnections).toEqual(Array(3).fill(initialConnection));

    await syncTab.click();
    await expect(syncNow).toBeVisible();
    const mirrorUrl = page.url();
    browserDiagnostics.expect(
      'error',
      /Failed to load resource:.*401/,
      'The proxy refuses the deliberately expired GitHub credential.',
      1,
      /^https:\/\/syncables-test\.example\/proxy\//,
      { optional: true },
    );
    requests.expiredConnection = initialConnection;
    await syncNow.click();
    await expect(
      iframe.getByText('Needs attention', { exact: true }),
    ).toBeVisible();
    await expect(
      iframe.getByText('GitHub read failed (HTTP 401).', { exact: true }),
    ).toBeVisible();
    await openConsent('Reconnect');
    await page.getByRole('link', { name: 'Authorize', exact: true }).click();
    await expect(page).toHaveURL(mirrorUrl, { timeout: 45_000 });
    await expect(syncNow).toBeVisible({ timeout: 30_000 });
    await syncNow.click();
    await expect(
      iframe.getByText('0 added · 0 changed · 1 unchanged', { exact: true }),
    ).toBeVisible();
    await expect(iframe.getByText('Ready', { exact: true })).toBeVisible();
    await tableTab.click();
    await expect(updated).toHaveCount(1);
    await expect(
      rows.getByText(RETAINED_ISSUE_TITLE, { exact: true }),
    ).toBeVisible();
    expect(requests.redeemed).toHaveLength(2);
    const replacement = requests.redeemed[1];
    expect(replacement).not.toBe(initialConnection);
    expect(requests.issueConnections).toEqual([
      ...Array(4).fill(initialConnection),
      replacement,
    ]);
  });
});

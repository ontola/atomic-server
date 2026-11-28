import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  expect,
  type FrameLocator,
  type Page,
  type Request,
  type Route,
} from '../fixtures';
import { FRONTEND_URL, getCurrentSubject } from '../test-utils';

export const PROXY = 'https://syncables-test.example';
export const PLATFORM = 'github-issues';
export const GITHUB_ICON =
  'https://ontola.github.io/atomic-plugins/overlays/assets/github-mark-1.svg';
export const GITHUB_ICON_SVG = readFileSync(
  resolvePath(
    __dirname,
    '../../../data-browser/src/chunks/PluginRuns/fixtures/github-mark-1.svg',
  ),
  'utf8',
);
export const CATALOG_DOCUMENT = JSON.parse(
  readFileSync(
    resolvePath(
      __dirname,
      '../../../data-browser/src/chunks/PluginRuns/fixtures/github-syncables-catalog.json',
    ),
    'utf8',
  ),
);
export const CATALOG_SELECTION = JSON.parse(
  readFileSync(
    resolvePath(
      __dirname,
      '../../../data-browser/src/chunks/PluginRuns/fixtures/github-syncables-selection.json',
    ),
    'utf8',
  ),
);
export const REPOSITORY = 'ontola/atomic-server';
export const GITHUB_API = 'https://api.github.com';
export const PUBLIC_REPOSITORY = GITHUB_API + '/repos/' + REPOSITORY;
export const PUBLIC_ISSUES = GITHUB_API + '/repositories/456/issues';
export const PUBLIC_ISSUE_PAGE_COUNT = 21;
export const FIRST_ISSUE_TITLE = 'GitHub Issues E2E example';
export const UPDATED_ISSUE_TITLE = 'Updated GitHub Issues E2E example';
export const RETAINED_ISSUE_TITLE = 'Issue omitted from the next read';
export const PULL_REQUEST_TITLE =
  'Pull request returned by the GitHub Issues API';

export function publicIssueUrl(page: number): string {
  const url = `${PUBLIC_ISSUES}?per_page=100&page=${page}&state=all`;
  if (page === 1) return url;
  const after = Buffer.from(`cursor:${page}`).toString('base64');

  return url + '&after=' + encodeURIComponent(after);
}

interface MockConnection {
  connection_id: string;
  platform: string;
  owner: string;
  label: string;
  key: string;
  delegations: [];
  principal: { id: number; login: string; name: string; type: 'User' };
}

export interface MockState {
  redeemed: string[];
  issueConnections: string[];
  repositoryRequests: number;
  repositoryConnections: string[];
  repositoryIssueCount: number;
  nextPrincipal: { id: number; login: string; name: string; type: 'User' };
  organizationRequests: number;
  providerRequests: string[];
  documentRequests: string[];
  iconRequests: string[];
  expiredConnection?: string;
  expiredPrincipalConnection?: string;
  principalConnections: string[];
  issueGate?: Promise<void>;
  organizationGate?: Promise<void>;
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

export function issue(
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
    user: { id: 321, login: 'michiel', type: 'User' },
  };
}

/**
 * In-process provider + proxy fixture: intercept HTTP *only*, keeping the real
 * Atomic node, signed application commits and null-origin iframe intact.
 * This tests the browser-to-host flow without using a real GitHub credential.
 */
export async function mockIntegrationProxy(
  page: Page,
  options: {
    platform?: string;
    name?: string;
    document?: Record<string, unknown>;
    selection?: unknown;
  } = {},
): Promise<MockState> {
  const platform = options.platform ?? PLATFORM;
  const serviceName = options.name ?? 'GitHub';
  await page.addInitScript(
    ({ origin, proxy }) => {
      if (window === window.top && location.origin === origin) {
        localStorage.setItem('integration-proxy-url', proxy);
        localStorage.setItem(
          'plugin-catalog-url',
          proxy + '/plugin-catalog.json',
        );
        localStorage.setItem('plugin-marketplaces', '[]');
      }
    },
    { origin: new URL(FRONTEND_URL).origin, proxy: PROXY },
  );
  const state: MockState = {
    redeemed: [],
    principalConnections: [],
    issueConnections: [],
    repositoryRequests: 0,
    repositoryConnections: [],
    repositoryIssueCount: 7,
    nextPrincipal: { id: 321, login: 'michiel', name: 'michiel', type: 'User' },
    organizationRequests: 0,
    providerRequests: [],
    documentRequests: [],
    iconRequests: [],
  };
  // Workbox owns image requests, which bypass page routes. Keep the real
  // service worker enabled and intercept its network request at context level.
  await page.context().route(GITHUB_ICON, async route => {
    const request = route.request();
    expect(request.method()).toBe('GET');
    for (const name of [
      'authorization',
      'cookie',
      'x-connection-key',
      'x-atomic-agent',
      'x-atomic-signature',
    ])
      expect((await request.allHeaders())[name]).toBeUndefined();
    state.iconRequests.push(request.url());
    await route.fulfill({
      contentType: 'image/svg+xml',
      headers: { 'access-control-allow-origin': '*' },
      body: GITHUB_ICON_SVG,
    });
  });
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
      private: false,
      open_issues_count: 7,
    },
    {
      id: 789,
      name: 'notes',
      full_name: 'michiel/notes',
      owner: { id: 321, login: 'michiel', type: 'User' },
      has_issues: true,
      private: true,
      open_issues_count: 3,
    },
    {
      id: 790,
      name: 'archived',
      full_name: 'ontola/archived',
      owner: { id: 123, login: 'ontola', type: 'Organization' },
      has_issues: false,
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

    if (url.pathname === '/plugin-catalog.json') {
      await send([]);

      return;
    }

    if (url.pathname === '/catalog/apps') {
      await send({
        version: 1,
        platforms: [
          {
            id: platform,
            name: serviceName,
            description: 'Mirror repositories and issues',
            document: '/catalog/' + platform + '.yaml',
            ...(serviceName === 'GitHub' ? { icon: GITHUB_ICON } : {}),
          },
        ],
      });

      return;
    }

    if (url.pathname === '/catalog') {
      await send([platform]);

      return;
    }

    if (
      url.pathname === '/catalog/' + platform + '.yaml' ||
      url.pathname === '/catalog/' + platform + '.selection.json'
    ) {
      expect(request.method()).toBe('GET');
      const metadataHeaders = await request.allHeaders();
      for (const name of [
        'authorization',
        'cookie',
        'x-connection-key',
        'x-atomic-agent',
        'x-atomic-signature',
      ])
        expect(metadataHeaders[name]).toBeUndefined();
      state.documentRequests.push(url.pathname);
      await send(
        url.pathname.endsWith('.yaml')
          ? (options.document ?? {
              ...CATALOG_DOCUMENT,
              info: {
                ...CATALOG_DOCUMENT.info,
                title: serviceName,
                'x-logo': { url: GITHUB_ICON },
              },
            })
          : (options.selection ?? CATALOG_SELECTION),
      );

      return;
    }

    if (url.pathname === '/connections') {
      const owner = requestSigner(request);
      const owned = [...connections.values()]
        .filter(connection => connection.owner === owner)
        .map(connection => ({
          connection_id: connection.connection_id,
          platform: connection.platform,
          owner: connection.owner,
          label: connection.label,
          delegations: connection.delegations,
        }));
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
      expect(back.searchParams.get('platform')).toBe(platform);
      expect(back.searchParams.get('integration_state')).toMatch(/^[\w-]{43}$/);
      expect(url.searchParams.get('platform')).toBe(platform);
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
        platform,
        owner,
        label: state.nextPrincipal.name,
        key: connection_key,
        delegations: [],
        principal: { ...state.nextPrincipal },
      };
      connections.set(connection_id, connection);
      state.redeemed.push(connection_id);
      await send({
        connection_id,
        platform,
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

    const [, , connectionId, requestedPlatform, ...endpoint] =
      url.pathname.split('/');
    const connection = connections.get(connectionId);
    if (!connection)
      throw new Error('Provider read without a redeemed connection');
    expect(requestedPlatform).toBe(platform);
    expect(request.method()).toBe('GET');
    expect(request.frame()).toBe(page.mainFrame());
    expect(request.headers().authorization).toBeUndefined();
    expect(requestSigner(request)).toBe(connection.owner);
    expect(request.headers()['x-connection-key']).toBe(connection.key);
    const providerPath = '/' + endpoint.join('/');
    state.providerRequests.push(providerPath);

    if (providerPath === '/user') {
      state.principalConnections.push(connectionId);

      if (connectionId === state.expiredPrincipalConnection) {
        await send(
          {
            error: 'credential_refresh_failed',
            message:
              "the provider refused to refresh this connection's token; connect again",
          },
          401,
        );

        return;
      }

      await send(connection.principal);

      return;
    }

    if (providerPath === '/orgs/ontola') {
      await send({ id: 123, login: 'ontola' });

      return;
    }

    if (providerPath === '/user/orgs') {
      state.organizationRequests++;
      expect(url.searchParams.get('per_page')).toBe('100');
      await state.organizationGate;
      await send([
        { id: 123, login: 'ontola' },
        { id: 124, login: 'reporting' },
      ]);

      return;
    }

    if (
      providerPath === '/user/repos' ||
      providerPath === '/orgs/ontola/repos'
    ) {
      state.repositoryRequests++;
      state.repositoryConnections.push(connectionId);
      const currentRepos = repos.map(repo =>
        repo.id === 456
          ? { ...repo, open_issues_count: state.repositoryIssueCount }
          : repo,
      );

      if (providerPath.startsWith('/orgs/')) {
        // Related and root reads both retain the current catalog page size.
        expect(url.searchParams.get('per_page')).toBe('100');
        expect(url.searchParams.get('type')).toBe('all');
        await send(currentRepos.filter(repo => repo.owner.id === 123));
      } else {
        expect(url.searchParams.get('per_page')).toBe('100');
        await send(currentRepos);
      }

      return;
    }

    if (providerPath === '/repositories/790/issues') {
      expect(url.searchParams.get('state')).toBe('all');
      expect(url.searchParams.get('per_page')).toBe('100');
      await send([]);

      return;
    }

    if (providerPath === '/repositories/456/issues') {
      expect(url.searchParams.get('state')).toBe('all');
      expect(url.searchParams.get('per_page')).toBe('100');
      state.issueConnections.push(connectionId);
      await state.issueGate;

      if (connectionId === state.expiredConnection) {
        await send({ error: 'credential_refresh_failed' }, 401);
      } else if (state.issueConnections.length === 1) {
        expect(url.searchParams.get('page') ?? '1').toBe('1');
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
        await send([issue(9002, 16, RETAINED_ISSUE_TITLE)]);
      } else {
        expect(url.searchParams.get('page') ?? '1').toBe('1');
        await send([issue(9001, 15, UPDATED_ISSUE_TITLE, 'closed')]);
      }

      return;
    }

    await send({ error: 'unexpected request', path: url.pathname }, 404);
  });

  return state;
}

export async function openConsent(
  page: Page,
  iframe: FrameLocator,
  buttonName: string,
) {
  await iframe.getByRole('button', { name: buttonName, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect GitHub' });
  await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Authorize GitHub' }),
  ).toBeVisible();
}

export async function finishConsent(page: Page, appName = 'GitHub · michiel') {
  await page.getByRole('link', { name: 'Authorize', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: appName, exact: true }),
  ).toBeVisible({ timeout: 45_000 });

  return getCurrentSubject(page);
}

import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import {
  expect,
  test,
  type FrameLocator,
  type Page,
  type Request,
  type Route,
} from './fixtures';
import { enableIntegrationDiscovery } from './integration-settings-utils';
import {
  before,
  clickAccountMenuItem,
  currentDriveTitle,
  FRONTEND_URL,
  getCurrentSubject,
  waitForDriveSettled,
  waitForSynced,
} from './test-utils';

const PROXY = 'https://syncables-test.example';
const PLATFORM = 'github-issues';
const GITHUB_ICON =
  'https://ontola.github.io/atomic-plugins/overlays/assets/github-mark-1.svg';
const GITHUB_ICON_SVG = readFileSync(
  resolvePath(
    __dirname,
    '../../data-browser/src/chunks/PluginRuns/fixtures/github-mark-1.svg',
  ),
  'utf8',
);
const CATALOG_DOCUMENT = JSON.parse(
  readFileSync(
    resolvePath(
      __dirname,
      '../../data-browser/src/chunks/PluginRuns/fixtures/github-syncables-catalog.json',
    ),
    'utf8',
  ),
);
const CATALOG_SELECTION = JSON.parse(
  readFileSync(
    resolvePath(
      __dirname,
      '../../data-browser/src/chunks/PluginRuns/fixtures/github-syncables-selection.json',
    ),
    'utf8',
  ),
);
const REPOSITORY = 'ontola/atomic-server';
const GITHUB_API = 'https://api.github.com';
const PUBLIC_REPOSITORY = GITHUB_API + '/repos/' + REPOSITORY;
const PUBLIC_ISSUES = GITHUB_API + '/repositories/456/issues';
const PUBLIC_ISSUE_PAGE_COUNT = 21;
const FIRST_ISSUE_TITLE = 'GitHub Issues E2E example';
const UPDATED_ISSUE_TITLE = 'Updated GitHub Issues E2E example';
const RETAINED_ISSUE_TITLE = 'Issue omitted from the next read';
const PULL_REQUEST_TITLE = 'Pull request returned by the GitHub Issues API';

function publicIssueUrl(page: number): string {
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
}

interface MockState {
  redeemed: string[];
  issueConnections: string[];
  repositoryRequests: number;
  organizationRequests: number;
  providerRequests: string[];
  documentRequests: string[];
  iconRequests: string[];
  expiredConnection?: string;
  expiredPrincipalConnection?: string;
  principalConnections: string[];
  issueGate?: Promise<void>;
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
async function mockIntegrationProxy(
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
        label: 'michiel',
        key: connection_key,
        delegations: [],
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

      await send({ id: 321, login: 'michiel', name: 'michiel', type: 'User' });

      return;
    }

    if (providerPath === '/orgs/ontola') {
      await send({ id: 123, login: 'ontola' });

      return;
    }

    if (providerPath === '/user/orgs') {
      state.organizationRequests++;
      expect(url.searchParams.get('per_page')).toBe('100');
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
      expect(url.searchParams.get('per_page')).toBe('100');
      state.repositoryRequests++;
      if (providerPath.startsWith('/orgs/')) {
        expect(url.searchParams.get('type')).toBe('all');
        await send(repos.filter(repo => repo.owner.id === 123));
      } else await send(repos);

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

async function openConsent(
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

async function sourceState(page: Page, subject: string) {
  return page.evaluate(async tableSubject => {
    const store = window.store;
    const base = 'https://atomicdata.dev/properties/';

    const property = (name: string) => {
      const found = [...store.resources.values()].find(
        resource => resource.get(base + 'shortname') === name,
      );
      if (!found) throw new Error('Missing fixture property ' + name);

      return found.subject;
    };

    const source = property('syncable-source-key');
    const nodeKind = property('syncable-node-kind');
    const config = property('syncable-source-config');
    const table = await store.getResource(tableSubject);
    const rowClass = table.get(base + 'classtype');
    const rows = [...store.resources.values()].filter(
      resource =>
        resource.get(base + 'parent') === tableSubject &&
        resource.get(nodeKind) === 'record' &&
        typeof resource.get(source) === 'string' &&
        typeof rowClass === 'string' &&
        resource.getSubjects(base + 'isA').includes(rowClass),
    );

    return {
      subject: table.subject,
      localId: table.get(base + 'localId'),
      key: table.get(source) as string | undefined,
      config: table.get(config) as
        | { principal?: { kind: string }; collection?: { collection: string } }
        | undefined,
      rows: await Promise.all(
        rows.map(async row => {
          const saved = row.get(config) as
            | { managedProperties?: string[] }
            | undefined;

          return {
            subject: row.subject,
            name: row.get(base + 'name'),
            localId: row.get(base + 'localId'),
            key: row.get(source) as string | undefined,
            note: row.get(base + 'description'),
            managed: await Promise.all(
              (saved?.managedProperties ?? []).map(async field => {
                const definition = await store.getResource(field);

                return {
                  name: definition.get(base + 'shortname'),
                  datatype: definition.get(base + 'datatype'),
                  value: row.get(field),
                };
              }),
            ),
          };
        }),
      ),
    };
  }, subject);
}

async function sourceSubject(page: Page, kind: string, collection?: string) {
  return page.evaluate(
    ({ kind: wanted, collection: name }) => {
      const store = window.store;
      const base = 'https://atomicdata.dev/properties/';
      const fields = Object.fromEntries(
        [...store.resources.values()].map(resource => [
          resource.get(base + 'shortname'),
          resource.subject,
        ]),
      );
      const found = [...store.resources.values()].find(resource => {
        if (resource.get(fields['syncable-node-kind']) !== wanted) return false;
        const config = resource.get(fields['syncable-source-config']) as
          | {
              collection?: { collection: string };
              navigation?: { collection: string };
              principal?: { kind: string };
            }
          | undefined;

        return name
          ? (config?.collection?.collection ??
              config?.navigation?.collection) === name
          : config?.principal?.kind === 'authenticated';
      });
      if (!found)
        throw new Error(
          'Missing saved source ' + wanted + '/' + (name ?? 'principal'),
        );

      return found.subject;
    },
    { kind, collection },
  );
}

async function selectView(page: Page, name: string) {
  const tab = page.getByRole('tab', { name, exact: true });
  await expect(tab).toBeVisible({ timeout: 30_000 });
  if ((await tab.getAttribute('aria-selected')) !== 'true') await tab.click();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
}

async function browse(page: Page) {
  await selectView(page, 'Collection');
  await expect(page.locator('iframe[title="App"]:visible')).toHaveCount(0);

  return page.getByRole('main').getByRole('table');
}

async function openRow(page: Page, text: string) {
  const directory = await browse(page);
  const previous = await getCurrentSubject(page);
  await directory
    .getByRole('row')
    .filter({ hasText: text })
    .getByRole('button', { name: 'Open', exact: true })
    .click();
  await expect.poll(() => getCurrentSubject(page)).not.toBe(previous);
}

async function expandSidebarNode(page: Page, name: string) {
  const header = page
    .getByTestId('sidebar')
    .locator('[data-sidebar-id]')
    .filter({
      has: page.getByRole('button', { name, exact: true }),
    });
  const expand = header.getByRole('button', {
    name: 'Expand folder',
    exact: true,
  });
  await expect(
    header.getByRole('button', { name: /^(Expand|Collapse) folder$/ }),
  ).toHaveCount(1);
  if (await expand.count()) await expand.click();
  await expect(
    header.getByRole('button', { name: 'Collapse folder', exact: true }),
  ).toBeVisible();
}

async function sync(page: Page) {
  await selectView(page, 'Sync');
  const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
  await expect(
    iframe.getByRole('button', { name: 'Sync now', exact: true }),
  ).toBeVisible({ timeout: 30_000 });
  await iframe.getByRole('button', { name: 'Sync now', exact: true }).click();
  await expect(
    iframe.getByRole('button', { name: 'Sync now', exact: true }),
  ).toBeEnabled({ timeout: 45_000 });
  await expect(iframe.getByRole('alert')).toHaveCount(0);

  return iframe;
}

async function legacyPublicMirror(page: Page, parent: string) {
  return page.evaluate(
    async ({ parent: targetParent, proxy }) => {
      const store = window.store;
      const base = 'https://atomicdata.dev/properties/';
      const terms = Object.fromEntries(
        [...store.resources.values()].map(resource => [
          resource.get(base + 'shortname'),
          resource.subject,
        ]),
      );
      const oldKey = JSON.stringify([
        proxy,
        'github-issues',
        'public-mirror',
        'github-public-repo:456',
        'issues',
      ]);
      const localId = 'syncables:node:' + encodeURIComponent(oldKey);
      const table = await store.newResource({
        parent: targetParent,
        isA: ['https://atomicdata.dev/classes/Table'],
        propVals: {
          [base + 'name']: 'Issues',
          [base + 'localId']: localId,
          [base + 'classtype']: terms['syncable-record'],
          [terms['syncable-source-key']]: oldKey,
          [terms['syncable-node-kind']]: 'public-mirror',
          [terms['syncable-source-config']]: {
            repoId: '456',
            ownerId: '123',
            ownerLogin: 'ontola',
            repoName: 'atomic-server',
          },
        },
      });
      await table.save();
      const row = await store.newResource({
        parent: table.subject,
        isA: [terms['syncable-record']],
        propVals: {
          [base + 'name']: 'Legacy imported issue',
          [base + 'localId']: 'syncables:github-issue:9001',
          [base + 'description']: 'Keep this user note',
          [terms['syncable-issue-number']]: 15,
        },
      });
      await row.save();
      const driveSubject = store.getDrive();
      if (!driveSubject) throw new Error('The fixture has no current drive');
      const drive = await store.getResource(driveSubject);
      const previous = drive.get(terms['syncable-resource-index']) as
        | Record<string, string>
        | undefined;
      drive.set(terms['syncable-resource-index'], {
        ...previous,
        [oldKey]: table.subject,
      });
      await drive.save();

      return { table: table.subject, row: row.subject, localId, oldKey };
    },
    { parent, proxy: PROXY },
  );
}

async function publicForm(page: Page, collection = 'repositoryIssues') {
  await selectView(page, 'Sync');
  const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
  await expect(iframe.getByLabel('Collection', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await iframe
    .getByLabel('Collection', { exact: true })
    .selectOption(collection);

  return iframe;
}

test.describe('catalog-driven built-in Syncables', () => {
  test('retains a saved principal and safely reconnects an expired orphan connection from the App', async ({
    page,
    browserDiagnostics,
  }, testInfo) => {
    test.setTimeout(150_000);
    const requests = await mockIntegrationProxy(page);
    await before({ page }, testInfo);
    await enableIntegrationDiscovery(page);
    await clickAccountMenuItem(page, 'Apps');
    await page
      .locator(`[data-proxy-platform="${PLATFORM}"]`)
      .getByRole('button', { name: 'Add GitHub to drive' })
      .click();
    const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
    await expect(
      iframe.getByRole('heading', { name: 'Connected principals' }),
    ).toBeVisible({ timeout: 45_000 });
    const appUrl = page.url();
    const appSubject = await getCurrentSubject(page);
    await openConsent(page, iframe, 'Connect account');
    await page.getByRole('link', { name: 'Authorize', exact: true }).click();
    await expect(page).toHaveURL(appUrl, { timeout: 45_000 });
    await expect(
      iframe.getByRole('button', { name: 'michiel', exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    const principalSubject = await sourceSubject(page, 'principal');
    const saved = await sourceState(page, principalSubject);
    const oldSlot = requests.redeemed[0];

    // A newer slot verifies the same typed principal. The older owned slot is
    // retained by the proxy and can expire independently of the saved account.
    await openConsent(page, iframe, 'Connect account');
    await page.getByRole('link', { name: 'Authorize', exact: true }).click();
    await expect(page).toHaveURL(appUrl, { timeout: 45_000 });
    await expect.poll(() => requests.redeemed.length).toBe(2);
    await expect(
      iframe.getByRole('button', { name: 'michiel', exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    await expect
      .poll(async () => (await sourceState(page, principalSubject)).config)
      .toMatchObject({ connectionId: requests.redeemed[1] });
    await waitForSynced(page);
    await waitForDriveSettled(page);
    browserDiagnostics.expect(
      'error',
      /Failed to load resource:.*401/,
      'The deliberately expired orphan slot rejects its principal read.',
      1,
      /^https:\/\/syncables-test\.example\/proxy\//,
      { optional: true },
    );
    requests.expiredPrincipalConnection = oldSlot;
    await page.reload();
    const notice = iframe
      .getByRole('alert')
      .filter({ hasText: 'This connection has expired.' });
    await expect(notice).toBeVisible({ timeout: 45_000 });
    await expect(
      notice.getByRole('button', { name: 'Reconnect connection', exact: true }),
    ).toBeVisible();
    await expect(notice).toContainText(
      'Saved accounts and collections are retained.',
    );
    await expect(
      iframe.getByRole('button', { name: 'michiel', exact: true }),
    ).toHaveCount(1);
    await expect(iframe.locator('body')).not.toContainText(
      'No accounts connected',
    );
    await expect(iframe.locator('body')).not.toContainText(
      'Authenticated principal returned HTTP 401',
    );
    expect((await sourceState(page, principalSubject)).key).toBe(saved.key);
    expect((await sourceState(page, principalSubject)).localId).toBe(
      saved.localId,
    );
    expect(requests.organizationRequests).toBe(0);
    expect(requests.repositoryRequests).toBe(0);
    await testInfo.attach('expired-orphan-connection-desktop', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(
      notice.getByRole('button', { name: 'Reconnect connection', exact: true }),
    ).toBeVisible();
    await testInfo.attach('expired-orphan-connection-mobile', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await page.setViewportSize({ width: 1200, height: 800 });

    await openConsent(page, iframe, 'Reconnect connection');
    await page.getByRole('link', { name: 'Authorize', exact: true }).click();
    await expect(page).toHaveURL(appUrl, { timeout: 45_000 });
    await expect(
      iframe.getByRole('button', { name: 'michiel', exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    await expect(iframe.getByRole('alert')).toHaveCount(0);
    expect(requests.redeemed).toHaveLength(3);
    // Recovery replaces the credential behind the original logical slot.
    const activeId = await page.evaluate(
      ({ origin, slot }) => {
        const prefix = 'atomic-proxy-keyed-v1:';
        const key = Object.keys(localStorage).find(candidate => {
          if (!candidate.startsWith(prefix)) return false;
          const parts = JSON.parse(candidate.slice(prefix.length));

          return parts[0] === origin && parts[2] === slot;
        });

        return key
          ? JSON.parse(localStorage.getItem(key)!).activeId
          : undefined;
      },
      { origin: PROXY, slot: oldSlot },
    );
    expect(activeId).toBe(requests.redeemed[2]);
    expect(requests.principalConnections).toContain(activeId);
    expect(await sourceSubject(page, 'principal')).toBe(principalSubject);
    const restored = await sourceState(page, principalSubject);
    expect(restored.key).toBe(saved.key);
    expect(restored.localId).toBe(saved.localId);
    expect(restored.config).toMatchObject({ connectionId: oldSlot });
    await iframe.getByRole('button', { name: 'michiel', exact: true }).click();
    await expect.poll(() => getCurrentSubject(page)).not.toBe(appSubject);
    expect(await getCurrentSubject(page)).toBe(principalSubject);
    const directory = await browse(page);
    await expect(
      directory.getByText('Organizations', { exact: true }),
    ).toBeVisible();
    await expect(
      directory.getByText('Repositories', { exact: true }),
    ).toBeVisible();
    expect(requests.organizationRequests).toBe(0);
    expect(requests.repositoryRequests).toBe(0);
  });

  test('connects a principal directly and syncs only selected declared collection instances', async ({
    page,
    browserDiagnostics,
  }, testInfo) => {
    test.setTimeout(240_000);
    const requests = await mockIntegrationProxy(page);
    await before({ page }, testInfo);
    const driveUrl = page.url();
    await enableIntegrationDiscovery(page);
    await expect(page).toHaveURL(driveUrl);
    await expect(currentDriveTitle(page)).toBeVisible();
    await clickAccountMenuItem(page, 'Apps');
    const card = page.locator(`[data-proxy-platform="${PLATFORM}"]`);
    await card.getByRole('button', { name: 'Add GitHub to drive' }).click();
    const frame = page.locator('iframe[title="App"]:visible');
    const iframe = frame.contentFrame();
    await expect(
      iframe.getByRole('heading', { name: 'Connected principals' }),
    ).toBeVisible({ timeout: 45_000 });
    const appUrl = page.url();
    const appSubject = await getCurrentSubject(page);
    await expect(frame).toHaveAttribute('sandbox', /\ballow-scripts\b/);
    await expect(frame).not.toHaveAttribute('sandbox', /\ballow-same-origin\b/);
    expect(await iframe.locator('html').evaluate(() => window.origin)).toBe(
      'null',
    );
    expect(requests.providerRequests).toEqual([]);
    expect(requests.iconRequests).toEqual([GITHUB_ICON]);
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar.getByText('Accounts', { exact: true })).toHaveCount(0);
    await testInfo.attach('github-app-direct-principals', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });

    await openConsent(page, iframe, 'Connect account');
    await page.getByRole('link', { name: 'Decline', exact: true }).click();
    await expect(page).toHaveURL(appUrl);
    expect(requests.redeemed).toEqual([]);
    await openConsent(page, iframe, 'Connect account');
    await page.getByRole('link', { name: 'Authorize', exact: true }).click();
    await expect(page).toHaveURL(appUrl, { timeout: 45_000 });
    await expect(
      iframe.getByRole('button', { name: 'michiel', exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    expect(requests.organizationRequests).toBe(0);
    expect(requests.repositoryRequests).toBe(0);
    expect(requests.providerRequests.every(path => path === '/user')).toBe(
      true,
    );
    await iframe.getByRole('button', { name: 'michiel', exact: true }).click();
    await expect.poll(() => getCurrentSubject(page)).not.toBe(appSubject);
    const principalSubject = await getCurrentSubject(page);
    expect(principalSubject).not.toBe(appSubject);
    // Migration preserves this old localId; it must still form a navigable principal Table.
    await page.evaluate(
      async ({ subject, proxy, connection }) => {
        const principal = await window.store.getResource(subject);
        await principal.set(
          'https://atomicdata.dev/properties/localId',
          'syncables:node:' +
            encodeURIComponent(
              JSON.stringify([
                proxy,
                'github-issues',
                'account',
                connection,
                '',
              ]),
            ),
        );
        await principal.save();
      },
      {
        subject: principalSubject,
        proxy: PROXY,
        connection: requests.redeemed[0],
      },
    );
    const principalUrl = page.url();
    const principalTable = await browse(page);
    await expect(
      principalTable.getByText('Organizations', { exact: true }),
    ).toBeVisible();
    await expect(
      principalTable.getByText('Repositories', { exact: true }),
    ).toBeVisible();
    await expect(sidebar.getByText('Accounts', { exact: true })).toHaveCount(0);
    const setupReads = requests.providerRequests.length;
    const setupDocuments = requests.documentRequests.length;
    await openRow(page, 'Organizations');
    const organizationsSubject = await getCurrentSubject(page);
    const organizationsUrl = page.url();
    await browse(page);
    expect(requests.providerRequests).toHaveLength(setupReads);
    expect(requests.documentRequests).toHaveLength(setupDocuments);
    await sync(page);
    expect(requests.organizationRequests).toBe(1);
    expect(requests.repositoryRequests).toBe(0);
    expect(requests.issueConnections).toEqual([]);
    const directory = await browse(page);
    await expect(directory.getByText('ontola', { exact: true })).toBeVisible();
    await expect(
      directory.getByText('reporting', { exact: true }),
    ).toBeVisible();
    await expect(directory.getByText('michiel', { exact: true })).toHaveCount(
      0,
    );
    await expect(
      directory.getByRole('button', { name: /Sync|Refresh/ }),
    ).toHaveCount(0);
    expect((await sourceState(page, organizationsSubject)).rows).toHaveLength(
      2,
    );
    const nativeReads = requests.providerRequests.length;
    const nativeDocuments = requests.documentRequests.length;
    let attemptedNativeReads = 0;

    const offline = async (route: Route) => {
      attemptedNativeReads++;
      await route.abort('failed');
    };

    await page.route(PROXY + '/proxy/**', offline);
    await selectView(page, 'Table');
    await browse(page);
    await openRow(page, 'ontola');
    const repositoriesSubject = await getCurrentSubject(page);
    const repositoriesUrl = page.url();
    await browse(page);
    expect((await sourceState(page, repositoriesSubject)).rows).toHaveLength(0);
    expect(attemptedNativeReads).toBe(0);
    expect(requests.providerRequests).toHaveLength(nativeReads);
    expect(requests.documentRequests).toHaveLength(nativeDocuments);
    await page.unroute(PROXY + '/proxy/**', offline);
    await sync(page);
    expect(requests.providerRequests).toContain('/orgs/ontola');
    expect(requests.providerRequests).toContain('/orgs/ontola/repos');
    expect(requests.providerRequests).not.toContain('/user/repos');
    expect(requests.repositoryRequests).toBe(1);
    const repos = await browse(page);
    await expect(
      repos.getByText('atomic-server', { exact: true }),
    ).toBeVisible();
    await expect(repos.getByText('notes', { exact: true })).toHaveCount(0);
    await expect(repos.getByText('Public', { exact: true })).toBeVisible();
    const repoState = await sourceState(page, repositoriesSubject);
    const firstRepo = repoState.rows.find(row => row.name === 'atomic-server')!;
    expect(firstRepo.managed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/boolean',
          value: false,
        }),
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/integer',
          value: 7,
        }),
      ]),
    );
    expect(requests.issueConnections).toHaveLength(0);
    const nestedNativeReads = requests.providerRequests.length;
    await openRow(page, 'atomic-server');
    const mirrorSubject = await getCurrentSubject(page);
    await browse(page);
    expect(requests.providerRequests).toHaveLength(nestedNativeReads);
    expect(requests.issueConnections).toHaveLength(0);
    await selectView(page, 'Sync');
    const syncNow = iframe.getByRole('button', {
      name: 'Sync now',
      exact: true,
    });
    await expect(syncNow).toBeVisible({ timeout: 30_000 });
    let release: (() => void) | undefined;
    requests.issueGate = new Promise(resolve => {
      release = resolve;
    });
    await syncNow.click();
    await expect.poll(() => requests.issueConnections.length).toBe(1);
    await sidebar.getByText('Organizations', { exact: true }).click();
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      organizationsSubject,
    );
    await browse(page);
    await expect(directory.getByText('ontola', { exact: true })).toBeVisible();
    await expect(frame).toHaveCount(0);
    await expect(page.locator('iframe[title="App"]')).toHaveCount(1);
    await testInfo.attach('github-native-browse-during-sync', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    // Navigating to Organizations collapses deeper ancestors. Reopen the real
    // tree with its carets before selecting the still-running mirror.
    const backgroundReads = requests.providerRequests.length;
    const backgroundDocuments = requests.documentRequests.length;
    await expandSidebarNode(page, 'ontola');
    await expandSidebarNode(page, 'Repositories');
    await expandSidebarNode(page, 'atomic-server');
    await sidebar
      .getByRole('button', { name: 'Issues and pull requests', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute(
      'about',
      mirrorSubject,
    );
    expect(requests.providerRequests).toHaveLength(backgroundReads);
    expect(requests.documentRequests).toHaveLength(backgroundDocuments);
    await selectView(page, 'Sync');
    await expect(
      iframe.getByRole('button', { name: 'Syncing', exact: true }),
    ).toBeDisabled();
    release?.();
    requests.issueGate = undefined;
    await expect(
      iframe.getByText('3 stored entries', { exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    await expect(syncNow).toBeEnabled();
    await browse(page);
    await expect(
      sidebar.getByRole('button', {
        name: 'Issues and pull requests',
        exact: true,
      }),
    ).toBeVisible();
    await testInfo.attach('github-expanded-principal-collections-desktop', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    const initial = await sourceState(page, mirrorSubject);
    expect(initial.rows).toHaveLength(3);
    // The API collection also declares PR-shaped records; the generic engine mirrors them faithfully.
    expect(
      initial.rows.find(row => JSON.parse(row.key!).remoteId === 17)?.name,
    ).toBe(PULL_REQUEST_TITLE);
    expect(
      initial.rows.find(row => JSON.parse(row.key!).remoteId === 17)?.managed,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/json',
          value: {},
        }),
      ]),
    );
    const imported = initial.rows.find(
      row => JSON.parse(row.key!).remoteId === 15,
    )!;
    expect(imported.name).toBe(FIRST_ISSUE_TITLE);
    expect(imported.managed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/integer',
          value: 15,
        }),
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/timestamp',
          value: Date.parse('2026-11-13T10:00:00Z'),
        }),
      ]),
    );
    await sync(page);
    await expect(
      iframe.getByText('0 added · 1 changed · 0 unchanged', { exact: true }),
    ).toBeVisible();
    await browse(page);
    const updated = await sourceState(page, mirrorSubject);
    expect(updated.rows).toHaveLength(3);
    expect(
      updated.rows.find(row => row.subject === imported.subject)?.name,
    ).toBe(UPDATED_ISSUE_TITLE);
    expect(
      updated.rows.find(row => row.subject === imported.subject)?.localId,
    ).toBe(imported.localId);
    await sync(page);
    await expect(
      iframe.getByText('0 added · 0 changed · 1 unchanged', { exact: true }),
    ).toBeVisible();
    await iframe.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(
      iframe.getByRole('button', { name: 'Resume', exact: true }),
    ).toBeVisible();
    await expect(syncNow).toBeDisabled();
    await page.reload();
    await expect(
      iframe.getByRole('button', { name: 'Resume', exact: true }),
    ).toBeVisible({ timeout: 30_000 });
    await expect(syncNow).toBeDisabled();
    await iframe.getByRole('button', { name: 'Resume', exact: true }).click();
    const connection = requests.redeemed[0];
    browserDiagnostics.expect(
      'error',
      /Failed to load resource:.*401/,
      'The deliberately expired fixture credential is rejected.',
      1,
      /^https:\/\/syncables-test\.example\/proxy\//,
      { optional: true },
    );
    requests.expiredConnection = connection;
    await syncNow.click();
    await expect(iframe.getByRole('alert')).toContainText('401');
    const reconnectUrl = page.url();
    await openConsent(page, iframe, 'Reconnect');
    await page.getByRole('link', { name: 'Authorize', exact: true }).click();
    await expect(page).toHaveURL(reconnectUrl, { timeout: 45_000 });
    await sync(page);
    await expect(iframe.getByRole('alert')).toHaveCount(0);
    expect(requests.redeemed).toHaveLength(2);
    expect(requests.issueConnections.at(-1)).toBe(requests.redeemed[1]);
    expect(
      (await sourceState(page, mirrorSubject)).rows
        .map(row => row.subject)
        .sort(),
    ).toEqual(initial.rows.map(row => row.subject).sort());

    const completedRows = (await sourceState(page, mirrorSubject)).rows;
    const pendingReads = requests.issueConnections.length;
    requests.issueGate = new Promise(resolve => {
      release = resolve;
    });
    await syncNow.click();
    await expect
      .poll(() => requests.issueConnections.length)
      .toBe(pendingReads + 1);
    await iframe.getByRole('button', { name: 'Pause', exact: true }).click();
    await expect(
      iframe.getByRole('button', { name: 'Resume', exact: true }),
    ).toBeVisible();
    await expect(syncNow).toBeDisabled();
    release?.();
    requests.issueGate = undefined;
    await browse(page);
    expect(
      (await sourceState(page, mirrorSubject)).rows
        .map(row => row.subject)
        .sort(),
    ).toEqual(completedRows.map(row => row.subject).sort());

    // Native cached views remain readable offline and do not mount a new iframe.
    await browse(page);
    const offlineReads = requests.providerRequests.length;
    const offlineDocuments = requests.documentRequests.length;
    await page.route(PROXY + '/proxy/**', offline);
    await page.goto(repositoriesUrl);
    await browse(page);
    await openRow(page, 'atomic-server');
    await browse(page);
    expect(requests.providerRequests).toHaveLength(offlineReads);
    expect(requests.documentRequests).toHaveLength(offlineDocuments);
    expect(attemptedNativeReads).toBe(0);
    await expect(
      page.getByRole('main').getByText(UPDATED_ISSUE_TITLE, { exact: true }),
    ).toBeVisible();
    await page.goto(organizationsUrl);
    await browse(page);
    const viewport = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    if (
      (await sidebar.isVisible()) &&
      (await sidebar.evaluate(node => getComputedStyle(node).opacity !== '0'))
    )
      await page.getByRole('button', { name: 'Show / hide sidebar' }).click();
    const open = directory
      .getByRole('button', { name: 'Open', exact: true })
      .first();
    await expect(open).toBeInViewport();
    const bounds = await open.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await testInfo.attach('generic-organizations-mobile', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
    await page.setViewportSize(viewport);
    await page.unroute(PROXY + '/proxy/**', offline);
    await page.goto(principalUrl);
    await browse(page);
    expect(await sourceSubject(page, 'principal')).toBe(principalSubject);
  });

  test('resolves catalog Public inputs into a canonical mirror and migrates saved source aliases', async ({
    page,
  }, testInfo) => {
    test.setTimeout(240_000);
    const requests = await mockIntegrationProxy(page);
    const metadataRequests: string[] = [];
    const publicIssuePages: string[] = [];
    await page.route(GITHUB_API + '/**', async route => {
      const request = route.request();
      expect(request.method()).toBe('GET');
      expect(request.frame()).toBe(page.mainFrame());
      const headers = await request.allHeaders();
      for (const name of [
        'authorization',
        'cookie',
        'x-connection-key',
        'x-atomic-agent',
      ])
        expect(headers[name]).toBeUndefined();

      if (request.url() === PUBLIC_REPOSITORY) {
        metadataRequests.push(request.url());
        await route.fulfill({
          headers: { 'access-control-allow-origin': '*' },
          json: {
            id: 456,
            name: 'atomic-server',
            full_name: REPOSITORY,
            owner: { id: 123, login: 'ontola', type: 'Organization' },
            private: false,
            has_issues: true,
          },
        });

        return;
      }

      const pageNumber = publicIssuePages.length + 1;
      const requested = new URL(request.url());
      const expected = new URL(publicIssueUrl(pageNumber));
      if (pageNumber === 1 && !requested.searchParams.has('page'))
        requested.searchParams.set('page', '1');
      requested.searchParams.sort();
      expected.searchParams.sort();
      expect(requested.href).toBe(expected.href);
      expect(pageNumber).toBeLessThanOrEqual(PUBLIC_ISSUE_PAGE_COUNT);
      publicIssuePages.push(request.url());
      await route.fulfill({
        headers: {
          'access-control-allow-origin': '*',
          'access-control-expose-headers': 'link',
          ...(pageNumber < PUBLIC_ISSUE_PAGE_COUNT
            ? { link: `<${publicIssueUrl(pageNumber + 1)}>; rel="next"` }
            : {}),
        },
        json:
          pageNumber === 1
            ? [issue(9001, 15, FIRST_ISSUE_TITLE)]
            : pageNumber === PUBLIC_ISSUE_PAGE_COUNT
              ? [issue(9002, 16, RETAINED_ISSUE_TITLE)]
              : [],
      });
    });
    await before({ page }, testInfo);
    await enableIntegrationDiscovery(page);
    await clickAccountMenuItem(page, 'Apps');
    await page.getByRole('button', { name: 'Add GitHub to drive' }).click();
    const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
    await expect(
      iframe.getByRole('button', { name: 'Public', exact: true }),
    ).toHaveCount(1, { timeout: 45_000 });
    const appBeforePublic = await getCurrentSubject(page);
    await iframe.getByRole('button', { name: 'Public', exact: true }).click();
    await expect.poll(() => getCurrentSubject(page)).not.toBe(appBeforePublic);
    await browse(page);
    const publicSubject = await getCurrentSubject(page);
    const publicUrl = page.url();
    const legacy = await legacyPublicMirror(page, publicSubject);
    await waitForSynced(page);
    await waitForDriveSettled(page);
    const form = await publicForm(page);
    await form
      .getByLabel('Source', { exact: true })
      .selectOption('/repos/{owner}/{repo}');
    await form.getByLabel('Repository owner', { exact: true }).fill('ontola');
    await form
      .getByLabel('Repository name', { exact: true })
      .fill('atomic-server');
    expect(metadataRequests).toEqual([]);
    expect(publicIssuePages).toEqual([]);
    await testInfo.attach('catalog-public-entrypoint', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    await form
      .getByRole('button', { name: 'Open collection', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute('about', legacy.table);
    await browse(page);
    expect(metadataRequests).toEqual([PUBLIC_REPOSITORY]);
    expect(publicIssuePages).toEqual([]);
    const adopted = await sourceState(page, legacy.table);
    expect(adopted.localId).toBe(legacy.localId);
    expect(JSON.parse(adopted.key!)).toMatchObject({
      version: 2,
      principal: { kind: 'public' },
      collection: {
        name: 'repositoryIssues',
        context: { repository_id: '456' },
      },
    });
    expect(adopted.config?.principal?.kind).toBe('public');
    await sync(page);
    await expect(
      iframe.getByText('1 added · 1 changed · 0 unchanged', { exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    await browse(page);
    expect(publicIssuePages).toHaveLength(PUBLIC_ISSUE_PAGE_COUNT);
    const imported = await sourceState(page, legacy.table);
    expect(imported.rows).toHaveLength(2);
    expect(imported.rows.find(row => row.subject === legacy.row)).toMatchObject(
      {
        name: FIRST_ISSUE_TITLE,
        localId: 'syncables:github-issue:9001',
        note: 'Keep this user note',
      },
    );
    expect(
      await page.evaluate(({ oldKey, table }) => {
        const store = window.store;
        const property = [...store.resources.values()].find(
          resource =>
            resource.get('https://atomicdata.dev/properties/shortname') ===
            'syncable-resource-index',
        )!.subject;
        const index = store
          .getResourceLoading(store.getDrive())
          .get(property) as Record<string, string>;

        return index[oldKey] === table;
      }, legacy),
    ).toBe(true);
    const sidebar = page.getByTestId('sidebar');
    await expect(sidebar.getByText('Accounts', { exact: true })).toHaveCount(0);
    await expect(sidebar.getByText('ontola', { exact: true })).toHaveCount(0);
    await expect(
      sidebar.getByText(FIRST_ISSUE_TITLE, { exact: true }),
    ).toHaveCount(0);
    await testInfo.attach('public-canonical-issues-migrated', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
    const nativeReads = metadataRequests.length + publicIssuePages.length;
    const nativeDocuments = requests.documentRequests.length;
    await page.goto(publicUrl);
    await openRow(page, 'Issues');
    await browse(page);
    expect(await getCurrentSubject(page)).toBe(legacy.table);
    expect(metadataRequests.length + publicIssuePages.length).toBe(nativeReads);
    expect(requests.documentRequests).toHaveLength(nativeDocuments);
    await page.goto(publicUrl);
    const repeat = await publicForm(page);
    await repeat
      .getByLabel('Source', { exact: true })
      .selectOption('/repos/{owner}/{repo}');
    await repeat.getByLabel('Repository owner', { exact: true }).fill('ontola');
    await repeat
      .getByLabel('Repository name', { exact: true })
      .fill('atomic-server');
    await repeat
      .getByRole('button', { name: 'Open collection', exact: true })
      .click();
    await expect(page.getByRole('main')).toHaveAttribute('about', legacy.table);
    expect(publicIssuePages).toHaveLength(PUBLIC_ISSUE_PAGE_COUNT);
    expect(metadataRequests).toHaveLength(2);
    expect(requests.redeemed).toEqual([]);
    expect(requests.issueConnections).toEqual([]);
    expect(requests.providerRequests).toEqual([]);
    await page.goto(publicUrl);
    const mobile = await publicForm(page);
    await page.setViewportSize({ width: 390, height: 844 });
    if (
      (await sidebar.isVisible()) &&
      (await sidebar.evaluate(node => getComputedStyle(node).opacity !== '0'))
    )
      await page.getByRole('button', { name: 'Show / hide sidebar' }).click();
    await expect(
      mobile.getByRole('button', { name: 'Open collection', exact: true }),
    ).toBeInViewport();
    await testInfo.attach('catalog-public-input-mobile', {
      body: await page.screenshot({ animations: 'disabled' }),
      contentType: 'image/png',
    });
  });

  test('installs an unrelated catalog and mirrors its typed records through the same native views', async ({
    page,
  }, testInfo) => {
    test.setTimeout(180_000);
    const upstream = 'https://notes-api.example/v3';
    const document = {
      openapi: '3.0.3',
      info: { title: 'Notebook', version: '1' },
      servers: [{ url: upstream }],
      components: {
        crudResources: {
          entryAddress: {
            identity: {
              urlTemplate: '/by-name/{workspace}',
              bindings: { workspace: { field: 'name' } },
            },
          },
          entry: {
            schema: {
              type: 'object',
              title: 'Entries',
              required: ['id', 'name'],
              properties: {
                id: { type: 'string' },
                name: { type: 'string', title: 'Entry' },
                updated_at: {
                  type: 'string',
                  format: 'date-time',
                  title: 'Updated',
                },
                active: { type: 'boolean', title: 'Active' },
              },
            },
            identity: {
              urlTemplate: '/spaces/{space_id}/entries/{entry_id}',
              bindings: { entry_id: { field: 'id' } },
            },
            collections: {
              entries: { urlTemplate: '/spaces/{space_id}/entries' },
            },
          },
        },
        paginationSchemes: {
          pages: {
            type: 'nextLink',
            request: {},
            response: { headers: { Link: { role: 'nextLink' } } },
          },
        },
      },
      paths: {
        '/by-name/{workspace}': {
          get: {
            operationId: 'namedSpace',
            security: [],
            parameters: [
              {
                name: 'workspace',
                in: 'path',
                required: true,
                schema: { type: 'string', title: 'Workspace name' },
              },
            ],
            'x-crud': { action: 'read', resource: 'entryAddress' },
            responses: {
              '200': {
                description: 'Space',
                links: {
                  entries: {
                    operationId: 'listEntries',
                    parameters: { space_id: '$response.body#/id' },
                  },
                },
              },
            },
          },
        },
        '/spaces/{space_id}/entries': {
          get: {
            operationId: 'listEntries',
            security: [],
            parameters: [
              {
                name: 'space_id',
                in: 'path',
                required: true,
                schema: { type: 'integer', title: 'Workspace ID' },
              },
            ],
            'x-crud': {
              action: 'list',
              resource: 'entry',
              collection: 'entries',
            },
            'x-pagination': [{ scheme: 'pages' }],
            responses: {
              '200': {
                description: 'Entries',
                content: {
                  'application/json': {
                    schema: { type: 'array', items: { type: 'object' } },
                  },
                },
              },
            },
          },
        },
      },
    };
    const requests = await mockIntegrationProxy(page, {
      platform: 'notebook',
      name: 'Notebook',
      document,
      selection: { query_overrides: [] },
    });
    const reads: string[] = [];
    await page.route(upstream + '/**', async route => {
      const request = route.request();
      const headers = await request.allHeaders();
      for (const name of [
        'authorization',
        'cookie',
        'x-connection-key',
        'x-atomic-agent',
      ])
        expect(headers[name]).toBeUndefined();
      reads.push(request.url());
      await route.fulfill({
        headers: { 'access-control-allow-origin': '*' },
        json: request.url().endsWith('/by-name/research')
          ? { id: 44 }
          : [
              {
                id: 'entry-7',
                name: 'An unrelated typed record',
                updated_at: '2026-11-19T09:00:00Z',
                active: true,
              },
            ],
      });
    });
    await before({ page }, testInfo);
    await enableIntegrationDiscovery(page);
    await clickAccountMenuItem(page, 'Apps');
    await page.getByRole('button', { name: 'Add Notebook to drive' }).click();
    const iframe = page.locator('iframe[title="App"]:visible').contentFrame();
    await expect(
      iframe.getByRole('button', { name: 'Public', exact: true }),
    ).toBeVisible({ timeout: 45_000 });
    const appBeforePublic = await getCurrentSubject(page);
    await iframe.getByRole('button', { name: 'Public', exact: true }).click();
    await expect.poll(() => getCurrentSubject(page)).not.toBe(appBeforePublic);
    const form = await publicForm(page, 'entries');
    await form.getByLabel('Workspace name', { exact: true }).fill('research');
    expect(reads).toEqual([]);
    await form
      .getByRole('button', { name: 'Open collection', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Entries', exact: true }),
    ).toBeVisible();
    const subject = await getCurrentSubject(page);
    await browse(page);
    expect(reads).toEqual([upstream + '/by-name/research']);
    await sync(page);
    await browse(page);
    await expect(
      page
        .getByRole('main')
        .getByText('An unrelated typed record', { exact: true }),
    ).toBeVisible();
    const first = await sourceState(page, subject);
    expect(first.config?.principal?.kind).toBe('public');
    expect(first.rows).toHaveLength(1);
    expect(first.rows[0].managed).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/boolean',
          value: true,
        }),
        expect.objectContaining({
          datatype: 'https://atomicdata.dev/datatypes/timestamp',
          value: Date.parse('2026-11-19T09:00:00Z'),
        }),
      ]),
    );
    await sync(page);
    await expect(
      iframe.getByText('0 added · 0 changed · 1 unchanged', { exact: true }),
    ).toBeVisible();
    await browse(page);
    expect((await sourceState(page, subject)).rows[0].subject).toBe(
      first.rows[0].subject,
    );
    expect(reads).toEqual([
      upstream + '/by-name/research',
      upstream + '/spaces/44/entries',
      upstream + '/spaces/44/entries',
    ]);
    expect(requests.providerRequests).toEqual([]);
    expect(requests.redeemed).toEqual([]);
    await testInfo.attach('unrelated-catalog-native-records', {
      body: await page.screenshot(),
      contentType: 'image/png',
    });
  });
});

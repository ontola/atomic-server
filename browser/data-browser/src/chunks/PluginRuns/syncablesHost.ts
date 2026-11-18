import { core, findSchema, ensureSchema, type Store } from '@tomic/react';
import { getIntegrationProxy } from '@helpers/integrationProxy';
import {
  readLimitedResponseText,
  type ProxyConnections,
} from '@helpers/proxyConnections';
import {
  isSyncableResourceInDrive,
  queueSyncableProvisioning,
  syncablePlatformSchema,
} from './syncablePlatform';
import {
  ensureSyncableNode,
  syncableHierarchySchema,
  type SyncableNodeInput,
} from './syncableHierarchy';
import { syncablesProxyUrl } from './syncablesProxyScope';

/**
 * Only the built-in, CSP-sandboxed Syncables iframe may call these operations.
 * The host does the writes as the signed-in person after verifying a narrow,
 * explicit destination. These operations are NOT exposed by AppFrame for
 * arbitrary installed apps.
 */
export interface BuiltinSyncablesRequest {
  op: string;
  connectionId?: unknown;
  ownerId?: unknown;
  ownerLogin?: unknown;
  ownerKind?: unknown;
  repoId?: unknown;
  repoName?: unknown;
  repository?: unknown;
  issues?: unknown;
  paused?: unknown;
  imported?: unknown;
  incomplete?: unknown;
  message?: unknown;
  owners?: unknown;
  repos?: unknown;
  read?: unknown;
  page?: unknown;
  added?: unknown;
  changed?: unknown;
  unchanged?: unknown;
}

interface Context {
  platform: string;
  proxyOrigin: string;
  kind: string;
  mode?: 'public';
  connectionId?: string;
  ownerId?: string;
  ownerLogin?: string;
  repoId?: string;
  repoName?: string;
}

interface PublicIssueContinuation {
  page: number;
  after?: string;
}

/** Values the scoped provider reads actually returned to this frame. */
export interface SyncablesDiscovery {
  owners: Set<string>;
  repositories: Map<string, boolean>;
  publicIssuePages: Map<string, PublicIssueContinuation | 'loading'>;
}

function ownerKey(id: string, login: string, type: string) {
  return JSON.stringify([id, login, type]);
}

function repositoryKey(id: string, name: string) {
  return JSON.stringify([id, name]);
}

function captureDiscovery(
  discovery: SyncablesDiscovery,
  context: Context,
  read: unknown,
  body: unknown,
) {
  if (read === 'profile' && body && typeof body === 'object') {
    const { id, login } = body as Record<string, unknown>;
    if (typeof id === 'number' && typeof login === 'string')
      discovery.owners.add(ownerKey(String(id), login, 'personal'));
  }

  if (!Array.isArray(body)) return;

  if (read === 'owners') {
    for (const owner of body) {
      if (typeof owner?.id === 'number' && typeof owner?.login === 'string')
        discovery.owners.add(
          ownerKey(String(owner.id), owner.login, 'organization'),
        );
    }
  }

  if (read !== 'repositories') return;

  for (const repo of body) {
    if (context.kind === 'organizations') {
      const { id, login, type } = repo?.owner ?? {};

      if (typeof id === 'number' && typeof login === 'string') {
        const kind = type === 'Organization' ? 'organization' : 'personal';
        discovery.owners.add(ownerKey(String(id), login, kind));
      }
    } else if (typeof repo?.id === 'number' && typeof repo?.name === 'string') {
      discovery.repositories.set(
        repositoryKey(String(repo.id), repo.name),
        repo.has_issues !== false,
      );
    }
  }
}

function requiredText(value: unknown, name: string, max = 512): string {
  if (typeof value !== 'string' || !value || value.length > max)
    throw new Error(name + ' is required');

  return value;
}

function numericId(value: unknown, name: string): string {
  const id = requiredText(value, name, 24);
  if (!/^[1-9][0-9]*$/.test(id) || !Number.isSafeInteger(Number(id)))
    throw new Error('Invalid ' + name);

  return id;
}

function identifier(value: unknown, name: string): string {
  const text = requiredText(value, name, 120);
  if (!/^[A-Za-z0-9._-]+$/.test(text)) throw new Error('Invalid ' + name);

  return text;
}

type RepositoryOwnerKind = 'organization' | 'personal';

function parseGitHubRepositoryReference(value: unknown) {
  const reference = requiredText(value, 'GitHub repository', 140);
  const match = reference.match(
    /^([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9._-]{1,100})$/i,
  );
  if (!match || match[0] !== reference || match[2] === '.' || match[2] === '..')
    throw new Error('Enter a GitHub repository as owner/repo');

  return { owner: match[1], repo: match[2] };
}

async function fetchPublicGitHub(path: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(15_000);
  const response = await fetch('https://api.github.com' + path, {
    method: 'GET',
    cache: 'no-store',
    credentials: 'omit',
    redirect: 'error',
    referrerPolicy: 'no-referrer',
    headers: { Accept: 'application/vnd.github+json' },
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  if (!response.ok) await response.body?.cancel().catch(() => undefined);

  return response;
}

async function readPublicGitHubRepository(
  {
    owner: requestedOwner,
    repo: requestedRepo,
  }: { owner: string; repo: string },
  signal?: AbortSignal,
) {
  const response = await fetchPublicGitHub(
    `/repos/${requestedOwner}/${requestedRepo}`,
    signal,
  );
  if (!response.ok)
    throw new Error(
      response.status === 404
        ? 'Public GitHub repository not found'
        : 'GitHub repository lookup failed (HTTP ' + response.status + ')',
    );

  const body = JSON.parse(
    await readLimitedResponseText(response, 'GitHub'),
  ) as {
    id?: unknown;
    name?: unknown;
    full_name?: unknown;
    private?: unknown;
    has_issues?: unknown;
    owner?: { id?: unknown; login?: unknown; type?: unknown };
  } | null;
  if (body?.private !== false || body.has_issues !== true)
    throw new Error('Choose a public GitHub repository with Issues enabled');

  const owner = body.owner;
  if (
    typeof owner?.login !== 'string' ||
    typeof body.name !== 'string' ||
    body.full_name !== owner.login + '/' + body.name ||
    owner.login.toLowerCase() !== requestedOwner.toLowerCase() ||
    body.name.toLowerCase() !== requestedRepo.toLowerCase() ||
    (owner.type !== 'Organization' && owner.type !== 'User') ||
    typeof owner.id !== 'number' ||
    typeof body.id !== 'number'
  )
    throw new Error('GitHub returned unexpected repository metadata');

  const ownerKind: RepositoryOwnerKind =
    owner.type === 'Organization' ? 'organization' : 'personal';

  return {
    ownerId: numericId(String(owner.id), 'owner ID'),
    ownerLogin: owner.login,
    ownerKind,
    repoId: numericId(String(body.id), 'repository ID'),
    repoName: body.name,
  };
}

const hasNextPage = (link: string | null | undefined): boolean =>
  /<[^>]+>\s*;\s*rel="next"/i.test(link ?? '');

function publicIssueContinuation(
  link: string | null,
  current: URL,
  nextPage: number,
): PublicIssueContinuation | undefined {
  if (!link || !/;\s*rel\s*=\s*(?:"next"|next)(?=\s*(?:;|,|$))/i.test(link))
    return undefined;
  const invalid = () =>
    new Error('GitHub returned an invalid issue continuation');
  const links = [
    ...link.matchAll(
      /<([^<>]+)>\s*;\s*rel\s*=\s*(?:"next"|next)(?=\s*(?:;|,|$))/gi,
    ),
  ];
  if (links.length !== 1) throw invalid();

  let next: URL;

  try {
    next = new URL(links[0][1], current);
  } catch {
    throw invalid();
  }

  if (
    next.origin !== current.origin ||
    next.pathname !== current.pathname ||
    next.username ||
    next.password ||
    next.hash ||
    next.searchParams.get('page') !== String(nextPage)
  )
    throw invalid();

  const seen = new Set<string>();

  for (const [key, value] of next.searchParams) {
    if (seen.has(key)) throw invalid();
    seen.add(key);
    if (
      key !== 'page' &&
      !(key === 'per_page' && value === '100') &&
      !(key === 'state' && value === 'all') &&
      !(
        key === 'after' &&
        value.length <= 512 &&
        /^[A-Za-z0-9+/_-]+={0,2}$/.test(value)
      )
    )
      throw invalid();
  }

  const after = next.searchParams.get('after') ?? undefined;

  return { page: nextPage, after };
}

async function readPublicGitHubIssues(
  repoId: string,
  pagination: SyncablesDiscovery['publicIssuePages'],
  page: unknown = 1,
  signal?: AbortSignal,
) {
  if (
    typeof page !== 'number' ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > 40
  )
    throw new Error('Invalid pagination page');
  const next = pagination.get(repoId);
  if (next === 'loading')
    throw new Error('A GitHub issue page is already loading');
  if (page > 1 && next?.page !== page)
    throw new Error('Load public GitHub issue pages in order');

  // Use only the validated cursor. Rebuild the URL from this mirror's fixed
  // numeric repository and read parameters rather than following the Link.
  const url = new URL(
    `/repositories/${repoId}/issues?per_page=100&page=${page}&state=all`,
    'https://api.github.com',
  );
  if (page > 1 && next?.after) url.searchParams.set('after', next.after);
  pagination.set(repoId, 'loading');

  try {
    const response = await fetchPublicGitHub(url.pathname + url.search, signal);
    const body: unknown = response.ok
      ? JSON.parse(await readLimitedResponseText(response, 'GitHub'))
      : null;
    signal?.throwIfAborted();
    if (response.ok && !Array.isArray(body))
      throw new Error('GitHub returned an invalid issue list');
    const continuation = response.ok
      ? publicIssueContinuation(response.headers.get('Link'), url, page + 1)
      : undefined;
    if (continuation) pagination.set(repoId, continuation);

    return { status: response.status, body, nextPage: !!continuation };
  } finally {
    if (pagination.get(repoId) === 'loading') pagination.delete(repoId);
  }
}

type ProvisionDestination = Pick<
  SyncableNodeInput,
  'drive' | 'parent' | 'platform' | 'proxyOrigin'
>;
type OwnerBinding = {
  connectionId: string;
  ownerId: string;
  ownerLogin: string;
};

async function ensureOwnerRepositories(
  store: Store,
  destination: ProvisionDestination,
  config: OwnerBinding,
  ownerKind: RepositoryOwnerKind,
  signal?: AbortSignal,
) {
  const remoteId = 'github-owner:' + config.ownerId;
  signal?.throwIfAborted();
  const owner = await ensureSyncableNode(store, {
    ...destination,
    kind: 'owner',
    remoteId,
    name: config.ownerLogin,
    ownerKind,
    config,
  });
  signal?.throwIfAborted();

  return ensureSyncableNode(store, {
    ...destination,
    parent: owner,
    kind: 'repositories',
    remoteId,
    name: 'Repositories',
    config,
  });
}

async function ensureRepositoryMirror(
  store: Store,
  destination: ProvisionDestination,
  config: OwnerBinding & { repoId: string; repoName: string },
  signal?: AbortSignal,
) {
  const remoteId = 'github-repo:' + config.repoId;
  signal?.throwIfAborted();
  const repository = await ensureSyncableNode(store, {
    ...destination,
    kind: 'repository',
    remoteId,
    name: config.repoName,
    config,
  });
  signal?.throwIfAborted();

  return ensureSyncableNode(store, {
    ...destination,
    parent: repository,
    kind: 'mirror',
    remoteId,
    collectionName: 'issues',
    name: 'Issues',
    config,
  });
}

function readConfig(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const result: Record<string, string> = {};

  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') result[key] = entry;
  }

  return result;
}

async function contextOf(
  store: Store,
  drive: string,
  table: string,
): Promise<Context> {
  if (!(await isSyncableResourceInDrive(store, drive, table)))
    throw new Error('This Syncables table is outside the current drive');
  const resource = await store.getResource(table);
  if (resource.error) throw resource.error;
  const p = await findSchema(store, drive, syncablePlatformSchema());
  const platform =
    p.properties?.['syncable-platform-id'] &&
    resource.get(p.properties['syncable-platform-id']);
  const proxyOrigin =
    p.properties?.['syncable-proxy-origin'] &&
    resource.get(p.properties['syncable-proxy-origin']);

  if (typeof platform === 'string' && typeof proxyOrigin === 'string') {
    return { kind: 'platform', platform, proxyOrigin };
  }

  const h = await findSchema(store, drive, syncableHierarchySchema());
  const source =
    h.properties?.['syncable-source-key'] &&
    resource.get(h.properties['syncable-source-key']);
  if (typeof source !== 'string')
    throw new Error('This is not a Syncables table');
  let key: unknown;

  try {
    key = JSON.parse(source);
  } catch {
    throw new Error('Invalid Syncables source binding');
  }

  if (!Array.isArray(key) || (key.length !== 5 && key.length !== 6))
    throw new Error('Invalid Syncables source key');
  const [origin, service, kind, sourceId, collection, sourceConnection] = key;
  if (typeof origin !== 'string' || typeof service !== 'string')
    throw new Error('Unsupported Syncables source');

  const configProperty = h.properties?.['syncable-source-config'];
  const storedConfig = configProperty
    ? resource.get(configProperty)
    : undefined;
  const config = readConfig(storedConfig);

  if (kind === 'public' || kind === 'public-mirror') {
    const recordedKind = h.properties?.['syncable-node-kind'];
    if (
      key.length !== 5 ||
      service !== 'github-issues' ||
      !recordedKind ||
      resource.get(recordedKind) !== kind ||
      (storedConfig &&
        typeof storedConfig === 'object' &&
        Object.hasOwn(storedConfig, 'connectionId'))
    )
      throw new Error('Invalid public GitHub source binding');

    const context = {
      proxyOrigin: origin,
      platform: service,
      mode: 'public',
    } as const;
    if (kind === 'public' && sourceId === 'github-public' && collection === '')
      return { ...context, kind };

    if (kind === 'public-mirror' && collection === 'issues') {
      const ownerId = numericId(config.ownerId, 'owner ID');
      const repoId = numericId(config.repoId, 'repository ID');
      const ownerLogin = requiredText(config.ownerLogin, 'owner login', 39);
      const repoName = requiredText(config.repoName, 'repository name', 100);
      parseGitHubRepositoryReference(ownerLogin + '/' + repoName);
      if (sourceId === 'github-public-repo:' + repoId)
        return {
          ...context,
          kind: 'mirror',
          ownerId,
          ownerLogin,
          repoId,
          repoName,
        };
    }

    throw new Error('Invalid public GitHub source binding');
  }

  if (kind !== 'organizations' && kind !== 'repositories' && kind !== 'mirror')
    throw new Error('Unsupported Syncables source');

  const connectionId = requiredText(config.connectionId, 'Connection ID');
  const context = {
    kind,
    proxyOrigin: origin,
    platform: service,
    connectionId,
  };
  if (kind === 'organizations' && key.length === 5 && sourceId === connectionId)
    return context;

  if (key.length === 6 && sourceConnection !== connectionId)
    throw new Error('The saved Syncables account does not match its source');

  const ownerId = numericId(config.ownerId, 'owner ID');
  const ownerLogin = identifier(config.ownerLogin, 'owner login');
  if (kind === 'repositories' && sourceId === 'github-owner:' + ownerId)
    return { ...context, ownerId, ownerLogin };

  if (kind === 'mirror' && collection === 'issues') {
    const repoId = numericId(config.repoId, 'repository ID');
    const repoName = identifier(config.repoName, 'repository name');
    if (sourceId === 'github-repo:' + repoId)
      return { ...context, ownerId, ownerLogin, repoId, repoName };
  }

  throw new Error('Invalid Syncables source binding');
}

async function assertConnection(
  proxy: ProxyConnections,
  platform: string,
  connectionId: string,
): Promise<void> {
  const available = await proxy.listKeyed(platform);
  if (!available.some(row => row.connection_id === connectionId))
    throw new Error('Connect this GitHub account on this device to use it');
}

async function readGitHubProfile(
  proxy: ProxyConnections,
  context: Context,
  signal?: AbortSignal,
) {
  const slot = requiredText(context.connectionId, 'Connection ID');
  const connectionId = await proxy.activeKeyedConnection(
    context.platform,
    slot,
  );
  const url = syncablesProxyUrl({ ...context, connectionId }, 'profile');
  const { status, body } = await proxy.readKeyed(url, signal);
  if (status < 200 || status >= 300)
    throw new Error('Could not verify this GitHub account');
  const profile = body as { login?: unknown; id?: unknown } | null;
  const login = identifier(profile?.login, 'GitHub account login');
  const id = numericId(String(profile?.id), 'GitHub account ID');
  await proxy.rememberKeyedGithubPrincipal(slot, id);

  return { login, id };
}

async function githubAccounts(
  proxy: ProxyConnections,
  context: Context,
  signal?: AbortSignal,
) {
  const rows = await proxy.listKeyed(context.platform);

  return Promise.all(
    rows.map(async ({ connection_id: connectionId }) => {
      try {
        const { login } = await readGitHubProfile(
          proxy,
          { ...context, connectionId },
          signal,
        );

        return { connectionId, login, healthy: true };
      } catch {
        signal?.throwIfAborted();

        return {
          connectionId,
          login: 'GitHub account',
          healthy: false,
          canReconnect: await proxy.canReconnectGithub(connectionId),
        };
      }
    }),
  );
}

async function mirrorStatus(store: Store, drive: string, table: string) {
  const terms = await findSchema(store, drive, syncableHierarchySchema());
  const property = terms.properties?.['syncable-mirror-status'];
  const resource = await store.getResource(table);
  const raw = property ? resource.get(property) : undefined;
  const value =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};

  return {
    paused: value.paused === true,
    rows: typeof value.rows === 'number' ? value.rows : 0,
    lastSuccess:
      typeof value.lastSuccess === 'string' ? value.lastSuccess : undefined,
    incomplete: value.incomplete === true,
    added: typeof value.added === 'number' ? value.added : 0,
    changed: typeof value.changed === 'number' ? value.changed : 0,
    unchanged: typeof value.unchanged === 'number' ? value.unchanged : 0,
    error: typeof value.error === 'string' ? value.error : undefined,
  };
}

async function updateStatus(
  store: Store,
  drive: string,
  table: string,
  patch: Record<string, string | number | boolean | null>,
): Promise<void> {
  const terms = await ensureSchema(store, drive, syncableHierarchySchema());
  const resource = await store.getResource(table);
  const current = await mirrorStatus(store, drive, table);
  await resource.set(terms.properties['syncable-mirror-status'], {
    ...current,
    ...patch,
  });
  await resource.save();
}

async function importIssues(
  store: Store,
  drive: string,
  table: string,
  raw: unknown,
  signal?: AbortSignal,
): Promise<{ added: number; changed: number; unchanged: number }> {
  if (!Array.isArray(raw) || raw.length > 100)
    throw new Error('A Syncables issue batch must contain at most 100 issues');
  const terms = await ensureSchema(store, drive, syncableHierarchySchema());
  const rowClass = terms.classes['syncable-record'];
  const result = { added: 0, changed: 0, unchanged: 0 };
  const records = raw.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new Error('Invalid issue record');
    const issue = entry as Record<string, unknown>;
    const id = typeof issue.id === 'number' ? issue.id : NaN;
    const number = typeof issue.number === 'number' ? issue.number : NaN;
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !Number.isSafeInteger(number) ||
      number <= 0
    )
      throw new Error('Invalid GitHub issue identity');
    const title = requiredText(issue.title, 'Issue title', 4096);
    const state = issue.state;
    if (state !== 'open' && state !== 'closed')
      throw new Error('Invalid issue state');
    const localId = 'syncables:github-issue:' + String(id);
    const updatedAt = Date.parse(
      requiredText(issue.updatedAt, 'Issue updatedAt', 64),
    );
    if (!Number.isFinite(updatedAt)) throw new Error('Invalid issue timestamp');
    const link = requiredText(issue.htmlUrl, 'Issue URL', 4096);
    if (
      !/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/issues\/[0-9]+$/.test(
        link,
      )
    )
      throw new Error('Invalid GitHub issue URL');
    const body =
      issue.body === null || issue.body === undefined
        ? ''
        : typeof issue.body === 'string' && issue.body.length <= 200000
          ? issue.body
          : (() => {
              throw new Error('Invalid issue body');
            })();

    const propVals = {
      [core.properties.name]: title,
      [core.properties.localId]: localId,
      [terms.properties['syncable-issue-number']]: number,
      [terms.properties['syncable-issue-state']]: state,
      [terms.properties['syncable-issue-updated']]: updatedAt,
      [terms.properties['syncable-issue-link']]: link,
      [terms.properties['syncable-issue-body']]: body,
    };

    return { localId, propVals };
  });

  for (const { localId, propVals } of records) {
    signal?.throwIfAborted();
    const existing = await store.findByLocalId(drive, table, localId);

    if (existing) {
      if (!existing.hasClasses(rowClass))
        throw new Error('Issue identity is already in use');
      const changes = Object.entries(propVals).filter(
        ([property, value]) => existing.get(property) !== value,
      );

      if (changes.length === 0) {
        result.unchanged++;
        continue;
      }

      for (const [property, value] of changes)
        await existing.set(property, value);
      await existing.save();
      result.changed++;
    } else {
      const row = await store.newResource({
        parent: table,
        isA: [rowClass],
        propVals,
      });
      await row.save();
      result.added++;
    }
  }

  return result;
}

/** Handler reachable only from the dedicated first-party iframe component. */
export async function syncablesHostRequest(
  store: Store,
  drive: string,
  table: string,
  request: BuiltinSyncablesRequest,
  proxy: ProxyConnections,
  discovery: SyncablesDiscovery,
  signal?: AbortSignal,
): Promise<unknown> {
  if (!store.getAgent()?.subject)
    throw new Error('Sign in to use connected services');
  const context = await contextOf(store, drive, table);
  if (
    context.mode !== 'public' &&
    context.proxyOrigin !== getIntegrationProxy()
  )
    throw new Error('Select this integration proxy in Settings before syncing');
  if (context.platform !== 'github-issues' && request.op !== 'syncablesContext')
    throw new Error(
      'Collection discovery is not supported for this provider yet',
    );

  signal?.throwIfAborted();

  if (request.op === 'syncablesContext') {
    const canReconnect =
      context.platform === 'github-issues' &&
      !!context.connectionId &&
      (await proxy.canReconnectGithub(context.connectionId));

    return { ...context, canReconnect };
  }

  if (request.op === 'syncablesAccounts') {
    if (context.kind !== 'platform') throw new Error('Expected platform table');

    return githubAccounts(proxy, context, signal);
  }

  if (request.op === 'syncablesRead') {
    if (context.mode === 'public') {
      if (context.kind !== 'mirror' || request.read !== 'issues')
        throw new Error('This view cannot read that GitHub endpoint');
      if ((await mirrorStatus(store, drive, table)).paused)
        throw new Error('This mirror is paused');

      return readPublicGitHubIssues(
        numericId(context.repoId, 'repository ID'),
        discovery.publicIssuePages,
        request.page,
        signal,
      );
    }

    if (!context.connectionId)
      throw new Error('This view has no GitHub connection');
    const connectionId = await proxy.activeKeyedConnection(
      context.platform,
      context.connectionId,
    );
    const url = syncablesProxyUrl(
      { ...context, connectionId },
      request.read,
      request.page,
    );
    if (
      context.kind === 'mirror' &&
      (await mirrorStatus(store, drive, table)).paused
    )
      throw new Error('This mirror is paused');
    const response = await proxy.readKeyed(url, signal);
    const success = response.status >= 200 && response.status < 300;
    let body = success ? response.body : null;

    if (success && request.read === 'profile') {
      const profile = body as { id?: unknown; login?: unknown } | null;
      body = { id: profile?.id, login: profile?.login };
    }

    if (success && context.kind === 'repositories' && Array.isArray(body)) {
      body = body.filter(repo => String(repo?.owner?.id) === context.ownerId);
    }

    signal?.throwIfAborted();
    if (success) captureDiscovery(discovery, context, request.read, body);

    return {
      status: response.status,
      body,
      nextPage: hasNextPage(response.headers.link),
    };
  }

  const target = await store.getResource(table);
  const [canWrite] = await target.canWrite(store.getAgent()?.subject);
  if (!canWrite && request.op !== 'syncablesMirrorStatus')
    throw new Error('Write access to this Syncables table is required');
  signal?.throwIfAborted();

  if (request.op === 'syncablesOpenPublic') {
    if (context.kind !== 'platform') throw new Error('Expected platform table');
    const subject = await ensureSyncableNode(store, {
      drive,
      parent: table,
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      kind: 'public',
      remoteId: 'github-public',
      name: 'Public',
    });

    return { subject };
  }

  if (request.op === 'syncablesOpenAccount') {
    if (context.kind !== 'platform') throw new Error('Expected platform table');
    const connectionId = requiredText(request.connectionId, 'Connection ID');
    await assertConnection(proxy, context.platform, connectionId);
    const { login } = await readGitHubProfile(
      proxy,
      { ...context, connectionId },
      signal,
    );
    signal?.throwIfAborted();
    const account = await ensureSyncableNode(store, {
      drive,
      parent: table,
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      kind: 'account',
      remoteId: connectionId,
      name: login,
      config: { connectionId, ownerLogin: login },
    });
    const organizations = await ensureSyncableNode(store, {
      drive,
      parent: account,
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      kind: 'organizations',
      remoteId: connectionId,
      name: 'Organizations',
      config: { connectionId },
    });

    return { subject: organizations };
  }

  if (request.op === 'syncablesDiscoverOwners') {
    if (context.kind !== 'organizations')
      throw new Error('Expected Organizations table');
    const owners = request.owners;
    if (!Array.isArray(owners) || owners.length > 100)
      throw new Error('Organization discovery batch exceeds 100');
    const connectionId = requiredText(context.connectionId, 'Connection ID');
    await assertConnection(proxy, context.platform, connectionId);
    signal?.throwIfAborted();

    for (const item of owners) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new Error('Invalid owner namespace');
      const row = item as Record<string, unknown>;
      const ownerId = numericId(row.id, 'owner ID');
      const ownerLogin = identifier(row.login, 'owner login');
      if (row.type !== 'organization' && row.type !== 'personal')
        throw new Error('Invalid owner kind');
      if (!discovery.owners.has(ownerKey(ownerId, ownerLogin, row.type)))
        throw new Error('Refresh the owner list before opening this namespace');
      signal?.throwIfAborted();
      await ensureSyncableNode(store, {
        drive,
        parent: table,
        proxyOrigin: context.proxyOrigin,
        platform: context.platform,
        kind: 'owner',
        remoteId: 'github-owner:' + ownerId,
        name: ownerLogin,
        ownerKind: row.type,
        config: { connectionId, ownerId, ownerLogin },
      });
    }

    return { count: owners.length };
  }

  if (request.op === 'syncablesDiscoverRepos') {
    if (context.kind !== 'repositories')
      throw new Error('Expected Repositories table');
    const repos = request.repos;
    if (!Array.isArray(repos) || repos.length > 100)
      throw new Error('Repository discovery batch exceeds 100');
    const connectionId = requiredText(context.connectionId, 'Connection ID');
    const ownerId = numericId(context.ownerId, 'owner ID');
    const ownerLogin = identifier(context.ownerLogin, 'owner login');
    await assertConnection(proxy, context.platform, connectionId);
    signal?.throwIfAborted();

    for (const item of repos) {
      if (!item || typeof item !== 'object' || Array.isArray(item))
        throw new Error('Invalid repository record');
      const row = item as Record<string, unknown>;
      const repoId = numericId(row.id, 'repository ID');
      const repoName = identifier(row.name, 'repository name');
      if (!discovery.repositories.has(repositoryKey(repoId, repoName)))
        throw new Error(
          'Refresh the repository list before opening this repository',
        );
      signal?.throwIfAborted();
      await ensureSyncableNode(store, {
        drive,
        parent: table,
        proxyOrigin: context.proxyOrigin,
        platform: context.platform,
        kind: 'repository',
        remoteId: 'github-repo:' + repoId,
        name: repoName,
        config: { connectionId, ownerId, ownerLogin, repoId, repoName },
      });
    }

    return { count: repos.length };
  }

  if (request.op === 'syncablesOpenOwner') {
    if (context.kind !== 'organizations')
      throw new Error('Expected Organizations table');
    const connectionId = requiredText(request.connectionId, 'Connection ID');
    if (connectionId !== context.connectionId)
      throw new Error('Wrong account connection');
    await assertConnection(proxy, context.platform, connectionId);
    const ownerId = numericId(request.ownerId, 'owner ID');
    const ownerLogin = identifier(request.ownerLogin, 'owner login');
    const ownerKind = request.ownerKind;
    if (ownerKind !== 'organization' && ownerKind !== 'personal')
      throw new Error('Invalid owner namespace kind');
    if (!discovery.owners.has(ownerKey(ownerId, ownerLogin, ownerKind)))
      throw new Error('Refresh the owner list before opening this namespace');

    const subject = await ensureOwnerRepositories(
      store,
      {
        drive,
        parent: table,
        proxyOrigin: context.proxyOrigin,
        platform: context.platform,
      },
      { connectionId, ownerId, ownerLogin },
      ownerKind,
      signal,
    );

    return { subject };
  }

  if (request.op === 'syncablesLinkPublicRepository') {
    if (context.kind !== 'public')
      throw new Error('Expected public GitHub repositories');
    const reference = parseGitHubRepositoryReference(request.repository);
    const { ownerId, ownerLogin, ownerKind, repoId, repoName } =
      await readPublicGitHubRepository(reference, signal);
    const config = { ownerId, ownerLogin, repoId, repoName };
    const destination = {
      drive,
      parent: table,
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
    };
    signal?.throwIfAborted();
    const owner = await ensureSyncableNode(store, {
      ...destination,
      kind: 'public-owner',
      remoteId: 'github-public-owner:' + ownerId,
      name: ownerLogin,
      ownerKind,
      config: { ownerId, ownerLogin },
    });
    signal?.throwIfAborted();
    const repository = await ensureSyncableNode(store, {
      ...destination,
      parent: owner,
      kind: 'public-repository',
      remoteId: 'github-public-repo:' + repoId,
      name: repoName,
      config,
    });
    signal?.throwIfAborted();
    const subject = await ensureSyncableNode(store, {
      ...destination,
      parent: repository,
      kind: 'public-mirror',
      remoteId: 'github-public-repo:' + repoId,
      collectionName: 'issues',
      name: 'Issues',
      config,
    });

    return { subject };
  }

  if (request.op === 'syncablesCreateMirror') {
    if (context.kind !== 'repositories')
      throw new Error('Expected Repositories table');
    const connectionId = requiredText(request.connectionId, 'Connection ID');
    const ownerId = numericId(request.ownerId, 'owner ID');
    const ownerLogin = identifier(request.ownerLogin, 'owner login');
    if (
      connectionId !== context.connectionId ||
      ownerId !== context.ownerId ||
      ownerLogin !== context.ownerLogin
    )
      throw new Error('Wrong repository source');
    await assertConnection(proxy, context.platform, connectionId);
    const repoId = numericId(request.repoId, 'repository ID');
    const repoName = identifier(request.repoName, 'repository name');
    if (discovery.repositories.get(repositoryKey(repoId, repoName)) !== true)
      throw new Error('This repository is not available for issue sync');
    const subject = await ensureRepositoryMirror(
      store,
      {
        drive,
        parent: table,
        proxyOrigin: context.proxyOrigin,
        platform: context.platform,
      },
      { connectionId, ownerId, ownerLogin, repoId, repoName },
      signal,
    );

    return { subject };
  }

  if (context.kind !== 'mirror')
    throw new Error('Expected mirrored collection');

  return queueSyncableProvisioning(store, drive, async () => {
    signal?.throwIfAborted();

    switch (request.op) {
      case 'syncablesMirrorStatus':
        return mirrorStatus(store, drive, table);

      case 'syncablesSetPaused': {
        if (typeof request.paused !== 'boolean')
          throw new Error('Invalid pause state');
        await updateStatus(store, drive, table, { paused: request.paused });

        return { paused: request.paused };
      }

      case 'syncablesImportIssues': {
        if ((await mirrorStatus(store, drive, table)).paused)
          throw new Error('This mirror is paused');

        return importIssues(store, drive, table, request.issues, signal);
      }

      case 'syncablesRecordSuccess': {
        if (
          typeof request.imported !== 'number' ||
          !Number.isSafeInteger(request.imported) ||
          request.imported < 0 ||
          typeof request.incomplete !== 'boolean'
        )
          throw new Error('Invalid sync summary');
        const { added, changed, unchanged, incomplete } = request;
        if (
          typeof added !== 'number' ||
          typeof changed !== 'number' ||
          typeof unchanged !== 'number' ||
          [added, changed, unchanged].some(
            count => !Number.isSafeInteger(count) || count < 0,
          ) ||
          added + changed + unchanged !== request.imported
        )
          throw new Error('Invalid issue update counts');
        await updateStatus(store, drive, table, {
          rows: request.imported,
          added,
          changed,
          unchanged,
          ...(incomplete ? {} : { lastSuccess: new Date().toISOString() }),
          incomplete,
          error: incomplete
            ? 'Read limit reached. Local rows were retained.'
            : null,
        });

        return true;
      }

      case 'syncablesRecordFailure': {
        const message = requiredText(request.message, 'Sync error', 1024);
        await updateStatus(store, drive, table, { error: message });

        return true;
      }

      default:
        throw new Error('Unknown Syncables host operation');
    }
  });
}

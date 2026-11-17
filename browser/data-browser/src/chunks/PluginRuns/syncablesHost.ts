import { core, findSchema, ensureSchema, type Store } from '@tomic/react';
import { getIntegrationProxy } from '@helpers/integrationProxy';
import { ProxyConnections } from '@helpers/proxyConnections';
import {
  isSyncableResourceInDrive,
  queueSyncableProvisioning,
  syncablePlatformSchema,
} from './syncablePlatform';
import {
  ensureSyncableNode,
  syncableHierarchySchema,
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
  connectionId?: string;
  ownerId?: string;
  ownerLogin?: string;
  repoId?: string;
  repoName?: string;
}

/** Values the scoped proxy actually returned to this frame. */
export interface SyncablesDiscovery {
  owners: Set<string>;
  repositories: Map<string, boolean>;
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
  if (
    typeof origin !== 'string' ||
    typeof service !== 'string' ||
    typeof kind !== 'string' ||
    !['organizations', 'repositories', 'mirror'].includes(kind)
  )
    throw new Error('Unsupported Syncables source');

  const config = readConfig(
    h.properties?.['syncable-source-config'] &&
      resource.get(h.properties['syncable-source-config']),
  );
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
  if (context.proxyOrigin !== getIntegrationProxy())
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
      nextPage: /<[^>]+>\s*;\s*rel="next"/i.test(response.headers.link ?? ''),
    };
  }

  const target = await store.getResource(table);
  const [canWrite] = await target.canWrite(store.getAgent()?.subject);
  if (!canWrite && request.op !== 'syncablesMirrorStatus')
    throw new Error('Write access to this Syncables table is required');
  signal?.throwIfAborted();

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

    signal?.throwIfAborted();
    const owner = await ensureSyncableNode(store, {
      drive,
      parent: table,
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      kind: 'owner',
      remoteId: 'github-owner:' + ownerId,
      name: ownerLogin,
      ownerKind,
      config: { connectionId, ownerId, ownerLogin },
    });
    const repositories = await ensureSyncableNode(store, {
      drive,
      parent: owner,
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      kind: 'repositories',
      remoteId: 'github-owner:' + ownerId,
      name: 'Repositories',
      config: { connectionId, ownerId, ownerLogin },
    });

    return { subject: repositories };
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
    const config = { connectionId, ownerId, ownerLogin, repoId, repoName };
    signal?.throwIfAborted();
    const repository = await ensureSyncableNode(store, {
      drive,
      parent: table,
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      kind: 'repository',
      remoteId: 'github-repo:' + repoId,
      name: repoName,
      config,
    });
    const mirror = await ensureSyncableNode(store, {
      drive,
      parent: repository,
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      kind: 'mirror',
      remoteId: 'github-repo:' + repoId,
      collectionName: 'issues',
      name: 'Issues',
      config,
    });

    return { subject: mirror };
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

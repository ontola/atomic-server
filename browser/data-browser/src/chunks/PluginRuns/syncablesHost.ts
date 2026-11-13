import {
  core,
  findSchema,
  ensureSchema,
  type Store,
} from '@tomic/react';
import { getIntegrationProxy } from '@helpers/integrationProxy';
import { ProxyConnections } from '@helpers/proxyConnections';
import {
  syncablePlatformSchema,
} from './syncablePlatform';
import {
  ensureSyncableNode,
  syncableHierarchySchema,
} from './syncableHierarchy';

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
  if (!/^[A-Za-z0-9._-]+$/.test(text))
    throw new Error('Invalid ' + name);
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
  if (typeof source !== 'string') throw new Error('This is not a Syncables table');
  let key: unknown;
  try {
    key = JSON.parse(source);
  } catch {
    throw new Error('Invalid Syncables source binding');
  }
  if (!Array.isArray(key) || key.length !== 5)
    throw new Error('Invalid Syncables source key');
  const [origin, service, kind] = key;
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
  return {
    kind,
    proxyOrigin: origin,
    platform: service,
    ...config,
  };
}

async function assertConnection(
  proxy: ProxyConnections,
  platform: string,
  connectionId: string,
): Promise<void> {
  const available = await proxy.list(platform);
  if (!available.some(row => row.connection_id === connectionId))
    throw new Error('This connection is not owned by the signed-in account');
}

async function mirrorStatus(store: Store, drive: string, table: string) {
  const terms = await findSchema(store, drive, syncableHierarchySchema());
  const property = terms.properties?.['syncable-mirror-status'];
  const resource = await store.getResource(table);
  const raw = property ? resource.get(property) : undefined;
  const value = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    paused: value.paused === true,
    rows: typeof value.rows === 'number' ? value.rows : 0,
    lastSuccess: typeof value.lastSuccess === 'string' ? value.lastSuccess : undefined,
    incomplete: value.incomplete === true,
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
): Promise<{ imported: number }> {
  if (!Array.isArray(raw) || raw.length > 100)
    throw new Error('A Syncables issue batch must contain at most 100 issues');
  const terms = await ensureSchema(store, drive, syncableHierarchySchema());
  const rowClass = terms.classes['syncable-record'];
  let imported = 0;

  for (const entry of raw) {
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
    const updatedAt = Date.parse(requiredText(issue.updatedAt, 'Issue updatedAt', 64));
    if (!Number.isFinite(updatedAt))
      throw new Error('Invalid issue timestamp');
    const link = requiredText(issue.htmlUrl, 'Issue URL', 4096);
    if (!/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/issues\/[0-9]+$/.test(link))
      throw new Error('Invalid GitHub issue URL');
    const body = issue.body === null || issue.body === undefined
      ? ''
      : requiredText(issue.body, 'Issue body', 200000);

    const propVals = {
      [core.properties.name]: title,
      [core.properties.localId]: localId,
      [terms.properties['syncable-issue-number']]: number,
      [terms.properties['syncable-issue-state']]: state,
      [terms.properties['syncable-issue-updated']]: updatedAt,
      [terms.properties['syncable-issue-link']]: link,
      [terms.properties['syncable-issue-body']]: body,
    };
    const existing = await store.findByLocalId(drive, table, localId);
    if (existing) {
      // Only patch columns owned by this integration. User-defined columns
      // and independently linked resources remain untouched.
      for (const [property, value] of Object.entries(propVals)) {
        if (property === core.properties.localId) continue;
        if (existing.get(property) !== value) await existing.set(property, value);
      }
      await existing.save();
    } else {
      const row = await store.newResource({
        parent: table,
        isA: [rowClass],
        propVals,
      });
      await row.save();
    }
    imported++;
  }
  return { imported };
}

/** Handler reachable only from the dedicated first-party iframe component. */
export async function syncablesHostRequest(
  store: Store,
  drive: string,
  table: string,
  request: BuiltinSyncablesRequest,
  proxy: ProxyConnections,
): Promise<unknown> {
  if (!store.getAgent())
    throw new Error('Sign in to use connected services');
  const context = await contextOf(store, drive, table);
  if (context.proxyOrigin !== getIntegrationProxy())
    throw new Error('Select this integration proxy in Settings before syncing');
  if (context.platform !== 'github-issues' && request.op !== 'syncablesContext')
    throw new Error('Collection discovery is not supported for this provider yet');

  if (request.op === 'syncablesContext') return context;

  if (request.op === 'syncablesOpenAccount') {
    if (context.kind !== 'platform') throw new Error('Expected platform table');
    const connectionId = requiredText(request.connectionId, 'Connection ID');
    await assertConnection(proxy, context.platform, connectionId);
    // The user chose this source; explicitly delegate it to their own
    // host identity so an isolated frame can receive short-lived capabilities.
    await proxy.delegate(connectionId, store.getAgent()!.subject, 'Atomic Syncables');
    const account = await ensureSyncableNode(store, {
      drive,
      parent: table,
      proxyOrigin: context.proxyOrigin,
      platform: context.platform,
      kind: 'account',
      remoteId: connectionId,
      name: 'GitHub account',
      config: { connectionId },
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

  if (request.op === 'syncablesOpenOwner') {
    if (context.kind !== 'organizations') throw new Error('Expected Organizations table');
    const connectionId = requiredText(request.connectionId, 'Connection ID');
    if (connectionId !== context.connectionId)
      throw new Error('Wrong account connection');
    await assertConnection(proxy, context.platform, connectionId);
    const ownerId = numericId(request.ownerId, 'owner ID');
    const ownerLogin = identifier(request.ownerLogin, 'owner login');
    const ownerKind = request.ownerKind;
    if (ownerKind !== 'organization' && ownerKind !== 'personal')
      throw new Error('Invalid owner namespace kind');

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
    if (context.kind !== 'repositories') throw new Error('Expected Repositories table');
    const connectionId = requiredText(request.connectionId, 'Connection ID');
    const ownerId = numericId(request.ownerId, 'owner ID');
    const ownerLogin = identifier(request.ownerLogin, 'owner login');
    if (
      connectionId !== context.connectionId ||
      ownerId !== context.ownerId ||
      ownerLogin !== context.ownerLogin
    ) throw new Error('Wrong repository source');
    await assertConnection(proxy, context.platform, connectionId);
    const repoId = numericId(request.repoId, 'repository ID');
    const repoName = identifier(request.repoName, 'repository name');
    const config = { connectionId, ownerId, ownerLogin, repoId, repoName };
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

  switch (request.op) {
    case 'syncablesMirrorStatus':
      return mirrorStatus(store, drive, table);
    case 'syncablesSetPaused': {
      if (typeof request.paused !== 'boolean') throw new Error('Invalid pause state');
      await updateStatus(store, drive, table, { paused: request.paused });
      return { paused: request.paused };
    }
    case 'syncablesImportIssues': {
      if ((await mirrorStatus(store, drive, table)).paused)
        throw new Error('This mirror is paused');
      return importIssues(store, drive, table, request.issues);
    }
    case 'syncablesRecordSuccess': {
      if (
        typeof request.imported !== 'number' ||
        !Number.isSafeInteger(request.imported) ||
        request.imported < 0 ||
        typeof request.incomplete !== 'boolean'
      ) throw new Error('Invalid sync summary');
      await updateStatus(store, drive, table, {
        rows: request.imported,
        lastSuccess: new Date().toISOString(),
        incomplete: request.incomplete,
        error: request.incomplete ? 'Read limit reached; local rows were retained.' : null,
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
}

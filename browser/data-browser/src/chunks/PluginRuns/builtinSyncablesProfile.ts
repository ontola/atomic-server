import {
  core,
  ensureSchema,
  findSchema,
  subjectsReferToSameResource,
  type Store,
} from '@tomic/lib';
import { getIntegrationProxy } from '@helpers/integrationProxy';
import {
  ProxyConnections,
  readLimitedResponseText,
  type ProxyHost,
} from '@helpers/proxyConnections';
import {
  isSyncableResourceInDrive,
  syncablePlatformSchema,
} from './syncablePlatform';
import { syncableHierarchySchema } from './syncableHierarchy';

export interface SyncAppContext {
  subject: string;
  drive: string;
  platform: string;
  proxyOrigin: string;
  kind: string;
  mode?: 'public';
  connectionId?: string;
  ownerId?: string;
  ownerLogin?: string;
  repoId?: string;
  repoName?: string;
  selection?: string;
  worker?: boolean;
  proxyTransport: 'host';
  schema: {
    classes: Record<string, string>;
    properties: Record<string, string>;
  };
}

/** Revalidate the selected drive without yielding between authority and mutation.
 * Check parents too: moving an ancestor can leave a descendant's drive stamp stale. */
export function assertSyncAppDrive(
  store: Pick<Store, 'resources' | 'normalizeSubject'>,
  drive: string,
  subject: string,
): void {
  const seen = new Set<string>();
  let current = subject;

  while (seen.size < 64 && !seen.has(current)) {
    if (subjectsReferToSameResource(current, drive)) return;
    seen.add(current);
    const resource = store.resources.get(store.normalizeSubject(current));
    if (!resource || resource.error) break;
    const assignedDrive = resource.get(
      'https://atomicdata.dev/properties/drive',
    );

    if (
      assignedDrive !== undefined &&
      (typeof assignedDrive !== 'string' ||
        !subjectsReferToSameResource(assignedDrive, drive))
    )
      break;

    const parent = resource.get(core.properties.parent);
    if (typeof parent !== 'string' || !parent) break;
    current = parent;
  }

  throw new Error('The Sync table is no longer in the selected drive');
}

/** Load full ancestry once, including stamped rows, for the synchronous guard. */
async function cacheSyncAppDrive(store: Store, drive: string, subject: string) {
  const seen = new Set<string>();
  let current = subject;

  while (seen.size < 64 && !seen.has(current)) {
    if (subjectsReferToSameResource(current, drive)) return;
    seen.add(current);
    const resource = await store.getResource(current);
    if (resource.error) throw resource.error;
    const parent = resource.get(core.properties.parent);
    if (typeof parent !== 'string' || !parent) break;
    current = parent;
  }

  throw new Error('The Sync table is outside the selected drive');
}

/** Public source fields are context, never additional write authority. */
export async function syncAppContext(
  store: Store,
  drive: string,
  table: string,
  initialize = false,
  selection?: string,
): Promise<SyncAppContext> {
  if (!(await isSyncableResourceInDrive(store, drive, table)))
    throw new Error('This Sync table is outside the selected drive');
  await cacheSyncAppDrive(store, drive, table);
  const resolve = initialize ? ensureSchema : findSchema;
  const p = await resolve(store, drive, syncablePlatformSchema());
  const h = await resolve(store, drive, syncableHierarchySchema());
  const resource = await store.getResource(table);
  if (resource.error) throw resource.error;
  const platform =
    p.properties?.['syncable-platform-id'] &&
    resource.get(p.properties['syncable-platform-id']);
  const proxyOrigin =
    p.properties?.['syncable-proxy-origin'] &&
    resource.get(p.properties['syncable-proxy-origin']);
  const context = {
    subject: table,
    drive,
    proxyTransport: 'host',
    schema: {
      classes: { ...p.classes, ...h.classes },
      properties: { ...p.properties, ...h.properties },
    },
  } as const;

  if (platform === 'github-issues' && typeof proxyOrigin === 'string') {
    if (proxyOrigin !== getIntegrationProxy())
      throw new Error(
        'Select this integration proxy in Settings before syncing',
      );

    return { ...context, platform, proxyOrigin, kind: 'platform' };
  }

  const sourceProperty = h.properties?.['syncable-source-key'];
  const configProperty = h.properties?.['syncable-source-config'];
  const source = sourceProperty && resource.get(sourceProperty);
  const rawConfig = configProperty && resource.get(configProperty);
  const config =
    rawConfig && typeof rawConfig === 'object' && !Array.isArray(rawConfig)
      ? (rawConfig as Record<string, unknown>)
      : {};
  let key: unknown;

  try {
    key = JSON.parse(typeof source === 'string' ? source : 'null');
  } catch {
    throw new Error('Invalid Sync source binding');
  }

  if (!Array.isArray(key) || ![5, 6].includes(key.length))
    throw new Error('Invalid Sync source binding');
  const [origin, service, kind, identity, collection, connection] = key;
  if (
    typeof origin !== 'string' ||
    new URL(origin).origin !== origin ||
    service !== 'github-issues'
  )
    throw new Error('Unsupported Sync source');
  const publicSource = kind === 'public' || kind === 'public-mirror';

  const read = (name: string, pattern: RegExp): string => {
    const value = config[name];
    if (typeof value !== 'string' || !pattern.test(value))
      throw new Error('Invalid Sync source ' + name);

    return value;
  };

  const id = (name: string) => read(name, /^[1-9][0-9]{0,20}$/);
  const login = (name: string) => read(name, /^[A-Za-z0-9._-]{1,120}$/);
  const result: SyncAppContext = {
    ...context,
    platform: service,
    proxyOrigin: origin,
    kind: publicSource ? (kind === 'public' ? 'public' : 'mirror') : kind,
  };

  if (publicSource) {
    const kindProperty = h.properties?.['syncable-node-kind'];
    if (
      key.length !== 5 ||
      Object.hasOwn(config, 'connectionId') ||
      !kindProperty ||
      resource.get(kindProperty) !== kind
    )
      throw new Error('Invalid public source binding');
    result.mode = 'public';
    if (kind === 'public' && identity === 'github-public' && collection === '')
      return result;
  } else {
    if (origin !== getIntegrationProxy())
      throw new Error(
        'Select this integration proxy in Settings before syncing',
      );
    result.connectionId = read('connectionId', /^[A-Za-z0-9_-]{1,256}$/);
    if (key.length === 6 && connection !== result.connectionId)
      throw new Error('The Sync account does not match its source');
    if (
      kind === 'organizations' &&
      key.length === 5 &&
      identity === result.connectionId
    )
      return result;
  }

  result.ownerId = id('ownerId');
  result.ownerLogin = login('ownerLogin');

  if (
    kind === 'repositories' &&
    identity === 'github-owner:' + result.ownerId
  ) {
    if (selection) {
      const row = await store.getResource(selection);
      const classes = row.get(core.properties.isA);
      if (
        row.error ||
        !subjectsReferToSameResource(row.get(core.properties.parent), table) ||
        !Array.isArray(classes) ||
        !classes.includes(h.classes?.['syncable-repository'] ?? '')
      )
        throw new Error('Select a repository from this table');
      result.selection = selection;
    }

    return result;
  }

  result.repoId = id('repoId');
  result.repoName = login('repoName');
  if (
    result.kind !== 'mirror' ||
    collection !== 'issues' ||
    identity !==
      (publicSource ? 'github-public-repo:' : 'github-repo:') + result.repoId
  )
    throw new Error('Invalid Issues source binding');

  return result;
}

/** Credentials stay in the existing proxy client. This callback grants only
 * read-only HTTP routes for the host-selected connection and collection. */
export function syncProxyTransport(
  proxy: ProxyConnections,
  context: SyncAppContext,
  assertCurrent: () => void,
): ProxyHost {
  return {
    origin: context.proxyOrigin,
    capability: async () => {
      throw new Error('This app uses host-held connection keys');
    },
    connections: async platform => {
      assertCurrent();
      if (platform !== context.platform)
        throw new Error('Wrong integration platform');
      const connections = await proxy.listKeyed(platform);
      assertCurrent();

      return connections
        .filter(
          row =>
            context.kind === 'platform' ||
            row.connection_id === context.connectionId,
        )
        .map(row => ({ connectionId: row.connection_id, platform }));
    },
    request: async (request, signal?: AbortSignal) => {
      assertCurrent();
      if (
        (request.method !== undefined && request.method !== 'GET') ||
        request.body !== undefined ||
        request.platform !== context.platform
      )
        throw new Error('Only the selected read-only provider is available');
      const path =
        typeof request.path === 'string' ? request.path.replace(/^\//, '') : '';
      const query =
        request.query &&
        typeof request.query === 'object' &&
        !Array.isArray(request.query)
          ? (request.query as Record<string, unknown>)
          : {};
      if (
        Object.keys(query).some(
          key => !['page', 'per_page', 'state', 'after'].includes(key),
        )
      )
        throw new Error('Unsupported provider query');
      const url = new URL('https://api.github.com/' + path);
      if (
        url.origin !== 'https://api.github.com' ||
        url.search ||
        url.hash ||
        path.split('/').some(segment => segment === '.' || segment === '..') ||
        path.includes('%')
      )
        throw new Error('Invalid provider path');
      const page = query.page === undefined ? 1 : Number(query.page);
      const limit = context.mode === 'public' ? 40 : 20;
      if (
        !Number.isInteger(page) ||
        page < 1 ||
        page > limit ||
        (query.per_page !== undefined && String(query.per_page) !== '100') ||
        (query.state !== undefined && query.state !== 'all') ||
        (query.after !== undefined &&
          (typeof query.after !== 'string' || query.after.length > 1024))
      )
        throw new Error('Invalid provider pagination');
      for (const [key, value] of Object.entries(query))
        url.searchParams.set(key, String(value));
      let response: {
        status: number;
        body: unknown;
        headers: Record<string, string>;
      };

      if (context.mode === 'public') {
        if (
          request.connectionId !== undefined ||
          !(context.kind === 'public'
            ? /^repos\/[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/.test(path) &&
              !Object.keys(query).length
            : path === 'repositories/' + context.repoId + '/issues')
        )
          throw new Error('This public source cannot read that endpoint');
        const http = await fetch(url, {
          method: 'GET',
          credentials: 'omit',
          redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(15_000)])
            : AbortSignal.timeout(15_000),
          headers: { Accept: 'application/vnd.github+json' },
        });
        const text = await readLimitedResponseText(http, 'GitHub');
        response = {
          status: http.status,
          body: text ? JSON.parse(text) : null,
          headers: {},
        };

        for (const key of ['link', 'retry-after', 'etag', 'content-type']) {
          const value = http.headers.get(key);
          if (value) response.headers[key] = value;
        }
      } else {
        const slot =
          context.kind === 'platform'
            ? request.connectionId
            : context.connectionId;
        if (typeof slot !== 'string' || request.connectionId !== slot)
          throw new Error('Wrong integration account');
        const allowed =
          context.kind === 'platform'
            ? path === 'user' && page === 1
            : context.kind === 'organizations'
              ? ['user', 'user/orgs', 'user/repos'].includes(path)
              : context.kind === 'repositories'
                ? path === 'user/repos'
                : path === 'repositories/' + context.repoId + '/issues';
        if (
          !allowed ||
          (query.after !== undefined && context.kind !== 'mirror')
        )
          throw new Error('This source cannot read that endpoint');
        const active = await proxy.activeKeyedConnection(
          context.platform,
          slot,
        );
        assertCurrent();
        const target = new URL(
          '/proxy/' +
            encodeURIComponent(active) +
            '/' +
            context.platform +
            '/' +
            path,
          context.proxyOrigin,
        );
        target.search = url.search;
        response = await proxy.readKeyed(target, signal);

        if (path === 'user' && response.status === 200) {
          const id = (response.body as { id?: unknown } | null)?.id;
          if (typeof id !== 'number' || !Number.isSafeInteger(id) || id <= 0)
            throw new Error('Invalid GitHub account identity');
          await proxy.rememberKeyedGithubPrincipal(slot, id);
        }
      }

      assertCurrent();

      return {
        status: response.status,
        headers: response.headers,
        text: JSON.stringify(response.body),
      };
    },
  };
}

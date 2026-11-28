// @wc-ignore-file
import {
  core,
  dataBrowser,
  findSchema,
  ensureSchema,
  readConnectionSubjects,
  subjectsReferToSameResource,
  type Store,
} from '@tomic/lib';
import {
  describeAuthenticatedPrincipals,
  describeCollections,
  prepareDocument,
  resolveAuthenticatedPrincipal,
  validatePrincipalRead,
  type OpenApiDocument,
} from 'syncables/browser';
import type { AppFrameProfile } from '@chunks/AppPage/AppFrame';
import { getIntegrationProxy } from '@helpers/integrationProxy';
import { ProxyConnections } from '@helpers/proxyConnections';
import {
  principalIdentity,
  sourceKey,
  type SyncablePrincipal,
} from './builtinSyncIdentity';
import { fetchSyncableDocument } from './syncableDocument';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  assertSyncableResourceActive,
  classifySyncableResourceDrive,
  queueSyncableProvisioning,
  syncablePlatformSchema,
} from './syncablePlatform';
import {
  ensureSyncablePrincipalApp,
  listSyncablePrincipalApps,
  type SyncablePrincipalAppRef,
} from './syncablePrincipalApp';

export type PrincipalChoice =
  | { kind: 'public' }
  | { kind: 'authenticated'; connectionId: string };

export interface PrincipalChooserContext {
  subject: string;
  platform: string;
  publicAvailable: boolean;
  preferredConnectionId?: string;
  principalApps: readonly SyncablePrincipalAppRef[];
}

function principalChoice(raw: unknown): PrincipalChoice {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Choose a connected account or Public');
  const { kind, connectionId } = raw as Record<string, unknown>;
  if (kind === 'public' && connectionId === undefined) return { kind };
  if (
    kind === 'authenticated' &&
    typeof connectionId === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(connectionId)
  )
    return { kind, connectionId };

  throw new Error('Choose a valid connected account');
}

/** Each request is rebuilt from the current catalog, never from data supplied by the frame. */
async function verifyPrincipal(
  proxy: ProxyConnections,
  platform: string,
  origin: string,
  document: OpenApiDocument,
  connectionId: string,
  assertCurrent: () => void,
  signal: AbortSignal,
) {
  const slots = await proxy.listKeyed(platform);
  assertCurrent();
  if (!slots.some(slot => slot.connection_id === connectionId))
    throw new Error('Unknown keyed integration connection');
  const descriptors = describeAuthenticatedPrincipals(document);
  if (descriptors.length !== 1)
    throw new Error('Unknown or ambiguous authenticated principal');
  const { operationId } = descriptors[0];
  const active = await proxy.activeKeyedConnection(platform, connectionId);

  const assertConnection = async () => {
    assertCurrent();
    if ((await proxy.activeKeyedConnection(platform, connectionId)) !== active)
      throw new Error(
        'The integration connection changed; reopen this service',
      );
    assertCurrent();
  };

  const resolved = await resolveAuthenticatedPrincipal(document, {
    operationId,
    transport: async request => {
      await assertConnection();
      if (!validatePrincipalRead(document, request, { operationId }))
        throw new Error('Invalid authenticated principal operation');
      const target = new URL(
        '/proxy/' +
          encodeURIComponent(active) +
          '/' +
          platform +
          request.url.pathname,
        origin,
      );
      target.search = request.url.search;
      const response = await proxy.readKeyed(target, signal, {
        method: request.method as 'GET' | 'POST',
        ...(request.body === undefined ? {} : { body: request.body }),
      });
      await assertConnection();
      if (response.status === 401)
        throw new Error(
          'This connection has expired. Connect the account again to restore access.',
        );

      return { ...response, body: JSON.stringify(response.body) };
    },
  });
  const principal = principalIdentity(resolved);
  if (principal.kind !== 'authenticated')
    throw new Error('The catalog did not prove an authenticated account');
  await assertConnection();
  await proxy.rememberKeyedPrincipal(
    platform,
    connectionId,
    principal,
    operationId,
  );
  await assertConnection();

  return {
    principal,
    name: resolved.claims.name ?? String(resolved.subject),
    assertConnection,
  };
}

export async function appProfile(
  store: Store,
  drive: string,
  setup: string,
  signal: AbortSignal,
): Promise<AppFrameProfile> {
  const actor = store.getAgent();
  if (!actor?.subject) throw new Error('Sign in to use connected services');
  const server = store.getServerUrl();
  const origin = getIntegrationProxy();

  const assertSession = () => {
    signal.throwIfAborted();
    if (
      store.getAgent() !== actor ||
      store.getServerUrl() !== server ||
      getIntegrationProxy() !== origin
    )
      throw new Error('The integration source, account or server changed');
  };

  await assertSyncableResourceActive(store, drive, setup);
  const schema = await findSchema(store, drive, syncablePlatformSchema());
  const hierarchy = await ensureSchema(store, drive, syncableHierarchySchema());
  const row = await store.getResource(setup);
  assertSession();
  if (row.error) throw row.error;
  const platform = row.get(schema.properties?.['syncable-platform-id'] ?? '');
  const proxyOrigin = row.get(
    schema.properties?.['syncable-proxy-origin'] ?? '',
  );
  if (typeof platform !== 'string' || proxyOrigin !== origin)
    throw new Error(
      'Select this integration proxy in Settings before connecting an account',
    );
  const stamp = () =>
    JSON.stringify([
      row.get(core.properties.parent),
      row.get(core.properties.localId),
      row.get(core.properties.isA),
      Object.values(schema.properties ?? {}).map(property => row.get(property)),
    ]);
  const initial = stamp();

  const assertCurrent = () => {
    assertSession();
    if (row.error || stamp() !== initial)
      throw new Error('The integration setup changed; reopen this service');
  };

  const assertSetup = async () => {
    assertCurrent();
    await assertSyncableResourceActive(store, drive, setup);
    assertCurrent();
  };

  const assertWritable = async () => {
    await assertSetup();
    const [allowed] = await row.canWrite(actor.subject);
    await assertSetup();
    if (!allowed)
      throw new Error('Write access to this integration setup is required');
  };

  const proxy = new ProxyConnections(localStorage, origin, () =>
    store.getAgent(),
  );
  const catalog = await fetchSyncableDocument(origin, signal, platform);
  const document = prepareDocument(catalog.document);
  const publicAvailable = describeCollections(document).some(
    item =>
      item.allowsAnonymous ||
      item.entrypoints.some(entry => entry.allowsAnonymous),
  );
  const scope = { drive, proxyOrigin: origin, platform, assertCurrent };
  const apps = await listSyncablePrincipalApps(store, scope);
  const handoffScope = { drive, app: setup, appAgent: actor.subject };
  const preferredConnectionId = await proxy.preferredKeyedConnection(
    handoffScope,
    platform,
  );
  await assertSetup();

  const { classes = {}, properties = {} } = hierarchy;
  const keyProperty = properties['syncable-source-key'];
  const configProperty = properties['syncable-source-config'];
  const kindProperty = properties['syncable-node-kind'];

  const candidateFor = (
    principal: SyncablePrincipal,
    name: string,
    connectionId?: string,
  ) =>
    queueSyncableProvisioning(store, drive, async () => {
      await assertWritable();
      const key = sourceKey({ ...scope, kind: 'principal', principal });
      const subjects = await readConnectionSubjects(
        store,
        drive,
        keyProperty,
        key,
        { includeTrashed: true },
      );
      assertCurrent();
      const inDrive: string[] = [];

      for (const subject of subjects) {
        if (await classifySyncableResourceDrive(store, drive, subject)) {
          await assertSyncableResourceActive(store, drive, subject);
          inDrive.push(subject);
        }

        assertCurrent();
      }

      if (inDrive.length > 1)
        throw new Error(
          'This principal has conflicting Apps; review the existing copies',
        );
      if (inDrive.length === 1) return inDrive[0];

      const created = await store.newResource({
        parent: setup,
        deferGenesis: true,
        isA: [dataBrowser.classes.table, classes['syncable-principal']],
        propVals: {
          [core.properties.name]: name,
          [core.properties.localId]:
            'syncables:node:' + encodeURIComponent(key),
          [core.properties.classtype]: dataBrowser.classes.table,
          [keyProperty]: key,
          [kindProperty]: 'principal',
          [configProperty]: {
            version: 2,
            proxyOrigin: origin,
            platform,
            principal,
            ...(connectionId ? { connectionId } : {}),
          },
        },
      });
      await assertWritable();
      await created.save();
      assertCurrent();

      return created.subject;
    });

  return {
    source: server + '/builtin-syncables-ui?format=html',
    context: {
      subject: setup,
      platform,
      publicAvailable,
      preferredConnectionId,
      principalApps: apps,
    } satisfies PrincipalChooserContext,
    access: { root: setup, signal, assertCurrent },
    proxy: {
      connections: async requestedPlatform => {
        await assertSetup();
        if (requestedPlatform !== platform)
          throw new Error('Wrong integration platform');
        const rows = await proxy.listKeyed(platform);
        const summaries = await Promise.all(
          rows.map(async connection => ({
            connectionId: connection.connection_id,
            platform,
            ...(connection.label
              ? {
                  label: connection.label
                    .replace(/\p{Cc}/gu, '')
                    .trim()
                    .slice(0, 120),
                }
              : {}),
            canReconnect: await proxy.canReconnectKeyed(
              platform,
              connection.connection_id,
            ),
          })),
        );
        await assertSetup();

        return summaries;
      },
    },
    connect: async (requestedPlatform, connectionId) => {
      await assertWritable();
      if (requestedPlatform !== platform)
        throw new Error('Wrong integration platform');

      if (connectionId !== undefined) {
        const choice = principalChoice({ kind: 'authenticated', connectionId });
        if (
          choice.kind !== 'authenticated' ||
          !(await proxy.canReconnectKeyed(platform, choice.connectionId))
        )
          throw new Error('Unknown saved connection');
        await assertWritable();

        return proxy.startKeyedReconnect(
          handoffScope,
          platform,
          connectionId,
          location.href,
          'Atomic Syncables',
        );
      }

      return proxy.startKeyed(
        handoffScope,
        platform,
        location.href,
        'Atomic Syncables',
      );
    },
    prepareOpenResource: async (subject, rawChoice) => {
      await assertSetup();

      if (rawChoice === undefined) {
        const current = await listSyncablePrincipalApps(store, scope);
        await assertSetup();
        if (
          !current.some(app =>
            subjectsReferToSameResource(app.subject, subject),
          )
        )
          throw new Error(
            'The saved principal App changed; reopen this service',
          );

        return subject;
      }

      if (!subjectsReferToSameResource(subject, setup))
        throw new Error('Select a principal for this setup');
      const choice = principalChoice(rawChoice);
      if (choice.kind === 'public' && !publicAvailable)
        throw new Error('This catalog does not permit a Public App');
      const proof =
        choice.kind === 'authenticated'
          ? await verifyPrincipal(
              proxy,
              platform,
              origin,
              document,
              choice.connectionId,
              assertCurrent,
              signal,
            )
          : undefined;
      const principal: SyncablePrincipal = proof?.principal ?? {
        kind: 'public',
      };
      const connectionId =
        choice.kind === 'authenticated' ? choice.connectionId : undefined;
      const source = await candidateFor(
        principal,
        proof?.name ?? 'Public',
        connectionId,
      );
      await proof?.assertConnection();
      const info = document.info as { title?: unknown } | undefined;
      const destination = await ensureSyncablePrincipalApp(store, {
        ...scope,
        setup,
        subject: source,
        principal,
        providerName: typeof info?.title === 'string' ? info.title : platform,
        ...(connectionId ? { connectionId } : {}),
      });
      await proof?.assertConnection();
      if (connectionId === preferredConnectionId && connectionId !== undefined)
        await proxy.consumePreferredKeyedConnection(
          handoffScope,
          platform,
          connectionId,
        );
      assertCurrent();

      return destination;
    },
  };
}

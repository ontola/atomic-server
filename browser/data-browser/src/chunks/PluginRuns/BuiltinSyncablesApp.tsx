import { useEffect, useState } from 'react';
import { core, findSchema, pluginSchema } from '@tomic/lib';
import {
  prepareDocument,
  describeCollections,
  describeAuthenticatedPrincipals,
  type QuerySelection,
} from 'syncables/browser';
import {
  useCurrentAgent,
  useServerURL,
  useStore,
  type Store,
} from '@tomic/react';
import {
  getIntegrationProxy,
  useIntegrationProxy,
} from '@helpers/integrationProxy';
import { AtomicLink } from '@components/AtomicLink';
import { findSyncablePlatform } from './syncablePlatform';
import { collectSyncableLegacySources } from './syncableLegacy';
import { ProxyConnections } from '@helpers/proxyConnections';
import { AppFrame, type AppFrameProfile } from '@chunks/AppPage/AppFrame';
import {
  useAppExecutions,
  type AppExecutionRegistry,
  type AppExecutionSpec,
} from '@chunks/AppPage/AppExecutionRuntime';
import { ShowRoute } from '../../routes/ShowRoute';
import { fetchSyncableDocument } from './syncableDocument';
import { syncableApiSchema } from './syncableApiSchema';
import { sourceConfigFingerprint } from './builtinSyncIdentity.js';
import {
  assertSyncAppDrive,
  assertSyncAppContext,
  canonicalSyncAppContext,
  syncAppContext,
  syncProxyTransport,
} from './builtinSyncablesProfile';

const executionKey = (drive: string, table: string) =>
  JSON.stringify([drive, table]);

/** Only installation/schema bootstrap and capability composition live here.
 * The bundled app owns provider discovery and Atomic data reconciliation. */
// @wc-ignore
export async function appProfile(
  store: Store,
  drive: string,
  table: string,
  registry: AppExecutionRegistry,
  signal: AbortSignal,
  worker = false,
  selection?: string,
): Promise<AppExecutionSpec> {
  const actor = store.getAgent();
  if (!actor?.subject) throw new Error('Sign in to use connected services');
  const actorSubject = actor.subject;
  const server = store.getServerUrl();
  const origin = getIntegrationProxy();
  let context = await syncAppContext(store, drive, table, !worker, selection);
  const resource = await store.getResource(table);
  const p = context.schema.properties;
  const sourceStamp = () =>
    JSON.stringify([
      resource.get(p['syncable-source-key']),
      resource.get(p['syncable-source-config']),
      resource.get(p['syncable-platform-id']),
      resource.get(p['syncable-proxy-origin']),
    ]);
  const stamp = sourceStamp();

  const assertAuthority = () => {
    assertSyncAppDrive(store, drive, table);
    assertSyncAppContext(context);
    if (
      store.getAgent() !== actor ||
      store.getServerUrl() !== server ||
      getIntegrationProxy() !== origin ||
      sourceStamp() !== stamp
    )
      throw new Error('The integration source, account or server changed');
  };

  const assertCurrent = () => {
    signal.throwIfAborted();
    assertAuthority();
  };

  assertCurrent();

  const status = () => {
    const raw = resource.get(p['syncable-mirror-status']);

    return raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  };

  const proxy = new ProxyConnections(localStorage, origin, () =>
    store.getAgent(),
  );
  // Only the configured proxy's current catalog can authorize a provider read.
  // Editable saved metadata remains presentation data, never additional authority.
  const metadata = await fetchSyncableDocument(
    context.proxyOrigin,
    signal,
    context.platform,
  );
  const document = prepareDocument(metadata.document);
  const trusted = {
    document,
    querySelection: metadata.querySelection as QuerySelection | undefined,
  };
  const principalDescriptions = describeAuthenticatedPrincipals(document);
  context = canonicalSyncAppContext(context, trusted);
  const installationApp = await findSyncablePlatform(store, {
    drive,
    platform: context.platform,
    proxyOrigin: context.proxyOrigin,
  });
  assertCurrent();
  if (!installationApp)
    throw new Error(
      'The integration installation is unavailable. Its saved sources were retained.',
    );
  const appSchema = await findSchema(store, drive, pluginSchema());
  assertCurrent();
  const legacy = await collectSyncableLegacySources(store, {
    drive,
    app: installationApp,
    appDataProperty: appSchema.properties?.['app-data'],
    platform: context.platform,
    proxyOrigin: context.proxyOrigin,
    properties: p,
    collections: describeCollections(document),
    currentSourceIsLegacy: context.kind === 'legacy',
    principalDescriptions,
    principalProvenance: async slot => {
      assertCurrent();
      const proof = await proxy.keyedPrincipalProvenance(
        context.platform,
        slot,
      );
      assertCurrent();

      return proof;
    },
  });
  assertCurrent();

  const legacyReconnectPrincipal = async (slot: string) => {
    const candidates = legacy.sources.filter(
      alias =>
        alias.kind === 'principal' &&
        alias.connectionId === slot &&
        alias.principal?.kind === 'authenticated',
    );
    if (candidates.length !== 1) return;
    const alias = candidates[0];
    if (!alias.sourceKey || !alias.localId || !alias.sourceConfigFingerprint)
      return;
    const row = await store.getResource(alias.subject);

    const assertAliasCurrent = () => {
      assertCurrent();
      assertSyncAppDrive(store, drive, alias.subject);
      if (
        row.get(p['syncable-source-key']) !== alias.sourceKey ||
        row.get(core.properties.localId) !== alias.localId ||
        sourceConfigFingerprint(row.get(p['syncable-source-config'])) !==
          alias.sourceConfigFingerprint
      )
        throw new Error(
          'The saved account source changed; reopen the integration App',
        );
    };

    assertAliasCurrent();
    const principal = alias.principal;
    if (principal?.kind !== 'authenticated') return;
    const eligible = await proxy.canReconnectLegacyKeyed(
      context.platform,
      slot,
      principal,
      principalDescriptions,
    );
    assertAliasCurrent();

    return eligible
      ? { principal, assertCurrent: assertAliasCurrent }
      : undefined;
  };

  if (context.kind === 'legacy') {
    const error = new Error(
      'This saved source needs migration from its integration App. Moved resources are retained and no replacement will be created from this view.',
    );
    Object.assign(error, { installationApp });
    throw error;
  }

  const apiSchema = await syncableApiSchema(
    store,
    drive,
    context.proxyOrigin,
    context.platform,
    metadata.document,
    !worker,
    assertCurrent,
  );
  assertCurrent();
  const key = executionKey(drive, table);
  const profile: AppFrameProfile = {
    source: server + '/builtin-syncables-ui?format=html',
    context: {
      ...context,
      document,
      querySelection: trusted.querySelection,
      apiSchema,
      legacySources: legacy.sources,
      legacyWarnings: legacy.warnings,
      legacyMigrationBlocked: legacy.warnings.length > 0,
      worker,
    },
    access: { root: table, signal, assertCurrent },
    proxy: syncProxyTransport(
      proxy,
      context,
      assertCurrent,
      trusted,
      () => {
        if (status().paused === true)
          throw new Error('Resume this collection before syncing');
      },
      async slot => !!(await legacyReconnectPrincipal(slot)),
    ),
    execution: async action => {
      assertCurrent();

      if (worker) {
        if (action !== 'state')
          throw new Error('An execution cannot start another execution');
        registry.ready(key, signal);
      } else if (action === 'cancel') registry.cancel(key);
      else if (action === 'start') {
        if (status().paused === true)
          throw new Error('Resume this collection before syncing');
        const [canWrite] = await resource.canWrite(actorSubject);
        assertCurrent();
        if (!canWrite)
          throw new Error('Write access to this table is required');
        if (context.kind !== 'collection')
          throw new Error('Select a collection to sync');
        await registry.start(key, async runSignal =>
          appProfile(store, drive, table, registry, runSignal, true),
        );
      }

      return { running: registry.isRunning(key) };
    },
    ...(!worker && context.mode !== 'public'
      ? {
          connect: async (platform: string, requestedConnectionId?: string) => {
            assertCurrent();
            if (platform !== context.platform)
              throw new Error('Wrong integration platform');
            if (
              requestedConnectionId !== undefined &&
              (typeof requestedConnectionId !== 'string' ||
                !/^[A-Za-z0-9_-]{43}$/.test(requestedConnectionId))
            )
              throw new Error('Invalid saved connection');
            if (
              context.connectionId &&
              requestedConnectionId !== undefined &&
              requestedConnectionId !== context.connectionId
            )
              throw new Error('Wrong source connection');
            const scope = { drive, app: table, appAgent: actorSubject };
            const connectionId = context.connectionId ?? requestedConnectionId;

            if (connectionId) {
              if (!context.connectionId) {
                if (context.kind !== 'platform')
                  throw new Error('Connect accounts from the integration App');
                const rows = await proxy.listKeyed(platform);
                assertCurrent();
                if (
                  !rows.some(
                    row =>
                      row.connection_id === connectionId &&
                      row.platform === platform,
                  )
                )
                  throw new Error('Unknown saved connection');
              }

              const canReconnect = await proxy.canReconnectKeyed(
                context.platform,
                connectionId,
              );
              assertCurrent();

              if (!canReconnect) {
                const legacyReconnect =
                  await legacyReconnectPrincipal(connectionId);
                if (legacyReconnect) {
                  await proxy.prepareLegacyKeyedReconnect(
                    context.platform,
                    connectionId,
                    legacyReconnect.principal,
                    principalDescriptions,
                    legacyReconnect.assertCurrent,
                  );
                  assertCurrent();
                } else
                  throw new Error(
                    'Open the integration App to reconnect this account',
                  );
              }

              assertCurrent();

              const handoff = await proxy.startKeyedReconnect(
                scope,
                context.platform,
                connectionId,
                location.href,
                'Atomic Syncables',
              );
              assertCurrent();

              return handoff;
            }

            if (context.kind !== 'platform')
              throw new Error('Connect accounts from the integration App');

            const handoff = await proxy.startKeyed(
              scope,
              platform,
              location.href,
              'Atomic Syncables',
            );
            assertCurrent();

            return handoff;
          },
        }
      : {}),
  };

  return {
    app: table,
    drive,
    table,
    profile,
    subscribe: cancel =>
      store.subscribe(table, () => {
        try {
          assertAuthority();
          if (status().paused === true) cancel();
        } catch {
          cancel();
        }
      }),
    failed: async (message, reportingSignal) => {
      const assertReporting = () => {
        reportingSignal.throwIfAborted();
        assertAuthority();
        if (status().paused === true)
          throw new Error('This collection was paused');
      };

      assertReporting();
      await resource.set(
        p['syncable-mirror-status'],
        {
          ...status(),
          error: message.slice(0, 1024),
        },
        true,
        undefined,
        assertReporting,
      );
      assertReporting();
      await resource.save();
    },
  };
}

export function BuiltinSyncablesApp({
  table,
  drive,
}: {
  table: string;
  drive: string;
}) {
  const store = useStore();
  const [actor] = useCurrentAgent();
  const [server] = useServerURL();
  const origin = useIntegrationProxy();
  const selection = ShowRoute.useSearch({ select: search => search.syncRow });
  const registry = useAppExecutions();
  const [loaded, setLoaded] = useState<{
    table: string;
    drive: string;
    selection?: string;
    profile: AppFrameProfile;
  }>();
  const [error, setError] = useState<{
    message: string;
    installationApp?: string;
  }>();
  useEffect(() => {
    if (!registry) return;
    const controller = new AbortController();
    void appProfile(
      store,
      drive,
      table,
      registry,
      controller.signal,
      false,
      selection,
    )
      .then(spec => {
        if (!controller.signal.aborted) {
          setError(undefined);
          setLoaded({ table, drive, selection, profile: spec.profile });
        }
      })
      .catch(reason => {
        if (!controller.signal.aborted)
          setError({
            message: String(reason.message ?? reason),
            ...(typeof reason.installationApp === 'string'
              ? { installationApp: reason.installationApp }
              : {}),
          });
      });

    return () => controller.abort();
  }, [store, drive, table, selection, registry, actor, server, origin]);
  if (error)
    return (
      <div role='alert'>
        <p>{error.message}</p>
        {error.installationApp && (
          <AtomicLink subject={error.installationApp}>
            Open integration App
          </AtomicLink>
        )}
      </div>
    );
  if (
    !loaded ||
    loaded.table !== table ||
    loaded.drive !== drive ||
    loaded.selection !== selection
  )
    return <p role='status'>Opening Sync…</p>;

  return (
    <AppFrame
      key={JSON.stringify([drive, table, selection])}
      app={table}
      drive={drive}
      table={table}
      profile={loaded.profile}
    />
  );
}

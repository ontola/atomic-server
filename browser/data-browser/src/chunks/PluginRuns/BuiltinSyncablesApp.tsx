import { useEffect, useState } from 'react';
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
import { ProxyConnections } from '@helpers/proxyConnections';
import { AppFrame, type AppFrameProfile } from '@chunks/AppPage/AppFrame';
import {
  useAppExecutions,
  type AppExecutionRegistry,
  type AppExecutionSpec,
} from '@chunks/AppPage/AppExecutionRuntime';
import { ShowRoute } from '../../routes/ShowRoute';
import {
  assertSyncAppDrive,
  syncAppContext,
  syncProxyTransport,
} from './builtinSyncablesProfile';

const executionKey = (drive: string, table: string) =>
  JSON.stringify([drive, table]);

/** Only installation/schema bootstrap and capability composition live here.
 * The bundled app owns provider discovery and Atomic data reconciliation. */
async function appProfile(
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
  const context = await syncAppContext(store, drive, table, !worker, selection);
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
  const key = executionKey(drive, table);
  const profile: AppFrameProfile = {
    source: server + '/builtin-syncables-ui?format=html',
    context: { ...context, worker },
    access: { root: table, signal, assertCurrent },
    proxy: syncProxyTransport(proxy, context, () => {
      assertCurrent();
      if (status().paused === true)
        throw new Error('Resume this collection before syncing');
    }),
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
        if (!['organizations', 'repositories', 'mirror'].includes(context.kind))
          throw new Error('Select a collection to sync');
        await registry.start(key, async runSignal =>
          appProfile(store, drive, table, registry, runSignal, true),
        );
      }

      return { running: registry.isRunning(key) };
    },
    ...(!worker && context.mode !== 'public'
      ? {
          connect: async (platform: string) => {
            assertCurrent();
            if (platform !== context.platform)
              throw new Error('Wrong integration platform');
            const scope = { drive, app: table, appAgent: actorSubject };

            if (context.connectionId) {
              if (!(await proxy.canReconnectGithub(context.connectionId)))
                throw new Error(
                  'Connect this account from GitHub’s platform table',
                );
              assertCurrent();

              return proxy.startKeyedReconnect(
                scope,
                context.connectionId,
                location.href,
                'Atomic Syncables',
              );
            }

            if (context.kind !== 'platform')
              throw new Error('Connect accounts from the platform table');

            return proxy.startKeyed(
              scope,
              platform,
              location.href,
              'Atomic Syncables',
            );
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
  const [error, setError] = useState<string>();
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
          setError(String(reason.message ?? reason));
      });

    return () => controller.abort();
  }, [store, drive, table, selection, registry, actor, server, origin]);
  if (error) return <p role='alert'>{error}</p>;
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

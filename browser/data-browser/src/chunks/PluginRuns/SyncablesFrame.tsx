import { useEffect, useMemo, useRef, useState } from 'react';
import { useCurrentAgent, useServerURL, useStore } from '@tomic/react';
import { FrameBridge } from '@helpers/extensions/FrameBridge';
import { viewSession } from '@helpers/extensions/viewSession';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { constructOpenURL } from '@helpers/navigation';
import {
  useCreateThemeVars,
  useFrameColorScheme,
} from '@views/PluginView/useCreateThemeVars';
import resetCss from '../../reset.css?raw';
import {
  getIntegrationProxy,
  useIntegrationProxy,
} from '@helpers/integrationProxy';
import { ProxyConnections } from '@helpers/proxyConnections';
import { ConnectDialog } from '@chunks/AppPage/ConnectDialog';
import {
  syncablesHostRequest,
  type BuiltinSyncablesRequest,
  type SyncablesDiscovery,
} from './syncablesHost';
import { useSyncablesRuntime, type SyncablesRun } from './SyncablesRuntime';

/** Operations only the built-in Syncables frame may send. */
const SYNCABLES_OPERATIONS = new Set([
  'syncablesContext',
  'syncablesAccounts',
  'syncablesConnect',
  'syncablesRead',
  'syncablesOpenAccount',
  'syncablesDiscoverOwners',
  'syncablesOpenOwner',
  'syncablesOpenPublic',
  'syncablesLinkPublicRepository',
  'syncablesDiscoverRepos',
  'syncablesCreateMirror',
  'syncablesMirrorStatus',
  'syncablesSetPaused',
  'syncablesImportIssues',
  'syncablesRecordSuccess',
  'syncablesRecordFailure',
  'syncablesStartSync',
  'syncablesSyncState',
  'syncablesPauseSync',
  'syncablesSyncFinished',
  'syncablesDirectoryContext',
  'syncablesDirectoryRows',
  'syncablesOpenDirectoryRow',
]);

const WORKER_OPERATIONS = new Set([
  'syncablesContext',
  'syncablesRead',
  'syncablesMirrorStatus',
  'syncablesImportIssues',
  'syncablesRecordSuccess',
  'syncablesRecordFailure',
  'syncablesSyncFinished',
]);
const SYNC_OPERATIONS = new Set([
  'syncablesContext',
  'syncablesMirrorStatus',
  'syncablesConnect',
  'syncablesStartSync',
  'syncablesSyncState',
  'syncablesPauseSync',
  'syncablesSetPaused',
  'syncablesAccounts',
  'syncablesRead',
  'syncablesDiscoverOwners',
  'syncablesDiscoverRepos',
  'syncablesOpenAccount',
  'syncablesOpenPublic',
]);
const DIRECTORY_OPERATIONS = new Set([
  'syncablesContext',
  'syncablesDirectoryContext',
  'syncablesDirectoryRows',
  'syncablesOpenDirectoryRow',
  'syncablesAccounts',
  'syncablesConnect',
  'syncablesRead',
  'syncablesOpenAccount',
  'syncablesDiscoverOwners',
  'syncablesOpenOwner',
  'syncablesOpenPublic',
  'syncablesLinkPublicRepository',
  'syncablesDiscoverRepos',
  'syncablesCreateMirror',
]);

export type SyncablesPresentation = 'sync' | 'directory' | 'worker';

/** Initialization has to reach the scoped context handshake to start a run. */
export function watchSyncablesWorkerStartup(
  fail: (message: string) => void,
  timeoutMs = 30_000,
) {
  let closed = false;

  const error = (message: string) => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    fail(message);
  };

  const timer = setTimeout(
    () =>
      error('Could not start the Syncables sync worker. Try Sync now again.'),
    timeoutMs,
  );

  return {
    ready: () => clearTimeout(timer),
    error,
    close: () => {
      closed = true;
      clearTimeout(timer);
    },
  };
}

export function syncablesFrameError(wire: unknown): string | undefined {
  if (!wire || typeof wire !== 'object' || !('type' in wire)) return;
  if (wire.type !== '__atomic_plugin_error') return;

  return 'message' in wire && typeof wire.message === 'string' && wire.message
    ? wire.message.slice(0, 1024)
    : 'Could not initialize the Syncables view';
}

export function isSyncablesPresentationOperation(
  presentation: SyncablesPresentation,
  operation: string,
): boolean {
  if (presentation === 'worker') return WORKER_OPERATIONS.has(operation);
  if (presentation === 'sync') return SYNC_OPERATIONS.has(operation);

  return DIRECTORY_OPERATIONS.has(operation);
}

/**
 * The public view protocol intentionally does not advertise privileged
 * Syncables actions. Recognize them at this *one* first-party frame boundary,
 * then give them the same canonical reply/session encoding as ordinary view
 * requests. Every operation still has its own host-side scope check.
 */
export function isBuiltinSyncablesRequest(wire: unknown): wire is {
  type: 'atomic.view.request';
  version: 1;
  id: string;
  op: string;
  args: Record<string, unknown>;
} {
  if (!wire || typeof wire !== 'object') return false;
  const data = wire as Record<string, unknown>;

  return (
    data.type === 'atomic.view.request' &&
    data.version === 1 &&
    typeof data.id === 'string' &&
    /^syncables:[1-9][0-9]*$/.test(data.id) &&
    typeof data.op === 'string' &&
    SYNCABLES_OPERATIONS.has(data.op) &&
    !!data.args &&
    typeof data.args === 'object' &&
    !Array.isArray(data.args)
  );
}

/**
 * The first-party Syncables module is served from Atomic Server, but remains
 * in the same null-origin, CSP-sandboxed iframe as third-party app views.
 * Only this host recognizes the narrow syncables provisioning operations.
 * No generic app is granted drive-root write access.
 */
export function SyncablesFrame({
  table,
  drive,
  presentation = 'sync',
  worker,
}: {
  table: string;
  drive: string;
  presentation?: SyncablesPresentation;
  worker?: SyncablesRun;
}): React.JSX.Element {
  const store = useStore();
  const [actor] = useCurrentAgent();
  const [server] = useServerURL();
  const origin = useIntegrationProxy();
  const runtime = useSyncablesRuntime();
  const proxy = useMemo(
    () => new ProxyConnections(localStorage, origin, () => store.getAgent()),
    [origin, store],
  );
  const navigate = useNavigateWithTransition();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<FrameBridge | undefined>(undefined);
  const frameFailureRef = useRef<(message: string) => void>(() => undefined);
  const stylesheet = useCreateThemeVars();
  const colorScheme = useFrameColorScheme();
  const [error, setError] = useState('');
  const [ask, setAsk] = useState<{
    cancel: () => void;
    reconnectId?: string;
  }>();
  const askRef = useRef<typeof ask>(undefined);

  const src = !store.noServer
    ? store.getServerUrl() + '/builtin-syncables-ui?format=html'
    : undefined;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !src) return;

    const discovery: SyncablesDiscovery = {
      owners: new Set(),
      repositories: new Map(),
      publicIssuePages: new Map(),
    };
    const active = () =>
      store.getAgent() === actor &&
      store.getServerUrl() === server &&
      getIntegrationProxy() === origin &&
      !worker?.controller.signal.aborted;
    const readContext = (signal?: AbortSignal) =>
      syncablesHostRequest(
        store,
        drive,
        table,
        {
          op:
            presentation === 'directory'
              ? 'syncablesDirectoryContext'
              : 'syncablesContext',
        },
        proxy,
        discovery,
        signal,
      );

    const assertWorker = async (signal?: AbortSignal) => {
      if (!active()) throw new Error('The sync account or server changed');
      if (!worker || !runtime)
        throw new Error('This sync worker is no longer active');

      try {
        runtime.assertActive(worker, await readContext(signal));
      } catch (reason) {
        runtime.finish(worker);
        throw reason;
      }
    };

    let failed = false;
    let failureTimeout: ReturnType<typeof setTimeout> | undefined;

    const reportFailure = (message: string) => {
      setError(message);
      if (!worker || !runtime || failed) return;
      failed = true;
      bridge.close();
      failureTimeout = setTimeout(() => runtime.finish(worker), 10_000);
      const signal = AbortSignal.any([
        worker.controller.signal,
        AbortSignal.timeout(10_000),
      ]);
      void assertWorker(signal)
        .then(() =>
          syncablesHostRequest(
            store,
            drive,
            table,
            { op: 'syncablesRecordFailure', message },
            proxy,
            discovery,
            signal,
          ),
        )
        .catch(() => undefined)
        .finally(() => {
          clearTimeout(failureTimeout);
          runtime.finish(worker);
        });
    };

    const startup = worker
      ? watchSyncablesWorkerStartup(reportFailure)
      : undefined;

    const frameFailure = (message: string) => {
      if (startup) startup.error(message);
      else reportFailure(message);
    };

    frameFailureRef.current = frameFailure;

    const bridge = new FrameBridge(frame, (wire, originalSession) => {
      const failure = syncablesFrameError(wire);

      if (failure) {
        frameFailure(failure);

        return;
      }

      if (!isBuiltinSyncablesRequest(wire)) return;
      const session = viewSession(originalSession, wire.id);
      const controller = new AbortController();
      const signal = worker
        ? AbortSignal.any([controller.signal, worker.controller.signal])
        : controller.signal;
      session.watch(wire.id, () => () => controller.abort());

      const work = async () => {
        const request = {
          ...wire.args,
          op: wire.op,
        } as BuiltinSyncablesRequest;
        if (failed) throw new Error('The sync worker failed to initialize');
        if (!active()) throw new Error('The sync account or server changed');
        if (!isSyncablesPresentationOperation(presentation, request.op))
          throw new Error('This Syncables view cannot perform that operation');
        if (presentation === 'worker') await assertWorker(signal);

        if (presentation === 'sync' && request.op === 'syncablesRead') {
          const source = (await readContext(signal)) as { kind: string };
          if (source.kind === 'mirror')
            throw new Error(
              'Start this mirror sync through its foreground worker',
            );
        }

        if (request.op === 'syncablesSyncFinished') {
          if (worker) runtime?.finish(worker);

          return true;
        }

        if (request.op === 'syncablesContext') {
          const context = await readContext(signal);
          startup?.ready();

          return { ...(context as object), presentation };
        }

        if (request.op === 'syncablesStartSync') {
          if (!runtime) throw new Error('Sync is unavailable in this view');
          await runtime.start(drive, table);

          return true;
        }

        if (request.op === 'syncablesSyncState')
          return { running: runtime?.isRunning(drive, table) ?? false };

        if (request.op === 'syncablesPauseSync') {
          runtime?.cancel(drive, table);

          return syncablesHostRequest(
            store,
            drive,
            table,
            { op: 'syncablesSetPaused', paused: true },
            proxy,
            discovery,
            signal,
          );
        }

        if (request.op === 'syncablesConnect') {
          const context = (await syncablesHostRequest(
            store,
            drive,
            table,
            { op: 'syncablesContext' },
            proxy,
            discovery,
            signal,
          )) as { platform: string; kind: string; connectionId?: string };
          const reconnectId = request.connectionId;
          if (context.platform !== 'github-issues')
            throw new Error('This view does not support GitHub connections');

          if (reconnectId !== undefined) {
            if (
              typeof reconnectId !== 'string' ||
              (context.kind !== 'platform' &&
                reconnectId !== context.connectionId) ||
              !(await proxy.canReconnectGithub(reconnectId))
            )
              throw new Error(
                'Reconnect a verified GitHub account for this view',
              );
          } else if (context.kind !== 'platform') {
            throw new Error(
              'Connect a new GitHub account from its platform table',
            );
          }

          signal.throwIfAborted();

          return await new Promise(resolve => {
            askRef.current?.cancel();
            const pending = {
              cancel: () => resolve({ status: 'cancelled' }),
              reconnectId,
            };
            askRef.current = pending;
            setAsk(pending);
            signal.addEventListener(
              'abort',
              () => {
                pending.cancel();
                if (askRef.current !== pending) return;
                askRef.current = undefined;
                setAsk(undefined);
              },
              { once: true },
            );
          });
        }

        return syncablesHostRequest(
          store,
          drive,
          table,
          request,
          proxy,
          discovery,
          signal,
        );
      };

      void work()
        .then(result => {
          if (!session.isActive() || !active()) return;
          session.post({ result: result ?? true });

          if (
            result &&
            presentation !== 'worker' &&
            typeof result === 'object' &&
            'subject' in result &&
            typeof result.subject === 'string'
          ) {
            navigateRef.current(constructOpenURL(result.subject));
          }
        })
        .catch(reason =>
          session.post({ error: String(reason?.message ?? reason) }),
        )
        .finally(() => session.unwatch(wire.id));
    });

    bridgeRef.current = bridge;
    const unsubscribe = worker
      ? store.subscribe(table, () => {
          void assertWorker(worker.controller.signal)
            .then(async () => {
              const status = (await syncablesHostRequest(
                store,
                drive,
                table,
                { op: 'syncablesMirrorStatus' },
                proxy,
                discovery,
                worker.controller.signal,
              )) as { paused: boolean };
              if (status.paused) runtime?.finish(worker);
            })
            .catch(() => runtime?.finish(worker));
        })
      : undefined;
    const stopWorker = () => bridge.close();
    worker?.controller.signal.addEventListener('abort', stopWorker, {
      once: true,
    });

    return () => {
      startup?.close();
      clearTimeout(failureTimeout);
      if (frameFailureRef.current === frameFailure)
        frameFailureRef.current = () => undefined;
      unsubscribe?.();
      worker?.controller.signal.removeEventListener('abort', stopWorker);
      askRef.current?.cancel();
      askRef.current = undefined;
      setAsk(undefined);
      bridge.close();
      if (bridgeRef.current === bridge) bridgeRef.current = undefined;
    };
  }, [
    src,
    store,
    drive,
    table,
    proxy,
    actor,
    server,
    origin,
    presentation,
    worker,
    runtime,
  ]);

  useEffect(() => {
    bridgeRef.current?.setStyle(resetCss + '\n' + stylesheet, colorScheme);
  }, [stylesheet, colorScheme, src]);

  const finishAsk = () => {
    askRef.current?.cancel();
    askRef.current = undefined;
    setAsk(undefined);
  };

  const connect = async () => {
    const user = store.getAgent();
    if (!user?.subject) throw new Error('Sign in to connect GitHub');
    const scope = { drive, app: table, appAgent: user.subject };
    const reconnectId = askRef.current?.reconnectId;
    const target = reconnectId
      ? await proxy.startKeyedReconnect(
          scope,
          reconnectId,
          location.href,
          'Atomic Syncables',
        )
      : await proxy.startKeyed(
          scope,
          'github-issues',
          location.href,
          'Atomic Syncables',
        );
    location.assign(target);
  };

  if (!src) {
    if (presentation === 'worker') return <></>;

    return (
      <p role='status'>
        Connecting services requires an Atomic Server node. The local table
        remains accessible without a connection.
      </p>
    );
  }

  return (
    <div
      hidden={presentation === 'worker'}
      style={{ width: '100%', minHeight: presentation === 'worker' ? 0 : 280 }}
    >
      {error && <p role='alert'>{error}</p>}
      {ask && (
        <ConnectDialog
          app='Atomic Syncables'
          platform='GitHub'
          proxySite={new URL(origin).host}
          existing={[]}
          onConnect={connect}
          onUseExisting={async () => undefined}
          onClosed={finishAsk}
        />
      )}
      <iframe
        key={JSON.stringify([drive, table, presentation])}
        ref={frameRef}
        src={src}
        title={
          presentation === 'worker'
            ? 'Built-in Syncables sync worker'
            : 'Built-in Syncables collection view'
        }
        sandbox='allow-scripts'
        allow='fullscreen'
        style={{
          display: 'block',
          border: 0,
          width: '100%',
          minHeight: '55vh',
          height: '70vh',
        }}
        onError={() =>
          frameFailureRef.current(
            'Could not load the built-in Syncables iframe',
          )
        }
      />
    </div>
  );
}

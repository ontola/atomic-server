import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '@tomic/react';
import { FrameBridge } from '@helpers/extensions/FrameBridge';
import { viewSession } from '@helpers/extensions/viewSession';
import { useNavigateWithTransition } from '@hooks/useNavigateWithTransition';
import { constructOpenURL } from '@helpers/navigation';
import {
  useCreateThemeVars,
  useFrameColorScheme,
} from '@views/PluginView/useCreateThemeVars';
import resetCss from '../../reset.css?raw';
import { useIntegrationProxy } from '@helpers/integrationProxy';
import { ProxyConnections } from '@helpers/proxyConnections';
import { ConnectDialog } from '@chunks/AppPage/ConnectDialog';
import {
  syncablesHostRequest,
  type BuiltinSyncablesRequest,
  type SyncablesDiscovery,
} from './syncablesHost';

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
]);

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
}: {
  table: string;
  drive: string;
}): React.JSX.Element {
  const store = useStore();
  const origin = useIntegrationProxy();
  const proxy = useMemo(
    () => new ProxyConnections(localStorage, origin, () => store.getAgent()),
    [origin, store],
  );
  const navigate = useNavigateWithTransition();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const bridgeRef = useRef<FrameBridge | undefined>(undefined);
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

    const bridge = new FrameBridge(frame, (wire, originalSession) => {
      if (!isBuiltinSyncablesRequest(wire)) return;
      const session = viewSession(originalSession, wire.id);
      const controller = new AbortController();
      session.watch(wire.id, () => () => controller.abort());

      const work = async () => {
        const request = {
          ...wire.args,
          op: wire.op,
        } as BuiltinSyncablesRequest;

        if (request.op === 'syncablesConnect') {
          const context = (await syncablesHostRequest(
            store,
            drive,
            table,
            { op: 'syncablesContext' },
            proxy,
            discovery,
            controller.signal,
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

          controller.signal.throwIfAborted();

          return await new Promise(resolve => {
            askRef.current?.cancel();
            const pending = {
              cancel: () => resolve({ status: 'cancelled' }),
              reconnectId,
            };
            askRef.current = pending;
            setAsk(pending);
            controller.signal.addEventListener(
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
          controller.signal,
        );
      };

      void work()
        .then(result => {
          if (!session.isActive()) return;
          session.post({ result: result ?? true });

          if (
            result &&
            typeof result === 'object' &&
            'subject' in result &&
            typeof result.subject === 'string'
          ) {
            navigate(constructOpenURL(result.subject));
          }
        })
        .catch(reason =>
          session.post({ error: String(reason?.message ?? reason) }),
        )
        .finally(() => session.unwatch(wire.id));
    });

    bridgeRef.current = bridge;

    return () => {
      askRef.current?.cancel();
      askRef.current = undefined;
      setAsk(undefined);
      bridge.close();
      if (bridgeRef.current === bridge) bridgeRef.current = undefined;
    };
  }, [src, store, drive, table, proxy, navigate]);

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
    return (
      <p role='status'>
        Connecting services requires an Atomic Server node. The local table
        remains accessible without a connection.
      </p>
    );
  }

  return (
    <div style={{ width: '100%', minHeight: 280 }}>
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
        ref={frameRef}
        src={src}
        title='Built-in Syncables collection view'
        sandbox='allow-scripts'
        allow='fullscreen'
        style={{
          display: 'block',
          border: 0,
          width: '100%',
          minHeight: '55vh',
          height: '70vh',
        }}
        onError={() => setError('Could not load the built-in Syncables iframe')}
      />
    </div>
  );
}

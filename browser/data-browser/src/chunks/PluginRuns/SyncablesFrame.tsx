import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import { isViewRequest } from '@tomic/plugin';
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
import {
  ProxyConnections,
  type ProxyConnection,
} from '@helpers/proxyConnections';
import {
  handleRequest,
  isHostRequest,
  type HostRequest,
} from '@chunks/AppPage/hostStore';
import { ConnectDialog } from '@chunks/AppPage/ConnectDialog';
import {
  syncablesHostRequest,
  type BuiltinSyncablesRequest,
} from './syncablesHost';

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
  const bridgeRef = useRef<FrameBridge>();
  const stylesheet = useCreateThemeVars();
  const colorScheme = useFrameColorScheme();
  const [error, setError] = useState('');
  const [ask, setAsk] = useState<{
    id: number | string;
    platform: string;
    reply: (response: unknown) => void;
    existing?: ProxyConnection[];
  }>();
  const askRef = useRef(ask);
  useEffect(() => {
    askRef.current = ask;
  }, [ask]);

  const src = !store.noServer
    ? store.getServerUrl() + '/builtin-syncables-ui?format=html'
    : undefined;

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame || !src) return;

    const bridge = new FrameBridge(frame, (wire, originalSession) => {
      const canonical = isViewRequest(wire);
      const data = canonical
        ? { ...wire.args, __atomic: true, id: wire.id, op: wire.op }
        : wire;
      const session = canonical
        ? viewSession(originalSession, wire.id)
        : originalSession;
      if (!isHostRequest(data)) return;

      if (data.op === 'proxyConnect') {
        if (data.platform !== 'github-issues') {
          session.post({ id: data.id, error: 'Only GitHub is supported by this view yet' });
          return;
        }
        askRef.current?.reply({
          id: askRef.current.id,
          result: { status: 'cancelled' },
        });
        const next = {
          id: data.id,
          platform: data.platform,
          reply: session.post,
          existing: undefined as ProxyConnection[] | undefined,
        };
        setAsk(next);
        void proxy.list(data.platform)
          .then(existing => {
            if (askRef.current?.id === next.id)
              setAsk({ ...next, existing });
          })
          .catch(() => {
            if (askRef.current?.id === next.id)
              setAsk({ ...next, existing: [] });
          });
        return;
      }

      const work = async (): Promise<unknown> => {
        if (data.op.startsWith('syncables'))
          return syncablesHostRequest(
            store,
            drive,
            table,
            data as BuiltinSyncablesRequest,
            proxy,
          );

        if (data.op === 'openResource') {
          if (typeof data.subject !== 'string')
            throw new Error('Missing destination resource');
          navigate(constructOpenURL(data.subject));
          return true;
        }

        if (data.op === 'toast') {
          const body = (data as HostRequest & { text?: unknown }).text;
          if (typeof body === 'string') toast(body);
          return true;
        }

        // The same read-only Atomic API and signed proxy transport that
        // AppFrame supplies. Block generic writes, apply, undo and exports:
        // only the host-verified syncables commands above may mutate data.
        if (
          [
            'app',
            'data',
            'get',
            'getMany',
            'query',
            'search',
            'context',
            'proxyCapability',
            'proxyFetch',
            'proxyConnections',
          ].includes(data.op)
        ) {
          const user = store.getAgent();
          const proxyHost = user
            ? proxy.host(async () => user.subject)
            : undefined;
          return handleRequest(
            store,
            table,
            drive,
            data,
            table,
            proxyHost,
          );
        }
        throw new Error('This built-in view cannot perform ' + data.op);
      };

      void work()
        .then(result => {
          if (session.isActive())
            session.post({ id: data.id, result: result ?? true });
        })
        .catch(reason => {
          if (session.isActive())
            session.post({ id: data.id, error: String(reason?.message ?? reason) });
        });
    });

    bridgeRef.current = bridge;
    return () => {
      bridge.close();
      if (bridgeRef.current === bridge) bridgeRef.current = undefined;
    };
  }, [src, store, drive, table, proxy, navigate]);

  useEffect(() => {
    bridgeRef.current?.setStyle(resetCss + '\n' + stylesheet, colorScheme);
  }, [stylesheet, colorScheme, src]);

  const finishAsk = (chosen: ProxyConnection | undefined) => {
    const current = askRef.current;
    if (!current) return;
    current.reply({
      id: current.id,
      result: chosen
        ? {
            status: 'connected',
            connectionId: chosen.connection_id,
            platform: current.platform,
          }
        : { status: 'cancelled' },
    });
    setAsk(undefined);
  };

  const connect = async () => {
    const user = store.getAgent();
    if (!user) throw new Error('Sign in to connect GitHub');
    const target = await proxy.start(
      {
        drive,
        app: table,
        // First-party only: caller identity is the signed-in account.
        // The sandbox's ephemeral signing key is still bound to each proxy
        // capability and its connection identifier.
        appAgent: user.subject,
      },
      'github-issues',
      location.href,
      'Atomic Syncables',
    );
    location.assign(target);
  };

  const useExisting = async (connection: ProxyConnection) => {
    const user = store.getAgent();
    if (!user) throw new Error('Sign in to use GitHub');
    await proxy.delegate(
      connection.connection_id,
      user.subject,
      'Atomic Syncables',
    );
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
          existing={ask.existing}
          onConnect={connect}
          onUseExisting={useExisting}
          onClosed={finishAsk}
        />
      )}
      <iframe
        ref={frameRef}
        src={src}
        title='Built-in Syncables collection view'
        sandbox='allow-scripts allow-modals'
        allow='fullscreen'
        style={{ display: 'block', border: 0, width: '100%', minHeight: '55vh', height: '70vh' }}
        onError={() => setError('Could not load the built-in Syncables iframe')}
      />
    </div>
  );
}

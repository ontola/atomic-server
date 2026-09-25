import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { styled } from 'styled-components';
import { FaLink, FaLinkSlash, FaTriangleExclamation } from 'react-icons/fa6';
import { useStore, type Resource } from '@tomic/react';
import { Button } from '@components/Button';
import { Column, Row } from '@components/Row';
import { ProxyConsentBar, ProxyConsentText } from '@components/ProxyConsentBar';
import { getIntegrationProxy } from '@helpers/integrationProxy';
import { platformName, type ProxyConnection } from '@helpers/proxyConnections';
import {
  proxyConnectionsFor,
  registerRuntimesInBackground,
} from '@helpers/useInstallationRuntimes';
import {
  delegateExistingConnection,
  disconnectInstallationPlatform,
  existingConnectionsByPlatform,
  startInstallationConnect,
  type InstallationConnectionMap,
} from '@helpers/installationConnections';
import {
  clearConnectionRequests,
  useConnectionRequests,
  type ConnectionRequest,
} from '@helpers/connectionRequests';

/** Which platform is waiting on the consent step, and how it will connect. */
export interface ConnectAsk {
  platform: string;
  /** A connection the person already has; absent for a new `/connect`. */
  existing?: ProxyConnection;
}

export interface InstallationConnectionsViewProps {
  canWrite: boolean;
  /** Declared in the manifest's `proxy`, plus any still recorded. */
  platforms: readonly string[];
  /** The Installation's name, for "<plugin> needs a … connection". */
  pluginName: string;
  /** Open requests from the nodes that run it (#1700 flow b). */
  requests?: readonly ConnectionRequest[];
  connected: InstallationConnectionMap;
  existing: Record<string, ProxyConnection[] | undefined>;
  proxyOrigin: string;
  ask?: ConnectAsk;
  busy?: string;
  error?: string;
  onConnect: (platform: string) => void;
  onUseExisting: (platform: string, connection: ProxyConnection) => void;
  onConfirm: () => void;
  onCancel: () => void;
  onDisconnect: (platform: string) => void;
  /** Clears the open requests for a platform that is already connected. */
  onClearRequests?: (platform: string) => void;
}

/** The open requests, one entry per platform, in the order they came. */
function requestsByPlatform(requests: readonly ConnectionRequest[]) {
  const out = new Map<string, ConnectionRequest[]>();

  for (const request of requests) {
    out.set(request.platform, [...(out.get(request.platform) ?? []), request]);
  }

  return [...out.entries()];
}

/**
 * One row per proxy platform: connect it, reuse a connection, or disconnect.
 * Above them, what the nodes that run the plugin asked for. Only someone who
 * can write the Installation gets any buttons; anyone else only sees the
 * requests.
 */
export function InstallationConnectionsView({
  canWrite,
  platforms,
  pluginName,
  requests = [],
  connected,
  existing,
  proxyOrigin,
  ask,
  busy,
  error,
  onConnect,
  onUseExisting,
  onConfirm,
  onCancel,
  onDisconnect,
  onClearRequests,
}: InstallationConnectionsViewProps): React.JSX.Element | null {
  const asked = requestsByPlatform(requests);
  const requested = new Set(asked.map(([p]) => p));
  const rows = [...new Set([...platforms, ...requested])];
  if (rows.length === 0 || (!canWrite && asked.length === 0)) return null;
  const disabled = busy !== undefined;

  return (
    <Column as='section' aria-label='Connections'>
      <h3>Connections</h3>
      {asked.map(([platform, byNode]) => {
        const name = platformName(platform);
        const reusable = existing[platform]?.[0];
        const nodes = byNode
          .map(r => r.runtime.label ?? r.runtime.subject)
          .join(', ');
        const since = new Date(
          Math.min(...byNode.map(r => r.requestedAt)),
        ).toLocaleString();

        return (
          <RequestNotice
            key={platform}
            role='status'
            data-request-platform={platform}
          >
            <Row gap='0.6rem' center>
              <FaTriangleExclamation aria-hidden />
              <Column gap='0.1rem'>
                <strong>
                  {pluginName} needs a {name} connection
                </strong>
                <Status>
                  Asked by {nodes} since {since}. Runs that need it are paused
                  until it is connected.
                </Status>
              </Column>
            </Row>
            {canWrite && (
              <Row gap='0.5rem' wrapItems>
                {connected[platform] ? (
                  <Button
                    disabled={disabled}
                    onClick={() => onClearRequests?.(platform)}
                  >
                    Resume runs
                  </Button>
                ) : (
                  <>
                    {reusable && (
                      <Button
                        subtle
                        disabled={disabled}
                        onClick={() => onUseExisting(platform, reusable)}
                      >
                        Use existing connection
                      </Button>
                    )}
                    <Button
                      disabled={disabled}
                      onClick={() => onConnect(platform)}
                    >
                      <FaLink aria-hidden />
                      <span>Connect {name}</span>
                    </Button>
                  </>
                )}
              </Row>
            )}
          </RequestNotice>
        );
      })}
      {canWrite &&
        rows.map(platform => {
          const name = platformName(platform);
          const connectionId = connected[platform];
          const reusable = existing[platform]?.[0];

          return (
            <Column key={platform} gap='0.5rem'>
              <PlatformRow
                justify='space-between'
                center
                wrapItems
                data-platform={platform}
              >
                <Column gap='0.1rem'>
                  <strong>{name}</strong>
                  {connectionId ? (
                    <Status data-connected='true'>
                      Connected · <code>{connectionId}</code>
                    </Status>
                  ) : (
                    <Status>Not connected</Status>
                  )}
                </Column>
                <Row gap='0.5rem' wrapItems>
                  {connectionId ? (
                    <Button
                      subtle
                      disabled={disabled}
                      onClick={() => onDisconnect(platform)}
                    >
                      <FaLinkSlash aria-hidden />
                      <span>
                        {busy === platform ? 'Disconnecting…' : 'Disconnect'}
                      </span>
                    </Button>
                  ) : (
                    // The request above already offers these.
                    !requested.has(platform) && (
                      <>
                        {reusable && (
                          <Button
                            subtle
                            disabled={disabled}
                            onClick={() => onUseExisting(platform, reusable)}
                          >
                            Use existing connection
                          </Button>
                        )}
                        <Button
                          disabled={disabled}
                          onClick={() => onConnect(platform)}
                        >
                          <FaLink aria-hidden />
                          <span>Connect {name}</span>
                        </Button>
                      </>
                    )
                  )}
                </Row>
              </PlatformRow>
              {ask?.platform === platform &&
                !connectionId && (
                  // TODO(#1724): show ProxyTrafficNotice in this bar once it is on
                  // this branch; it names who runs the proxy and links the
                  // self-hosting guide.
                  <ProxyConsentBar aria-label='Connect an account'>
                    <ProxyConsentText>
                      This plugin will use your <strong>{name}</strong> account
                      through {proxyOrigin}. The proxy keeps the connection
                      under your account; this plugin may use it until you
                      disconnect it.
                    </ProxyConsentText>
                    <Row gap='0.5rem'>
                      <Button disabled={disabled} onClick={onConfirm}>
                        {ask.existing ? 'Use this connection' : 'Continue'}
                      </Button>
                      <Button subtle disabled={disabled} onClick={onCancel}>
                        Cancel
                      </Button>
                    </Row>
                  </ProxyConsentBar>
                )}
            </Column>
          );
        })}
      {error && <Problem role='alert'>{error}</Problem>}
    </Column>
  );
}

/**
 * Connects the proxy platforms an Installation's manifest declares, and shows
 * which are connected. Asks the proxy for the person's own connections only
 * when there is a platform left to connect.
 */
export function InstallationConnections({
  resource,
  canWrite,
  platforms,
  connected,
  pluginName,
}: {
  resource: Resource;
  canWrite: boolean;
  platforms: readonly string[];
  connected: InstallationConnectionMap;
  pluginName: string;
}): React.JSX.Element | null {
  const store = useStore();
  const [existing, setExisting] = useState<
    Record<string, ProxyConnection[] | undefined>
  >({});
  const [ask, setAsk] = useState<ConnectAsk>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  // Reading them needs no proxy: they are resources on the drive.
  const { open: requests, refresh: refreshRequests } = useConnectionRequests(
    store,
    resource.subject,
    true,
  );
  const unconnected = [
    ...new Set([...platforms, ...requests.map(r => r.platform)]),
  ]
    .filter(p => !connected[p])
    .join('\n');

  useEffect(() => {
    if (!canWrite || !unconnected || !store.getAgent()) return;
    let cancelled = false;

    Promise.resolve()
      .then(() =>
        existingConnectionsByPlatform(
          proxyConnectionsFor(store),
          unconnected.split('\n'),
        ),
      )
      .then(rows => {
        if (!cancelled) setExisting(rows);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });

    return () => {
      cancelled = true;
    };
  }, [store, canWrite, unconnected]);

  const run = (platform: string, work: () => Promise<void>) => {
    setBusy(platform);
    setError(undefined);
    work()
      .catch((e: Error) => setError(e.message))
      .finally(() => {
        setBusy(undefined);
        refreshRequests();
      });
  };

  const clearRequests = (platform: string) =>
    run(platform, async () => {
      await clearConnectionRequests(store, resource.subject, platform);
      toast.success(`Resumed the runs that need ${platformName(platform)}`);
    });

  const confirm = () => {
    if (!ask) return;
    const { platform, existing: connection } = ask;

    run(platform, async () => {
      const connections = proxyConnectionsFor(store);

      if (connection) {
        await delegateExistingConnection(
          store,
          connections,
          resource,
          connection,
        );
        setAsk(undefined);
        // The nodes act for the app id only once registered as runtimes.
        registerRuntimesInBackground(store, resource.subject);
        toast.success(`${platformName(platform)} connected`);

        return;
      }

      location.assign(
        await startInstallationConnect(
          connections,
          resource,
          platform,
          location.href,
        ),
      );
    });
  };

  const disconnect = (platform: string) =>
    run(platform, async () => {
      await disconnectInstallationPlatform(
        store,
        proxyConnectionsFor(store),
        resource,
        platform,
      );
      toast.success(`${platformName(platform)} disconnected`);
    });

  return (
    <InstallationConnectionsView
      canWrite={canWrite}
      platforms={platforms}
      pluginName={pluginName}
      requests={requests}
      connected={connected}
      existing={existing}
      proxyOrigin={getIntegrationProxy()}
      ask={ask}
      busy={busy}
      error={error}
      onConnect={platform => setAsk({ platform })}
      onUseExisting={(platform, connection) =>
        setAsk({ platform, existing: connection })
      }
      onConfirm={confirm}
      onCancel={() => setAsk(undefined)}
      onDisconnect={disconnect}
      onClearRequests={clearRequests}
    />
  );
}

const PlatformRow = styled(Row)`
  padding: 0.5rem 0.75rem;
  border: 1px solid ${p => p.theme.colors.bg2};
  border-radius: ${p => p.theme.radius};
`;

const Status = styled.span`
  font-size: 0.9rem;
  color: ${p => p.theme.colors.textLight};
  overflow-wrap: anywhere;

  &[data-connected='true'] {
    color: ${p => p.theme.colors.main};
  }
`;

const RequestNotice = styled.div`
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.6rem 0.75rem;
  border: 1px solid ${p => p.theme.colors.warning};
  border-radius: ${p => p.theme.radius};
  background: ${p => p.theme.colors.bg1};

  & > div > svg {
    color: ${p => p.theme.colors.warning};
    flex-shrink: 0;
  }
`;

const Problem = styled.p`
  color: ${p => p.theme.colors.alert};
  margin: 0;
`;

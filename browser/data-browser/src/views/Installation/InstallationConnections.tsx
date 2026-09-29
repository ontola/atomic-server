import { useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { styled } from 'styled-components';
import { FaLink, FaLinkSlash } from 'react-icons/fa6';
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
}

/**
 * One row per proxy platform: connect it, reuse a connection, or disconnect.
 * Only someone who can write the Installation sees any of it.
 */
export function InstallationConnectionsView({
  canWrite,
  platforms,
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
}: InstallationConnectionsViewProps): React.JSX.Element | null {
  if (!canWrite || platforms.length === 0) return null;

  return (
    <Column as='section' aria-label='Connections'>
      <h3>Connections</h3>
      {platforms.map(platform => {
        const name = platformName(platform);
        const connectionId = connected[platform];
        const reusable = existing[platform]?.[0];
        const disabled = busy !== undefined;

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
            </PlatformRow>
            {ask?.platform === platform &&
              !connectionId && (
                // TODO(#1724): show ProxyTrafficNotice in this bar once it is on
                // this branch; it names who runs the proxy and links the
                // self-hosting guide.
                <ProxyConsentBar aria-label='Connect an account'>
                  <ProxyConsentText>
                    This plugin will use your <strong>{name}</strong> account
                    through {proxyOrigin}. The proxy keeps the connection under
                    your account; this plugin may use it until you disconnect
                    it.
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
}: {
  resource: Resource;
  canWrite: boolean;
  platforms: readonly string[];
  connected: InstallationConnectionMap;
}): React.JSX.Element | null {
  const store = useStore();
  const [existing, setExisting] = useState<
    Record<string, ProxyConnection[] | undefined>
  >({});
  const [ask, setAsk] = useState<ConnectAsk>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const unconnected = platforms.filter(p => !connected[p]).join('\n');

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
      .finally(() => setBusy(undefined));
  };

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

const Problem = styled.p`
  color: ${p => p.theme.colors.alert};
  margin: 0;
`;

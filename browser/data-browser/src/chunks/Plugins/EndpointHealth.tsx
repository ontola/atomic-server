import { Button } from '@components/Button';
import { CodeBlock } from '@components/CodeBlock';
import { Column, Row } from '@components/Row';
import {
  useStore,
  type DeliveryFailure,
  type DeliveryHealth,
  type InstallationRouteState,
  type InstallationRouteStatus,
  type RouteHealth,
  type RouteToken,
} from '@tomic/react';
import { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { FaArrowsRotate, FaTriangleExclamation } from 'react-icons/fa6';
import { styled } from 'styled-components';
import { authText, RefusalText } from './PublicEndpoints';
import {
  fetchRouteStatus,
  fetchRouteTokens,
  revokeRouteToken,
} from './routeStatusApi';

const when = (ms: number) => new Date(ms).toLocaleString();

/** The status-pill states of the shared plugin UI (design 2.10). */
function pillStatus(
  status: InstallationRouteStatus,
): 'idle' | 'synced' | 'error' | 'needs-attention' {
  if (status.state === 'degraded' || status.refusal) return 'needs-attention';
  if (status.state !== 'active') return 'idle';
  const failing =
    status.routes.some(r => r.errors24h > 0) ||
    (status.deliveries?.dead ?? 0) > 0;

  return failing ? 'error' : 'synced';
}

function StatePill({ status }: { status: InstallationRouteStatus }) {
  const pill = pillStatus(status);
  const label: Record<InstallationRouteState, string> = {
    active: 'Serving',
    paused: 'Paused',
    retired: 'Retired',
    degraded: 'Turned off',
    unregistered: 'Not active',
  };

  return (
    <Pill data-status={pill} data-testid='endpoint-state'>
      {pill === 'error' ? 'Errors' : label[status.state]}
    </Pill>
  );
}

/**
 * Why the endpoints are down (design 0.4): the gates the operator set, in
 * `hostFeatureMessage`'s words, or the server's own reason (a route
 * collision, a missing routes origin).
 */
function TurnedOff({ status }: { status: InstallationRouteStatus }) {
  return (
    <Banner role='alert' data-testid='endpoints-off'>
      <FaTriangleExclamation aria-hidden />
      <Column gap='0.25rem'>
        <strong>Public endpoints are turned off on this server</strong>
        <OffReason status={status} />
        <p>
          Its URLs answer 404 and its deliveries wait. Its data, keys and tokens
          are kept, and it comes back without a new review once the server
          allows it.
        </p>
      </Column>
    </Banner>
  );
}

function OffReason({ status }: { status: InstallationRouteStatus }) {
  if (status.refusal) {
    return (
      <p data-testid='endpoints-off-reason'>
        <RefusalText problem={status.refusal} />
      </p>
    );
  }

  return (
    <p data-testid='endpoints-off-reason'>
      {(status.degraded ?? '')
        .split('`')
        .map((part, i) =>
          i % 2 === 1 ? (
            <code key={i}>{part}</code>
          ) : (
            <span key={i}>{part}</span>
          ),
        )}
    </p>
  );
}

function LastError({ route }: { route: RouteHealth }) {
  if (!route.lastError) return null;
  const { at, status, message } = route.lastError;

  return (
    <ErrorText data-testid='route-last-error'>
      Last error ({status}, {when(at)}): {message}
    </ErrorText>
  );
}

function RouteUrl({ url }: { url: string }) {
  if (!url) return <NoAddress />;

  return <RouteUrlBlock content={url} wordWrap />;
}

function NoAddress() {
  return (
    <Muted>
      No address yet: <code>ATOMIC_ROUTES_ORIGIN</code> is not set.
    </Muted>
  );
}

function QueueLine({ route }: { route: RouteHealth }) {
  if (route.queueDepth === 0) return null;

  return (
    <p>
      Deliveries waiting: <strong>{route.queueDepth}</strong>
    </p>
  );
}

function RouteItem({ route }: { route: RouteHealth }) {
  return (
    <li data-testid={`route-${route.id}`}>
      <ItemTitle>
        <code>
          {route.methods.join(', ')} {route.path ?? route.id}
        </code>
      </ItemTitle>
      <Muted>{authText(route.auth)}</Muted>
      <RouteUrl url={route.url} />
      <Stats>
        <span>
          Requests (24 h): <strong>{route.requests24h}</strong>
        </span>
        <span data-failing={route.errors24h > 0}>
          Errors (24 h): <strong>{route.errors24h}</strong>
        </span>
      </Stats>
      <LastError route={route} />
      <QueueLine route={route} />
      {route.oldestQueueFailure && (
        <FailureLine failure={route.oldestQueueFailure} />
      )}
    </li>
  );
}

function FailureState({ failure }: { failure: DeliveryFailure }) {
  if (failure.state === 'dead') {
    return (
      <strong data-testid='dead-letter'>
        Dead letter (gave up after attempt {failure.attempts})
      </strong>
    );
  }

  if (failure.nextAt) {
    return (
      <strong>
        Retrying (attempt {failure.attempts}), next at {when(failure.nextAt)}
      </strong>
    );
  }

  return <strong>Retrying (attempt {failure.attempts})</strong>;
}

function FailureCause({ failure }: { failure: DeliveryFailure }) {
  if (failure.uncertain) {
    return <span>No answer; it may have arrived. {failure.error ?? ''}</span>;
  }

  if (failure.status) {
    return (
      <span>
        Answered {failure.status}. {failure.error ?? ''}
      </span>
    );
  }

  return <span>{failure.error ?? ''}</span>;
}

function FailureLine({ failure }: { failure: DeliveryFailure }) {
  const host = failure.host ?? '?';

  return (
    <FailureItem data-state={failure.state}>
      <p>
        <FailureState failure={failure} />
      </p>
      <p>
        <code>{failure.operation}</code> to <code>{host}</code>
      </p>
      <p>
        <FailureCause failure={failure} />
      </p>
    </FailureItem>
  );
}

function CapLine({ deliveries }: { deliveries: DeliveryHealth }) {
  const sent = deliveries.sentToday.toLocaleString();

  if (deliveries.dailyCap === undefined) {
    return (
      <span>
        Sent today: <strong>{sent}</strong>
      </span>
    );
  }

  const cap = deliveries.dailyCap.toLocaleString();

  return (
    <span data-testid='daily-cap'>
      Sent today: <strong>{sent}</strong> of {cap}
    </span>
  );
}

function Deliveries({ deliveries }: { deliveries: DeliveryHealth }) {
  return (
    <Column gap='0.5rem' as='section' aria-label='Deliveries'>
      <h4>Deliveries</h4>
      <Stats>
        <span>
          Queued: <strong>{deliveries.queued}</strong>
        </span>
        <span>
          Sending: <strong>{deliveries.sending}</strong>
        </span>
        <span>
          Delivered (24 h): <strong>{deliveries.delivered24h}</strong>
        </span>
        <span data-failing={deliveries.dead > 0}>
          Dead letters: <strong>{deliveries.dead}</strong>
        </span>
        <CapLine deliveries={deliveries} />
      </Stats>
      <WaitingLines deliveries={deliveries} />
      <RecentFailures failures={deliveries.lastFailures} />
    </Column>
  );
}

// Wuchale drops a message with nested elements when it sits inside a
// `{condition && (...)}`; these small components keep the conditionals
// free of text.

function WaitingLines({ deliveries }: { deliveries: DeliveryHealth }) {
  return (
    <>
      <CapWaitLine count={deliveries.waitingForCap} />
      <HeldLine count={deliveries.held} />
    </>
  );
}

function CapWaitLine({ count }: { count: number }) {
  if (count === 0) return null;

  return (
    <Muted>
      Waiting for tomorrow’s cap: <strong>{count}</strong>
    </Muted>
  );
}

function HeldLine({ count }: { count: number }) {
  if (count === 0) return null;

  return (
    <Muted>
      Held while the endpoints are off: <strong>{count}</strong>
    </Muted>
  );
}

function RecentFailures({ failures }: { failures: DeliveryFailure[] }) {
  if (failures.length === 0) return <Muted>No failed deliveries.</Muted>;

  return (
    <Column gap='0.25rem'>
      <ItemTitle>Recent failures</ItemTitle>
      <Failures>
        {failures.map(failure => (
          <FailureLine key={failure.id} failure={failure} />
        ))}
      </Failures>
    </Column>
  );
}

function TokenItem({
  token,
  onRevoke,
}: {
  token: RouteToken;
  onRevoke: (id: string) => Promise<void>;
}) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  const revoke = async () => {
    setBusy(true);

    try {
      await onRevoke(token.id);
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  };

  return (
    <li data-testid={`token-${token.id}`}>
      <Row justify='space-between' center wrapItems>
        <Column gap='0.1rem'>
          <ItemTitle>
            <code>{token.name}</code> {token.client ?? ''}
          </ItemTitle>
          <TokenScopes scopes={token.scopes} />
          <Muted>Issued {when(token.issuedAt)}</Muted>
          <TokenExpiry expiresAt={token.expiresAt} />
        </Column>
        <TokenActions
          confirming={confirming}
          busy={busy}
          onAsk={() => setConfirming(true)}
          onCancel={() => setConfirming(false)}
          onConfirm={revoke}
        />
      </Row>
    </li>
  );
}

function TokenScopes({ scopes }: { scopes: string[] }) {
  if (scopes.length === 0) return <Muted>No scopes</Muted>;

  return (
    <Muted>
      Scopes: <code>{scopes.join(' ')}</code>
    </Muted>
  );
}

function TokenExpiry({ expiresAt }: { expiresAt?: number }) {
  if (!expiresAt) return null;

  return <Muted>Expires {when(expiresAt)}</Muted>;
}

function TokenActions({
  confirming,
  busy,
  onAsk,
  onCancel,
  onConfirm,
}: {
  confirming: boolean;
  busy: boolean;
  onAsk: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  if (!confirming) {
    return (
      <Button subtle onClick={onAsk}>
        Revoke
      </Button>
    );
  }

  return (
    <Row gap='0.5rem'>
      <Button subtle disabled={busy} onClick={onCancel}>
        Cancel
      </Button>
      <Button alert disabled={busy} onClick={onConfirm}>
        Revoke token
      </Button>
    </Row>
  );
}

function Tokens({
  tokens,
  onRevoke,
}: {
  tokens: RouteToken[];
  onRevoke: (id: string) => Promise<void>;
}) {
  return (
    <Column gap='0.5rem' as='section' aria-label='Issued tokens'>
      <h4>Issued tokens</h4>
      {tokens.length === 0 ? (
        <NoTokens />
      ) : (
        <List>
          {tokens.map(token => (
            <TokenItem key={token.id} token={token} onRevoke={onRevoke} />
          ))}
        </List>
      )}
    </Column>
  );
}

function RefreshButton({ onRefresh }: { onRefresh?: () => void }) {
  if (!onRefresh) return null;

  return (
    <Button subtle onClick={onRefresh} title='Refresh'>
      <FaArrowsRotate aria-hidden />
      <span>Refresh</span>
    </Button>
  );
}

function NoTokens() {
  return <Muted>No tokens issued.</Muted>;
}

export interface EndpointHealthViewProps {
  status: InstallationRouteStatus;
  /** `undefined` while loading, or when they could not be read. */
  tokens?: RouteToken[];
  onRevoke: (id: string) => Promise<void>;
  onRefresh?: () => void;
}

/**
 * Endpoint health (design 2.10, #1721): per route its public URL, method
 * and auth, 24-hour counts and last error; the delivery queue; and the
 * tokens the routes issued. When the gates hold the release back, why.
 */
export function EndpointHealthView({
  status,
  tokens,
  onRevoke,
  onRefresh,
}: EndpointHealthViewProps) {
  const off = status.state === 'degraded' || !!status.refusal;
  const enqueues =
    !!status.deliveries &&
    (status.deliveries.queued > 0 ||
      status.deliveries.dead > 0 ||
      status.deliveries.delivered24h > 0 ||
      status.deliveries.sentToday > 0 ||
      status.deliveries.lastFailures.length > 0 ||
      status.routes.some(r => r.queueDepth > 0));
  const bearer = status.routes.some(r => r.auth === 'bearer');

  return (
    <Column as='section' aria-label='Endpoints' gap='1rem'>
      <Row justify='space-between' center wrapItems>
        <Row center gap='1ch'>
          <h3>Endpoints</h3>
          <StatePill status={status} />
        </Row>
        <RefreshButton onRefresh={onRefresh} />
      </Row>
      {off && <TurnedOff status={status} />}
      <List>
        {status.routes.map(route => (
          <RouteItem key={route.id} route={route} />
        ))}
      </List>
      {status.deliveries && enqueues && (
        <Deliveries deliveries={status.deliveries} />
      )}
      {tokens && (tokens.length > 0 || bearer) && (
        <Tokens tokens={tokens} onRevoke={onRevoke} />
      )}
    </Column>
  );
}

/**
 * The Installation page's "Endpoints" section. Only rendered for someone who
 * may write the Installation; nothing on a server without plugin routes or
 * for a plugin without routes.
 */
export function EndpointHealth({ installation }: { installation: string }) {
  const store = useStore();
  const [status, setStatus] = useState<InstallationRouteStatus>();
  const [tokens, setTokens] = useState<RouteToken[]>();
  const [error, setError] = useState<string>();
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    let cancelled = false;

    fetchRouteStatus(store, installation)
      .then(next => {
        if (cancelled) return;
        setStatus(next);
        setError(undefined);

        if (next && next.routes.length > 0) {
          return fetchRouteTokens(store, installation).then(list => {
            if (!cancelled) setTokens(list);
          });
        }
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });

    return () => {
      cancelled = true;
    };
  }, [store, installation, generation]);

  const refresh = useCallback(() => setGeneration(g => g + 1), []);

  const onRevoke = useCallback(
    async (id: string) => {
      try {
        await revokeRouteToken(store, installation, id);
        setTokens(list => list?.filter(t => t.id !== id));
        toast.success('Token revoked');
      } catch (e) {
        toast.error(e instanceof Error ? e.message : String(e));
      }
    },
    [store, installation],
  );

  if (error) {
    return (
      <Column as='section' aria-label='Endpoints'>
        <h3>Endpoints</h3>
        <Banner role='alert'>
          <FaTriangleExclamation aria-hidden />
          <p>{error}</p>
        </Banner>
      </Column>
    );
  }

  if (!status || status.routes.length === 0) return null;

  return (
    <EndpointHealthView
      status={status}
      tokens={tokens}
      onRevoke={onRevoke}
      onRefresh={refresh}
    />
  );
}

const List = styled.ul`
  display: flex;
  flex-direction: column;
  gap: ${p => p.theme.size()};
  padding: 0;
  margin: 0;

  li {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    background-color: ${p => p.theme.colors.bg1};
    border-radius: ${p => p.theme.radius};
    list-style: none;
    padding: ${p => p.theme.size()};
    margin: 0;
    overflow-wrap: anywhere;
    min-width: 0;

    p {
      margin: 0;
    }
  }
`;

const Failures = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.6rem;

  p {
    margin: 0;
  }
`;

// The copy button sits over the block's right edge; keep the URL clear of it.
const RouteUrlBlock = styled(CodeBlock)`
  padding-right: 3.5rem;
`;

const FailureItem = styled.div`
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  font-size: 0.9rem;
  overflow-wrap: anywhere;
  border-left: 3px solid ${p => p.theme.colors.warning};
  padding-left: 0.5rem;

  &[data-state='dead'] {
    border-color: ${p => p.theme.colors.alert};
  }
`;

const ItemTitle = styled.p`
  font-weight: bold;
  font-size: 0.9rem;
  margin: 0;
`;

const Muted = styled.p`
  color: ${p => p.theme.colors.textLight};
  font-size: 0.9rem;
  margin: 0;
`;

const ErrorText = styled.p`
  color: ${p => p.theme.colors.alert};
  font-size: 0.9rem;
  margin: 0;
`;

const Stats = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem 1.25rem;
  font-size: 0.9rem;

  [data-failing='true'] strong {
    color: ${p => p.theme.colors.alert};
  }
`;

const Banner = styled.div`
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
  color: ${p => p.theme.colors.alert};
  border: 1px solid ${p => p.theme.colors.alert};
  border-radius: ${p => p.theme.radius};
  padding: ${p => p.theme.size()};
  overflow-wrap: anywhere;

  svg {
    flex-shrink: 0;
    margin-top: 0.2rem;
  }

  strong,
  p {
    margin: 0;
    color: ${p => p.theme.colors.text};
  }
`;

const Pill = styled.span`
  font-size: 0.8rem;
  padding: 0.1rem 0.5rem;
  border-radius: ${p => p.theme.radius};
  border: 1px solid ${p => p.theme.colors.bg2};
  color: ${p => p.theme.colors.textLight};
  white-space: nowrap;

  &[data-status='synced'] {
    color: ${p => p.theme.colors.main};
    border-color: ${p => p.theme.colors.main};
  }

  &[data-status='error'] {
    color: ${p => p.theme.colors.alert};
    border-color: ${p => p.theme.colors.alert};
  }

  &[data-status='needs-attention'] {
    color: ${p => p.theme.colors.text};
    border-color: ${p => p.theme.colors.warning};
  }
`;

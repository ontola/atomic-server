// @vitest-environment jsdom
// @wc-ignore-file
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { ThemeProvider } from 'styled-components';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hostFeatureMessage,
  parseRouteStatus,
  type InstallationRouteStatus,
  type RouteToken,
} from '@tomic/react';
import { buildTheme } from '../../styling';
import { EndpointHealth, EndpointHealthView } from './EndpointHealth';
import * as api from './routeStatusApi';

vi.mock('@tomic/react', async original => ({
  ...(await original<typeof import('@tomic/react')>()),
  useStore: () => ({ getServerUrl: () => 'https://atomic.test' }),
}));
vi.mock('./routeStatusApi', () => ({
  fetchRouteStatus: vi.fn(),
  fetchRouteTokens: vi.fn(),
  revokeRouteToken: vi.fn(),
}));

afterEach(cleanup);

const INSTALLATION = 'did:ad:installation';
const PREFIX = 'https://atomic.test/_routes/inbox-1a2b';

/** A `/plugin-route-status` body, shaped like the server's. */
function body(overrides: Record<string, unknown> = {}) {
  return {
    installation: INSTALLATION,
    slug: 'inbox-1a2b',
    state: 'active',
    degraded: null,
    refusal: null,
    level: 'read-write',
    mount: 'drive-prefix',
    routes: [
      {
        id: 'inbox',
        url: `${PREFIX}/inbox`,
        path: '/inbox',
        methods: ['POST'],
        auth: 'none',
        principal: 'anonymous',
        requests24h: 0,
        errors24h: 0,
        lastError: null,
        queueDepth: 0,
        oldestQueueFailure: null,
      },
      {
        id: 'storage',
        url: `${PREFIX}/storage/{*rest}`,
        path: '/storage/{*rest}',
        methods: ['GET'],
        auth: 'bearer',
        principal: 'anonymous',
        requests24h: 0,
        errors24h: 0,
        lastError: null,
        queueDepth: 0,
        oldestQueueFailure: null,
      },
    ],
    runs: [],
    deliveries: {
      queued: 0,
      sending: 0,
      held: 0,
      waitingForCap: 0,
      delivered24h: 0,
      dead: 0,
      sentToday: 0,
      dailyCap: 10000,
      lastFailures: [],
    },
    ...overrides,
  };
}

const status = (overrides: Record<string, unknown> = {}) =>
  parseRouteStatus(body(overrides))!;

const withTheme = (children: React.ReactNode) => (
  <ThemeProvider theme={buildTheme(false, '#336699')}>{children}</ThemeProvider>
);

function show(s: InstallationRouteStatus, tokens?: RouteToken[]) {
  const onRevoke = vi.fn(async () => undefined);
  render(
    withTheme(
      <EndpointHealthView status={s} tokens={tokens} onRevoke={onRevoke} />,
    ),
  );

  return {
    onRevoke,
    text: screen.getByRole('region', { name: 'Endpoints' }).textContent!,
  };
}

const deadLetter = {
  id: 'job-1',
  route: 'deliver',
  operation: 'deliver',
  host: 'remote.example',
  state: 'dead',
  attempts: 12,
  enqueuedAt: 1_700_000_000_000,
  at: 1_700_000_100_000,
  status: 404,
  error: 'Not Found',
  uncertain: false,
  nextAt: null,
};

const retrying = {
  id: 'job-2',
  route: 'outbox',
  operation: 'deliver',
  host: 'slow.example',
  state: 'queued',
  attempts: 3,
  enqueuedAt: 1_700_000_000_000,
  at: 1_700_000_050_000,
  status: 503,
  error: 'Service Unavailable',
  uncertain: false,
  nextAt: 1_700_000_900_000,
};

describe('EndpointHealthView', () => {
  it('shows each route’s URL, method, auth and zero counts when nothing happened yet', () => {
    const { text } = show(status(), []);

    expect(screen.getByTestId('endpoint-state').textContent).toBe('Serving');
    expect(screen.getByText('POST /inbox')).toBeTruthy();
    expect(screen.getByText('GET /storage/{*rest}')).toBeTruthy();
    // The public URL, with the code block's copy button.
    expect(text).toContain(`${PREFIX}/inbox`);
    expect(
      screen.getAllByTitle('Copy to clipboard').length,
    ).toBeGreaterThanOrEqual(2);
    expect(text).toContain('Anyone can call it, without signing in.');
    expect(text).toContain(
      'Callers present an access token this plugin issued.',
    );
    expect(text).toContain('Requests (24 h): 0');
    expect(text).toContain('Errors (24 h): 0');
    expect(screen.queryByTestId('route-last-error')).toBeNull();
    expect(screen.queryByTestId('endpoints-off')).toBeNull();
    // Nothing was ever enqueued: no deliveries block.
    expect(screen.queryByRole('region', { name: 'Deliveries' })).toBeNull();
    // A bearer route: the token list, empty.
    expect(text).toContain('No tokens issued.');
  });

  it('shows counts, the last error and the pill for a route that fails', () => {
    const s = body();
    s.routes[0] = {
      ...s.routes[0],
      requests24h: 12,
      errors24h: 2,
      lastError: {
        at: 1_700_000_000_000,
        status: 502,
        message: 'handler threw: boom',
      },
    } as never;
    const { text } = show(parseRouteStatus(s)!, []);

    expect(screen.getByTestId('endpoint-state').textContent).toBe('Errors');
    expect(screen.getByTestId('endpoint-state').dataset.status).toBe('error');
    expect(text).toContain('Requests (24 h): 12');
    expect(text).toContain('Errors (24 h): 2');
    expect(screen.getByTestId('route-last-error').textContent).toContain('502');
    expect(screen.getByTestId('route-last-error').textContent).toContain(
      'handler threw: boom',
    );
  });

  it('shows the queue: depth, today’s cap use, retries and dead letters', () => {
    const s = body({
      deliveries: {
        queued: 1,
        sending: 0,
        held: 0,
        waitingForCap: 0,
        delivered24h: 4,
        dead: 1,
        sentToday: 17,
        dailyCap: 10000,
        lastFailures: [deadLetter, retrying],
      },
    });
    s.routes[0] = {
      ...s.routes[0],
      queueDepth: 1,
      oldestQueueFailure: retrying,
    } as never;
    show(parseRouteStatus(s)!, []);
    const deliveries = screen.getByRole('region', { name: 'Deliveries' });
    const text = deliveries.textContent!;

    expect(text).toContain('Queued: 1');
    expect(text).toContain('Delivered (24 h): 4');
    expect(text).toContain('Dead letters: 1');
    expect(screen.getByTestId('daily-cap').textContent).toBe(
      `Sent today: 17 of ${(10000).toLocaleString()}`,
    );
    expect(text).toContain('Dead letter (gave up after attempt 12)');
    expect(text).toContain('remote.example');
    expect(text).toContain('Answered 404. Not Found');
    expect(text).toContain('Retrying (attempt 3), next at');
    expect(text).toContain('slow.example');
    // The route shows its own queue too.
    expect(screen.getByTestId('route-inbox').textContent).toContain(
      'Deliveries waiting: 1',
    );
    expect(screen.getByTestId('endpoint-state').textContent).toBe('Errors');
  });

  it('says the endpoints are off, in hostFeatureMessage’s words, when the gates hold the release back', () => {
    const refusal = {
      type: 'host-feature-unavailable',
      feature: 'plugin-routes',
      needed: 'read-write',
      compiled: true,
      level: 'read-only',
      surfaces: ['route `POST /inbox`'],
      listeners: [],
      sidecars: [],
    };
    const s = status({
      state: 'degraded',
      level: 'read-only',
      degraded: 'the server’s own sentence',
      refusal,
      deliveries: { ...body().deliveries, held: 2, queued: 2 },
    });
    show(s, []);

    expect(screen.getByTestId('endpoint-state').textContent).toBe('Turned off');
    expect(screen.getByTestId('endpoint-state').dataset.status).toBe(
      'needs-attention',
    );
    expect(screen.getByTestId('endpoints-off').textContent).toContain(
      'Public endpoints are turned off on this server',
    );
    expect(screen.getByTestId('endpoints-off-reason').textContent).toBe(
      hostFeatureMessage(s.refusal!).replaceAll('`', ''),
    );
    // The switch, as code.
    expect(screen.getByText('--plugin-routes read-write').tagName).toBe('CODE');
    expect(
      screen.getByRole('region', { name: 'Deliveries' }).textContent,
    ).toContain('Held while the endpoints are off: 2');
  });

  it('shows the server’s reason when it is degraded for another cause', () => {
    show(
      status({
        state: 'degraded',
        degraded: 'Route `/inbox` collides with another installation',
      }),
    );

    expect(screen.getByTestId('endpoints-off-reason').textContent).toBe(
      'Route /inbox collides with another installation',
    );
    expect(screen.getByText('/inbox').tagName).toBe('CODE');
  });

  it('lists issued tokens and revokes one after confirming', async () => {
    const tokens: RouteToken[] = [
      {
        id: 'tok_1',
        name: 'storage',
        scopes: ['notes:r'],
        client: 'https://app.example',
        issuedAt: 1_700_000_000_000,
      },
    ];
    const { onRevoke } = show(status(), tokens);
    const item = screen.getByTestId('token-tok_1');

    expect(item.textContent).toContain('storage');
    expect(item.textContent).toContain('notes:r');
    expect(item.textContent).toContain('https://app.example');

    fireEvent.click(screen.getByText('Revoke'));
    expect(onRevoke).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('Revoke token'));
    await waitFor(() => expect(onRevoke).toHaveBeenCalledWith('tok_1'));
  });
});

describe('EndpointHealth', () => {
  beforeEach(() => vi.mocked(api.fetchRouteTokens).mockResolvedValue([]));

  it('renders nothing on a server without plugin routes', async () => {
    vi.mocked(api.fetchRouteStatus).mockResolvedValue(undefined);
    const { container } = render(
      withTheme(<EndpointHealth installation={INSTALLATION} />),
    );

    await waitFor(() =>
      expect(api.fetchRouteStatus).toHaveBeenCalledWith(
        expect.anything(),
        INSTALLATION,
      ),
    );
    expect(container.textContent).toBe('');
    expect(api.fetchRouteTokens).not.toHaveBeenCalled();
  });

  it('renders nothing for a plugin without routes', async () => {
    vi.mocked(api.fetchRouteStatus).mockResolvedValue(status({ routes: [] }));
    const { container } = render(
      withTheme(<EndpointHealth installation={INSTALLATION} />),
    );

    await waitFor(() => expect(api.fetchRouteStatus).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('loads the status and tokens, and drops a token once revoked', async () => {
    vi.mocked(api.fetchRouteStatus).mockResolvedValue(status());
    vi.mocked(api.fetchRouteTokens).mockResolvedValue([
      { id: 'tok_1', name: 'storage', scopes: [], issuedAt: 1 },
      { id: 'tok_2', name: 'storage', scopes: [], issuedAt: 2 },
    ]);
    vi.mocked(api.revokeRouteToken).mockResolvedValue(true);
    render(withTheme(<EndpointHealth installation={INSTALLATION} />));

    await screen.findByTestId('token-tok_1');
    fireEvent.click(screen.getAllByText('Revoke')[0]);
    fireEvent.click(screen.getByText('Revoke token'));

    await waitFor(() => expect(screen.queryByTestId('token-tok_1')).toBeNull());
    expect(api.revokeRouteToken).toHaveBeenCalledWith(
      expect.anything(),
      INSTALLATION,
      'tok_1',
    );
    expect(screen.getByTestId('token-tok_2')).toBeTruthy();
  });

  it('shows why the status could not be read', async () => {
    vi.mocked(api.fetchRouteStatus).mockRejectedValue(
      new Error('You are not allowed to read this'),
    );
    render(withTheme(<EndpointHealth installation={INSTALLATION} />));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'You are not allowed to read this',
    );
  });
});

// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import {
  InstallationConnectionsView,
  type InstallationConnectionsViewProps,
} from './InstallationConnections';
import type { ConnectionRequest } from '@helpers/connectionRequests';

vi.mock('@components/Row', () => ({
  Column: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Row: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
}));
vi.mock('@components/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: React.PropsWithChildren<{ onClick?: () => void; disabled?: boolean }>) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));

afterEach(cleanup);

const theme = { colors: {}, radius: '4px' } as unknown as DefaultTheme;

function view(props: Partial<InstallationConnectionsViewProps> = {}) {
  const all: InstallationConnectionsViewProps = {
    canWrite: true,
    platforms: ['demo'],
    pluginName: 'Timesheets',
    connected: {},
    existing: {},
    proxyOrigin: 'https://proxy.test',
    onConnect: vi.fn(),
    onUseExisting: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onDisconnect: vi.fn(),
    onClearRequests: vi.fn(),
    ...props,
  };

  return {
    props: all,
    ...render(
      <ThemeProvider theme={theme}>
        <InstallationConnectionsView {...all} />
      </ThemeProvider>,
    ),
  };
}

it('shows nothing to someone who cannot write the Installation', () => {
  const { container } = view({
    canWrite: false,
    connected: { demo: 'c1' },
    existing: {
      demo: [{ connection_id: 'c0', platform: 'demo', delegations: [] }],
    },
  });
  expect(container.textContent).toBe('');
  expect(screen.queryByRole('button')).toBeNull();
});

it('offers Connect and, when there is one, the existing connection', () => {
  const connection = { connection_id: 'c0', platform: 'demo', delegations: [] };
  const { props } = view({ existing: { demo: [connection] } });

  expect(screen.getByText('Not connected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Connect Demo' }));
  expect(props.onConnect).toHaveBeenCalledWith('demo');
  fireEvent.click(
    screen.getByRole('button', { name: 'Use existing connection' }),
  );
  expect(props.onUseExisting).toHaveBeenCalledWith('demo', connection);
});

it('asks for consent, naming the proxy, before connecting', () => {
  const { props } = view({ ask: { platform: 'demo' } });

  expect(
    screen.getByRole('group', { name: 'Connect an account' }).textContent,
  ).toContain('https://proxy.test');
  fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
  expect(props.onConfirm).toHaveBeenCalled();
});

it('shows the connected state per platform, with Disconnect', () => {
  const { props } = view({
    platforms: ['demo', 'other'],
    connected: { demo: 'c1' },
  });

  expect(screen.getByText('c1')).toBeTruthy();
  expect(screen.getAllByText('Not connected')).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Connect Other' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Connect Demo' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
  expect(props.onDisconnect).toHaveBeenCalledWith('demo');
});

/** An open request from one node, as `readConnectionRequests` returns it. */
const request = (platform = 'clockify'): ConnectionRequest => ({
  subject: `did:ad:request-${platform}`,
  platform,
  reason: 'not-connected',
  requestedAt: Date.UTC(2026, 8, 25, 9, 0),
  runtime: {
    subject: 'did:ad:runtime',
    agent: 'atomic:agent:x',
    label: 'Server',
  },
});

it('shows an open request, with a button that connects that platform', () => {
  const connection = {
    connection_id: 'c0',
    platform: 'clockify',
    delegations: [],
  };
  const { props } = view({
    requests: [request()],
    existing: { clockify: [connection] },
  });

  const notice = screen.getByRole('status');
  expect(notice.textContent).toContain(
    'Timesheets needs a Clockify connection',
  );
  expect(notice.textContent).toContain('Server');
  // The platform gets a row too, although the manifest here only says `demo`.
  expect(screen.getAllByText('Clockify').length).toBeGreaterThan(0);
  // Offered once, on the request, not again on the row.
  expect(
    screen.getAllByRole('button', { name: 'Connect Clockify' }),
  ).toHaveLength(1);
  fireEvent.click(
    within(notice).getByRole('button', { name: 'Connect Clockify' }),
  );
  expect(props.onConnect).toHaveBeenCalledWith('clockify');
  fireEvent.click(
    within(notice).getByRole('button', { name: 'Use existing connection' }),
  );
  expect(props.onUseExisting).toHaveBeenCalledWith('clockify', connection);
});

it('offers to resume, not to connect, when the platform is already connected', () => {
  const { props } = view({
    requests: [request()],
    connected: { clockify: 'c1' },
  });

  const notice = screen.getByRole('status');
  expect(
    within(notice).queryByRole('button', { name: 'Connect Clockify' }),
  ).toBeNull();
  fireEvent.click(within(notice).getByRole('button', { name: 'Resume runs' }));
  expect(props.onClearRequests).toHaveBeenCalledWith('clockify');
});

it('shows the request, without any button, to someone who cannot write the Installation', () => {
  view({ canWrite: false, requests: [request()] });

  expect(screen.getByRole('status').textContent).toContain(
    'Timesheets needs a Clockify connection',
  );
  expect(screen.queryByRole('button')).toBeNull();
});

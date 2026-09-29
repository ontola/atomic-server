// @vitest-environment jsdom
// @wc-ignore-file
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ThemeProvider, type DefaultTheme } from 'styled-components';
import {
  InstallationConnectionsView,
  type InstallationConnectionsViewProps,
} from './InstallationConnections';

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
    connected: {},
    existing: {},
    proxyOrigin: 'https://proxy.test',
    onConnect: vi.fn(),
    onUseExisting: vi.fn(),
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    onDisconnect: vi.fn(),
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

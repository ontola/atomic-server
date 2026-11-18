// @vitest-environment jsdom
// @wc-ignore-file
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import type {
  Resource,
  ResourceSaveState,
  ResourcePeerSyncStatus,
  ResourceSyncStatus,
} from '@tomic/react';
import isPropValid from '@emotion/is-prop-valid';
import { StyleSheetManager, ThemeProvider } from 'styled-components';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildTheme } from '../../styling';
import { ResourceSyncIndicator } from './ResourceSyncIndicator';

let status: ResourceSyncStatus;
let save: ResourceSaveState;
let vaultStatus: {
  state: 'unknown' | 'pending' | 'confirmed';
  confirmedAt?: number;
};
let peerStatus: ResourcePeerSyncStatus;
let isFile = false;
let propagationBoundary: HTMLDivElement | undefined;
const context = {
  drive: 'atomic:workspace',
  serverConnected: true,
  peerStatus: 'Connected to 2 browsers',
  vault: 'enabled',
  lastBackupAt: 1_700_000_000,
};
const resource = {
  subject: 'atomic:notes',
  hasClasses: () => isFile,
} as unknown as Resource;

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useTitle: () => ['Project notes'],
  useSaveState: () => save,
}));
vi.mock('./useResourceSyncStatus', () => ({
  useResourceSyncStatus: () => status,
}));
vi.mock('./useResourceVaultSyncStatus', () => ({
  useResourceVaultSyncStatus: () => vaultStatus,
}));
vi.mock('./useResourcePeerSyncStatus', () => ({
  useResourcePeerSyncStatus: () => peerStatus,
}));
vi.mock('./useResourceCopyContext', () => ({
  useResourceCopyContext: () => context,
}));
vi.mock('../AtomicLink', () => ({
  AtomicLink: ({
    path,
    children,
    onClick,
  }: {
    path: string;
    children: React.ReactNode;
    onClick: () => void;
  }) => (
    <a href={path} onClick={onClick}>
      {children}
    </a>
  ),
}));

beforeEach(() => {
  vaultStatus = { state: 'unknown' };
  peerStatus = {
    state: 'unknown',
    connectedCount: 2,
    confirmedCount: 0,
    peers: [],
  };
  isFile = false;
  status = {
    local: { state: 'confirmed', confirmedAt: 100 },
    server: {
      state: 'confirmed',
      url: 'https://studio.example',
      confirmedAt: 100,
    },
  };
  save = {
    kind: 'idle',
    scheduledCount: 0,
    error: undefined,
    reason: undefined,
  };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  cleanup();
  propagationBoundary?.remove();
  propagationBoundary = undefined;
  vi.unstubAllGlobals();
});

function view() {
  return (
    <StyleSheetManager
      shouldForwardProp={(prop, target) =>
        typeof target !== 'string' || isPropValid(prop)
      }
    >
      <ThemeProvider theme={buildTheme(false, '#1b50d8')}>
        <ResourceSyncIndicator resource={resource} />
      </ThemeProvider>
    </StyleSheetManager>
  );
}

it('opens copies without activating its enclosing row and returns focus on Escape', async () => {
  const navigate = vi.fn();
  propagationBoundary = document.createElement('div');
  document.body.appendChild(propagationBoundary);
  propagationBoundary.addEventListener('click', navigate);
  render(view(), {
    container: propagationBoundary.appendChild(document.createElement('div')),
  });
  const trigger = screen.getByRole('button', {
    name: /Copies and sync for Project notes:/,
  });
  trigger.focus();
  fireEvent.click(trigger);

  const panel = await screen.findByTestId('resource-sync-panel');
  expect(
    within(panel).getByRole('heading', { name: 'Copies & sync' }),
  ).toBeTruthy();
  expect(within(panel).getByText('Saved on this device')).toBeTruthy();
  expect(
    within(panel).getByText('Latest changes saved', { exact: true }),
  ).toBeTruthy();
  expect(navigate).not.toHaveBeenCalled();

  fireEvent.keyDown(document, { key: 'Escape' });
  await waitFor(() =>
    expect(screen.queryByTestId('resource-sync-panel')).toBeNull(),
  );
  await waitFor(() => expect(document.activeElement).toBe(trigger));
  expect(navigate).not.toHaveBeenCalled();
});

it('does not treat a connected server, workspace backup, or peers as resource receipts', async () => {
  status = {
    local: { state: 'unknown' },
    server: { state: 'unknown', url: 'https://studio.example' },
  };
  render(view());
  fireEvent.click(screen.getByTestId('resource-sync-indicator'));
  const panel = await screen.findByTestId('resource-sync-panel');
  const copy = within(panel);

  expect(copy.getByText('Currently connected')).toBeTruthy();
  expect(copy.getByText('Copy not confirmed')).toBeTruthy();
  expect(copy.getByText('Local copy not confirmed')).toBeTruthy();
  expect(copy.getByText('Workspace backup enabled')).toBeTruthy();
  expect(
    copy.getByText(
      `Last workspace backup: ${new Date('2023-11-14T22:13:20Z').toLocaleString()}`,
    ),
  ).toBeTruthy();
  expect(copy.getByText('Resource backup not confirmed')).toBeTruthy();
  expect(copy.getByText('Resource copies not confirmed')).toBeTruthy();
  expect(copy.queryByText('Latest changes saved', { exact: true })).toBeNull();
  expect(copy.queryByText('Saved on this device')).toBeNull();
});

it('updates exact vault proof in the open panel without changing the server receipt', async () => {
  const rendered = render(view());
  fireEvent.click(screen.getByTestId('resource-sync-indicator'));
  const panel = await screen.findByTestId('resource-sync-panel');
  expect(within(panel).getByText('Resource backup not confirmed')).toBeTruthy();

  vaultStatus = { state: 'confirmed', confirmedAt: 1_700_000_000_000 };
  rendered.rerender(view());
  expect(within(panel).getByText('Latest changes backed up')).toBeTruthy();
  expect(
    within(panel).getByText('Latest changes saved', { exact: true }),
  ).toBeTruthy();
  expect(
    within(panel).getByText(
      `Last confirmed backup: ${new Date('2023-11-14T22:13:20Z').toLocaleString()}`,
    ),
  ).toBeTruthy();

  vaultStatus = { ...vaultStatus, state: 'pending' };
  rendered.rerender(view());
  expect(within(panel).getByText('Changes waiting for backup')).toBeTruthy();
  expect(within(panel).queryByText('Latest changes backed up')).toBeNull();
  expect(
    within(panel).getByText('Latest changes saved', { exact: true }),
  ).toBeTruthy();
});

it('keeps the file-content limitation visible when its resource metadata is backed up', async () => {
  isFile = true;
  vaultStatus = { state: 'confirmed' };
  render(view());
  fireEvent.click(screen.getByTestId('resource-sync-indicator'));
  const panel = await screen.findByTestId('resource-sync-panel');
  expect(within(panel).getByText('Latest changes backed up')).toBeTruthy();
  expect(
    within(panel).getByText(
      'These confirmations cover file details. The file’s contents are not verified here.',
    ),
  ).toBeTruthy();
});

it('updates an open panel when a newer edit is queued while keeping its local confirmation', async () => {
  const rendered = render(view());
  fireEvent.click(screen.getByTestId('resource-sync-indicator'));
  await screen.findByTestId('resource-sync-panel');

  status = { ...status, server: { ...status.server, state: 'pending' } };
  save = { ...save, kind: 'queued', reason: 'offline' };
  rendered.rerender(view());
  const panel = screen.getByTestId('resource-sync-panel');
  expect(within(panel).getByText('Saved on this device')).toBeTruthy();
  expect(
    within(panel).queryByText('Latest changes saved', { exact: true }),
  ).toBeNull();
  expect(
    screen.getByRole('button', {
      name: 'Copies and sync for Project notes: Changes waiting to sync',
    }),
  ).toBeTruthy();
  expect(
    within(panel).getAllByText('Changes waiting to sync').length,
  ).toBeGreaterThan(0);
});

it('shows exact distinct browser receipts and removes them when peers leave', async () => {
  status = { ...status, server: { state: 'not-configured' } };
  const rendered = render(view());
  fireEvent.click(screen.getByTestId('resource-sync-indicator'));
  const panel = await screen.findByTestId('resource-sync-panel');
  expect(within(panel).getByText('Resource copies not confirmed')).toBeTruthy();
  expect(within(panel).getByText('Confirmed peer copies: 0')).toBeTruthy();
  peerStatus = {
    state: 'confirmed',
    connectedCount: 1,
    confirmedCount: 1,
    peers: [
      {
        connectionId: 'connection-a',
        peerAgent: 'atomic:agent:peer',
        state: 'confirmed',
        confirmedAt: 1_700_000_000_000,
        storageId: 'independent-db',
        generation: '1',
      },
    ],
  };
  rendered.rerender(view());
  expect(within(panel).getByRole('status').textContent).toBe(
    'Latest changes received by peers',
  );
  expect(within(panel).getByText('Confirmed peer copies: 1')).toBeTruthy();
  const copies = within(panel).getByRole('list', {
    name: 'Peer resource copies',
  });
  expect(within(copies).getAllByRole('listitem')).toHaveLength(1);
  expect(within(copies).getByText('Peer 1')).toBeTruthy();
  expect(
    within(copies).getByText(
      `Last confirmed: ${new Date(1_700_000_000_000).toLocaleString()}`,
    ),
  ).toBeTruthy();
  expect(
    within(panel).getByText(
      'Peers may become unavailable when browser tabs or apps close.',
    ),
  ).toBeTruthy();
  peerStatus = {
    ...peerStatus,
    state: 'pending',
    confirmedCount: 0,
    peers: [{ ...peerStatus.peers[0], state: 'pending' }],
  };
  rendered.rerender(view());
  expect(within(panel).getByRole('status').textContent).toBe(
    'Changes waiting for peers',
  );
  expect(
    within(panel).queryByText('Latest changes received', { exact: true }),
  ).toBeNull();
  expect(within(panel).getByText('Saved on this device')).toBeTruthy();
  peerStatus = {
    state: 'unknown',
    connectedCount: 0,
    confirmedCount: 0,
    peers: [],
  };
  rendered.rerender(view());
  expect(within(panel).getByText('Resource copies not confirmed')).toBeTruthy();
  expect(
    within(panel).queryByRole('list', { name: 'Peer resource copies' }),
  ).toBeNull();
  expect(within(panel).queryByText(/^Last confirmed:/)).toBeNull();
});

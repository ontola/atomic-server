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
  ResourceSyncStatus,
} from '@tomic/react';
import isPropValid from '@emotion/is-prop-valid';
import { StyleSheetManager, ThemeProvider } from 'styled-components';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { buildTheme } from '../../styling';
import { ResourceSyncIndicator } from './ResourceSyncIndicator';

let status: ResourceSyncStatus;
let save: ResourceSaveState;
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
  hasClasses: () => false,
} as unknown as Resource;

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useTitle: () => ['Project notes'],
  useSaveState: () => save,
}));
vi.mock('./useResourceSyncStatus', () => ({
  useResourceSyncStatus: () => status,
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
  expect(
    copy.getByText('This resource’s latest backup is not confirmed here.'),
  ).toBeTruthy();
  expect(
    copy.getByText(
      'Workspace connection only. Resource copies are not confirmed.',
    ),
  ).toBeTruthy();
  expect(copy.queryByText('Latest changes saved', { exact: true })).toBeNull();
  expect(copy.queryByText('Saved on this device')).toBeNull();
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

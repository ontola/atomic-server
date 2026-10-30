// @vitest-environment jsdom
// @wc-ignore-file
import React, { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { StoreContext, type Store } from '@tomic/react';
import { useAppFrameIdentity } from './appFrameIdentity';
import { fetchRowGrant, notifyRowGrantChange, type RowGrant } from './rowGrant';

vi.mock('./rowGrant', async () => ({
  ...(await vi.importActual<typeof import('./rowGrant')>('./rowGrant')),
  fetchRowGrant: vi.fn(),
}));

const target = { drive: 'drive', table: 'table', app: 'app' };

const store = {
  getDrive: () => 'drive',
  getAgent: () => ({ subject: 'agent' }),
} as unknown as Store;
let upstream: RowGrant | null;
let mounts: number;

beforeEach(() => {
  mounts = 0;
  upstream = null;
  vi.mocked(fetchRowGrant).mockReset();
  vi.mocked(fetchRowGrant).mockImplementation(async () => ({
    grant: upstream,
    history: [],
  }));
});
afterEach(cleanup);

/** A mounted guest reads its permission once, as the existing Keep view did. */
function Guest() {
  const [permission] = useState(() => {
    mounts++;

    return upstream ? 'editable' : 'read-only';
  });

  return <p>{permission}</p>;
}

function Frame({ resource }: { resource?: string }) {
  const identity = useAppFrameIdentity({
    app: 'app',
    drive: 'drive',
    table: 'table',
    view: 'view',
    resource,
  });

  return <Guest key={identity} />;
}

function mount(resource?: string) {
  return render(
    <StoreContext.Provider value={store}>
      <Frame resource={resource} />
    </StoreContext.Provider>,
  );
}

it('refreshes an initially ungranted guest when Add view finishes granting, and again on revoke', async () => {
  mount();
  await waitFor(() => expect(screen.getByText('read-only')).toBeTruthy());
  expect(screen.getByText('read-only')).toBeTruthy();
  expect(mounts).toBe(1);

  // The initial guest mounted while the Add-view grant POST was still in
  // flight. Only its successful acknowledgement emits this notification.
  upstream = { id: 'acknowledged-grant' } as RowGrant;
  await act(async () => notifyRowGrantChange(target));
  await screen.findByText('editable');
  expect(mounts).toBe(2);

  upstream = null;
  await act(async () => notifyRowGrantChange(target));
  await screen.findByText('read-only');
  expect(mounts).toBe(3);
});

it('does not use or refresh from a table grant when showing a single resource', async () => {
  mount('note');
  expect(screen.getByText('read-only')).toBeTruthy();
  upstream = { id: 'another-table-grant' } as RowGrant;
  await act(async () => notifyRowGrantChange(target));
  await waitFor(() => expect(screen.getByText('read-only')).toBeTruthy());
  expect(fetchRowGrant).not.toHaveBeenCalled();
  expect(mounts).toBe(1);
});

it('keeps an already-granted guest mounted during initial status loading and ignores unrelated acknowledgements', async () => {
  upstream = { id: 'existing-grant' } as RowGrant;
  mount();
  expect(screen.getByText('editable')).toBeTruthy();
  await act(async () => {
    await Promise.resolve();
  });
  expect(fetchRowGrant).not.toHaveBeenCalled();
  expect(mounts).toBe(1);

  for (const unrelated of [
    { ...target, app: 'another-app' },
    { ...target, table: 'another-table' },
    { ...target, drive: 'another-drive' },
  ])
    await act(async () => notifyRowGrantChange(unrelated));
  expect(mounts).toBe(1);

  // A legacy unscoped notification still invalidates actual table views.
  await act(async () => notifyRowGrantChange());
  expect(mounts).toBe(2);
});

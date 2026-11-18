// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type { DrivePieces, StoredLens } from './loadPieces';
import type { PieceInfo } from './offers';

const loadPieces = vi.fn<() => Promise<DrivePieces>>();

// One store for every render, as the real `useStore` gives.
const store = {};
vi.mock('@tomic/react', () => ({ useStore: () => store }));
vi.mock('./loadPieces', () => ({ loadPieces: () => loadPieces() }));

const { usePieceOffers } = await import('./usePieceOffers');

afterEach(() => {
  cleanup();
  loadPieces.mockReset();
});

const TIME_ENTRY = 'https://drive.example/classes/time-entry';
const TOGGL = 'https://drive.example/classes/toggl-time-entry';

const toggl: PieceInfo = {
  subject: 'https://drive.example/apps/toggl',
  name: 'Toggl Track',
  kind: 'integration',
  renders: [TOGGL],
};

const lens = (trusted: boolean): StoredLens => ({
  subject: 'https://drive.example/lenses/entry-toggl',
  name: 'Time entry ↔ Toggl time entry',
  source: TIME_ENTRY,
  target: TOGGL,
  trusted,
  origin: 'drive',
  mapping: { version: 1, fields: [] },
});

it('re-reads lenses on refresh, so an approved lens stops waiting for review', async () => {
  loadPieces.mockResolvedValue({ pieces: [toggl], lenses: [lens(false)] });

  const { result } = renderHook(() =>
    usePieceOffers('https://drive.example', [], TIME_ENTRY, true),
  );

  await waitFor(() => expect(result.current.integrations).toHaveLength(1));
  expect(result.current.integrations[0].pendingReview).toHaveLength(1);

  // The lens is approved elsewhere; nothing about the drive's apps changed.
  loadPieces.mockResolvedValue({ pieces: [toggl], lenses: [lens(true)] });
  act(() => result.current.refresh());

  await waitFor(() =>
    expect(result.current.integrations[0].pendingReview).toHaveLength(0),
  );
  expect(loadPieces).toHaveBeenCalledTimes(2);
});

it('reads nothing while the exploration is off', () => {
  const { result } = renderHook(() =>
    usePieceOffers('https://drive.example', [], TIME_ENTRY, false),
  );

  act(() => result.current.refresh());
  expect(loadPieces).not.toHaveBeenCalled();
  expect(result.current.integrations).toEqual([]);
});

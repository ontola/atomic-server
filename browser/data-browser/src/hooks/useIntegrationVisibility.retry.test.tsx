// @vitest-environment jsdom
// @wc-ignore-file
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useIntegrationVisibility } from './useIntegrationVisibility';

const DRIVE = 'atomic:drive';
const ACTOR = 'atomic:agent';

const driveResource = {
  get: () => undefined,
  loading: false,
  error: new Error(
    `Async Request for subject ${DRIVE} timed out after 10000ms`,
  ) as Error | undefined,
};
const store = {
  getResource: vi.fn(async () => driveResource),
  fetchResourceFromServer: vi.fn(async () => {
    driveResource.error = undefined;

    return driveResource;
  }),
  getAgent: () => ({ subject: ACTOR }),
};

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useStore: () => store,
  useResource: () => ({ ...driveResource }),
  useCurrentAgent: () => [{ subject: ACTOR }],
}));
vi.mock('./usePrivateDrive', () => ({
  usePrivateDrive: () => ({ privateDrive: DRIVE, loading: false }),
}));

afterEach(() => {
  cleanup();
  localStorage.clear();
});

it('becomes ready after a read that failed, without a reload', async () => {
  // One timed-out read of the private drive used to leave this panel unready
  // for as long as the tab stayed open, with the checkboxes unusable.
  const { result, rerender } = renderHook(() => useIntegrationVisibility());

  expect(result.current.ready).toBe(false);
  expect(result.current.error).toBeDefined();

  // The retry has to go back to the server: the store answers a read that
  // failed with the same error for as long as the tab is open.
  await waitFor(() =>
    expect(store.fetchResourceFromServer).toHaveBeenCalledWith(DRIVE),
  );
  rerender();
  expect(result.current.ready).toBe(true);
  expect(result.current.error).toBeUndefined();
});

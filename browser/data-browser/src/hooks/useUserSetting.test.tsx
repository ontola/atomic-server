// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/react';

const mocks = vi.hoisted(() => ({
  ready: true,
  remote: undefined as unknown,
  setRemote: vi.fn(),
  privateDrive: 'did:ad:home' as string | undefined,
}));

vi.mock('@tomic/react', () => ({
  useStore: () => ({
    getResource: async () => ({
      set: async (_: string, value: unknown) => mocks.setRemote(value),
      save: async () => undefined,
    }),
  }),
  useResourceSnapshot: () => ({ resource: {}, ready: mocks.ready }),
  useValue: () => [mocks.remote],
}));
vi.mock('./usePrivateDrive', () => ({
  usePrivateDrive: () => ({ privateDrive: mocks.privateDrive }),
}));

const { useUserSetting, retryDriveRead } = await import('./useUserSetting');

beforeEach(() => {
  mocks.ready = true;
  mocks.remote = undefined;
  mocks.privateDrive = 'did:ad:home';
  mocks.setRemote.mockReset();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const render = () =>
  renderHook(() => useUserSetting<boolean>('p:open', 'k.open', true));

it('reads the drive value over the local one', () => {
  window.localStorage.setItem('k.open', 'true');
  mocks.remote = false;

  expect(render().result.current[0]).toBe(false);
});

it('falls back to the default, then to the local value', () => {
  expect(render().result.current[0]).toBe(true);
  cleanup();
  window.localStorage.setItem('k.open', 'false');
  mocks.ready = false;
  expect(render().result.current[0]).toBe(false);
});

it('writes to the drive and keeps a local copy', async () => {
  const hook = render();

  act(() => hook.result.current[1](false));
  await vi.waitFor(() => expect(mocks.setRemote).toHaveBeenCalledWith(false));
  expect(window.localStorage.getItem('k.open')).toBe('false');
});

it('writes only locally while the drive is not readable', () => {
  mocks.ready = false;
  const hook = render();

  act(() => hook.result.current[1](false));
  expect(mocks.setRemote).not.toHaveBeenCalled();
  expect(hook.result.current[0]).toBe(false);
});

it('moves an existing local value onto the drive once it is readable', async () => {
  window.localStorage.setItem('k.open', 'false');
  mocks.ready = false;
  const hook = render();

  expect(mocks.setRemote).not.toHaveBeenCalled();
  mocks.ready = true;
  hook.rerender();
  await vi.waitFor(() => expect(mocks.setRemote).toHaveBeenCalledWith(false));
});

it('does not migrate over a value the drive already has', () => {
  window.localStorage.setItem('k.open', 'false');
  mocks.remote = true;
  render();

  expect(mocks.setRemote).not.toHaveBeenCalled();
});

describe('retryDriveRead', () => {
  afterEach(() => vi.useRealTimers());

  it('asks the server again until the drive reads without an error', async () => {
    vi.useFakeTimers();
    const fetchResourceFromServer = vi
      .fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValueOnce({ error: new Error('could not be read') })
      .mockResolvedValue({});
    const stop = retryDriveRead(
      { fetchResourceFromServer } as unknown as Store,
      'atomic:drive',
    );

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchResourceFromServer).toHaveBeenCalledTimes(3);
    expect(fetchResourceFromServer).toHaveBeenCalledWith('atomic:drive');
    stop();
  });

  it('stops asking when cancelled', async () => {
    vi.useFakeTimers();
    const fetchResourceFromServer = vi.fn();

    retryDriveRead(
      { fetchResourceFromServer } as unknown as Store,
      'atomic:drive',
    )();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchResourceFromServer).not.toHaveBeenCalled();
  });
});

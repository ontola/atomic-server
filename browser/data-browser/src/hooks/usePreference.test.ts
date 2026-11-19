// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Store } from '@tomic/react';
import { preferenceProperties } from '@helpers/preferences';
import { retryDriveRead, usePreference } from './usePreference';

const DRIVE = 'atomic:drive';
const state = vi.hoisted(() => ({
  actor: undefined as string | undefined,
  saved: {} as Record<string, unknown>,
}));
const drive = { set: vi.fn(), save: vi.fn(async () => undefined) };
const store = {
  getResource: vi.fn(async () => drive),
  getAgent: () => (state.actor ? { subject: state.actor } : undefined),
};

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useStore: () => store,
  useResource: () => ({ loading: false, error: undefined }),
  useValue: (_: unknown, property: string) => [state.saved[property], vi.fn()],
  useCurrentAgent: () => [state.actor ? { subject: state.actor } : undefined],
}));
vi.mock('./usePrivateDrive', () => ({
  usePrivateDrive: () => ({
    privateDrive: state.actor ? DRIVE : undefined,
    loading: false,
  }),
}));

const { hideTemplates, theme } = preferenceProperties;

beforeEach(() => {
  localStorage.clear();
  state.actor = undefined;
  state.saved = {};
  vi.clearAllMocks();
});
afterEach(cleanup);

describe('usePreference', () => {
  it('is plain local storage without an agent', () => {
    const { result } = renderHook(() => usePreference(hideTemplates, false));

    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem('hideTemplates')).toBe('true');
    expect(store.getResource).not.toHaveBeenCalled();
  });

  it('falls back to the legacy key, then the default', () => {
    localStorage.setItem('darkMode', '"always"');
    expect(
      renderHook(() => usePreference(theme, 'auto')).result.current[0],
    ).toBe('dark');
    expect(
      renderHook(() => usePreference(hideTemplates, false)).result.current[0],
    ).toBe(false);
  });

  it('writes a legacy choice to a drive that has no value, once', async () => {
    state.actor = 'did:ad:alice';
    localStorage.setItem('hideTemplates', 'true');
    renderHook(() => usePreference(hideTemplates, false));

    await waitFor(() => expect(drive.save).toHaveBeenCalledTimes(1));
    expect(drive.set).toHaveBeenCalledWith(hideTemplates, true);
  });

  it('prefers the drive value over the legacy key', () => {
    state.actor = 'did:ad:alice';
    state.saved[theme] = 'light';
    localStorage.setItem('darkMode', '"always"');
    const { result } = renderHook(() => usePreference(theme, 'auto'));

    expect(result.current[0]).toBe('light');
    expect(drive.set).not.toHaveBeenCalled();
  });

  it('applies a change at once and saves it in the background', async () => {
    state.actor = 'did:ad:alice';
    const { result } = renderHook(() => usePreference(theme, 'auto'));

    act(() => result.current[1]('dark'));
    expect(result.current[0]).toBe('dark');
    expect(localStorage.getItem('darkMode')).toBe('"always"');
    await waitFor(() => expect(drive.set).toHaveBeenCalledWith(theme, 'dark'));
    await waitFor(() =>
      expect(localStorage.getItem('preferences-pending:did:ad:alice')).toBe(
        '{}',
      ),
    );
  });
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

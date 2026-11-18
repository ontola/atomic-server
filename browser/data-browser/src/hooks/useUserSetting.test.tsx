// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  drive: { isReady: () => true } as { isReady: () => boolean },
  canWrite: true,
  remote: undefined as unknown,
  setRemote: vi.fn(),
  privateDrive: 'did:ad:home' as string | undefined,
}));

vi.mock('@tomic/react', () => ({
  urls: { properties: { onboardingPanelOpen: 'p:open', welcomeDrive: 'p:wd' } },
  useResource: () => mocks.drive,
  useCanWrite: () => mocks.canWrite,
  useValue: () => [mocks.remote, mocks.setRemote],
}));
vi.mock('./usePrivateDrive', () => ({
  usePrivateDrive: () => ({ privateDrive: mocks.privateDrive }),
}));

const { useUserSetting } = await import('./useUserSetting');

beforeEach(() => {
  mocks.drive = { isReady: () => true };
  mocks.canWrite = true;
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
  mocks.canWrite = false;
  expect(render().result.current[0]).toBe(false);
});

it('writes to the drive and keeps a local copy', () => {
  const hook = render();

  act(() => hook.result.current[1](false));
  expect(mocks.setRemote).toHaveBeenCalledWith(false);
  expect(window.localStorage.getItem('k.open')).toBe('false');
});

it('writes only locally while the drive is not writable', () => {
  mocks.canWrite = false;
  const hook = render();

  act(() => hook.result.current[1](false));
  expect(mocks.setRemote).not.toHaveBeenCalled();
  expect(hook.result.current[0]).toBe(false);
});

it('moves an existing local value onto the drive once it is writable', () => {
  window.localStorage.setItem('k.open', 'false');
  mocks.canWrite = false;
  const hook = render();

  expect(mocks.setRemote).not.toHaveBeenCalled();
  mocks.canWrite = true;
  hook.rerender();
  expect(mocks.setRemote).toHaveBeenCalledWith(false);
});

it('does not migrate over a value the drive already has', () => {
  window.localStorage.setItem('k.open', 'false');
  mocks.remote = true;
  render();

  expect(mocks.setRemote).not.toHaveBeenCalled();
});

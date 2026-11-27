// @wc-ignore-file
import { expect, it, vi } from 'vitest';
import type { NativeChannel } from '@tomic/lib';

const state = vi.hoisted(() => ({
  mockModuleLoads: 0,
  flutter: undefined as { postMessage(message: string): void } | undefined,
  flutterChannel: vi.fn(),
  createFlutterHost: vi.fn(),
  createMockHost: vi.fn(),
}));
vi.mock('./flutterHost', () => ({
  flutterChannel: () => {
    state.flutterChannel();

    return state.flutter;
  },
  createFlutterHost: (...args: unknown[]) => state.createFlutterHost(...args),
}));
vi.mock('./mockHost', () => {
  state.mockModuleLoads++;

  return { createMockHost: () => state.createMockHost() };
});

it('loads the mock only for a hostless browser while real host selection stays synchronous', async () => {
  const { selectEmbedHost } = await import('./selectHost');
  const native = { call: vi.fn() } as NativeChannel;
  const flutter = { call: vi.fn() } as NativeChannel;
  const mock = { call: vi.fn() } as NativeChannel;
  state.flutter = { postMessage: vi.fn() };
  state.createFlutterHost.mockReturnValue(flutter);
  state.createMockHost.mockReturnValue(mock);

  expect(selectEmbedHost(native)).toBe(native);
  expect(state.flutterChannel).not.toHaveBeenCalled();
  expect(state.createFlutterHost).not.toHaveBeenCalled();
  expect(state.mockModuleLoads).toBe(0);
  expect(state.createMockHost).not.toHaveBeenCalled();

  expect(selectEmbedHost()).toBe(flutter);
  expect(state.createFlutterHost).toHaveBeenCalledWith(state.flutter);
  expect(state.mockModuleLoads).toBe(0);

  state.flutter = undefined;
  const browser = selectEmbedHost();
  expect(browser).toBeInstanceOf(Promise);
  expect(await browser).toBe(mock);
  expect(state.mockModuleLoads).toBe(1);
  expect(state.createMockHost).toHaveBeenCalledTimes(1);

  expect(selectEmbedHost(native)).toBe(native);
  expect(state.createMockHost).toHaveBeenCalledTimes(1);
});

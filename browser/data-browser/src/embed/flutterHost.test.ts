// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createFlutterHost,
  flutterChannel,
  lockFlutterChannel,
  selectEmbedHost,
} from './flutterHost';

const mock = vi.hoisted(() => ({
  loaded: vi.fn(),
  create: vi.fn(),
}));

vi.mock('./mockHost', () => {
  mock.loaded();

  return { createMockHost: mock.create };
});

describe('selectEmbedHost', () => {
  beforeEach(() => {
    mock.create.mockClear();
  });

  afterEach(() => {
    delete window.AtomicFlutter;
    window.history.replaceState(null, '', '/');
    lockFlutterChannel();
  });

  it('uses the native host before Flutter without loading browser fixtures', async () => {
    const native = { call: vi.fn() };
    const flutter = { postMessage: vi.fn() };

    expect(await selectEmbedHost(native, flutter)).toBe(native);
    expect(flutter.postMessage).not.toHaveBeenCalled();
    expect(mock.loaded).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();
  });

  it('uses the locked Flutter channel without loading browser fixtures', async () => {
    const post = vi.fn();

    window.AtomicFlutter = { postMessage: post };
    window.history.replaceState(null, '', '/embed#ch=secret');
    lockFlutterChannel();

    const channel = await selectEmbedHost(undefined, flutterChannel());
    const reply = channel.call('agent', []);
    const message = JSON.parse(post.mock.calls[0][0]);

    expect(message).toEqual({
      token: 'secret',
      id: 1,
      method: 'agent',
      args: [],
    });
    expect(window.location.hash).toBe('');
    expect(mock.loaded).not.toHaveBeenCalled();
    expect(mock.create).not.toHaveBeenCalled();

    const hostWindow = window as unknown as {
      __atomicReply(id: number, ok: boolean, payload: string): void;
    };

    hostWindow.__atomicReply(
      message.id,
      true,
      JSON.stringify('signed-in agent'),
    );
    await expect(reply).resolves.toBe('signed-in agent');
  });

  it('loads the browser mock only when neither native channel exists', async () => {
    const channel = { call: vi.fn() };

    mock.create.mockReturnValue(channel);

    expect(await selectEmbedHost(undefined, undefined)).toBe(channel);
    expect(mock.loaded).toHaveBeenCalledOnce();
    expect(mock.create).toHaveBeenCalledOnce();
  });
});

describe('lockFlutterChannel', () => {
  afterEach(() => {
    delete window.AtomicFlutter;
    window.history.replaceState(null, '', '/');
  });

  it('adds the token to every message and removes it from the URL', () => {
    const post = vi.fn();

    window.AtomicFlutter = { postMessage: post };
    window.history.replaceState(null, '', '/embed?a=1#k=v&ch=secret');

    expect(lockFlutterChannel()).toBe('secret');
    expect(window.location.hash).toBe('#k=v');
    expect(window.location.search).toBe('?a=1');

    flutterChannel()!.postMessage(JSON.stringify({ method: 'ready' }));
    createFlutterHost(flutterChannel()!).call('agent', []);
    // The WebView's own bridge is not redefined.
    expect(window.AtomicFlutter!.postMessage).toBe(post);

    const [ready, call] = post.mock.calls.map(c => JSON.parse(c[0]));

    expect(post.mock.calls[0][0].startsWith('{"token":"secret",')).toBe(true);
    expect(ready).toEqual({ token: 'secret', method: 'ready' });
    expect(call).toEqual({ token: 'secret', id: 1, method: 'agent', args: [] });
  });

  it('drops the whole fragment when only the token was in it', () => {
    window.AtomicFlutter = { postMessage: vi.fn() };
    window.history.replaceState(null, '', '/embed#ch=secret');
    lockFlutterChannel();

    expect(window.location.href.endsWith('/embed')).toBe(true);
  });

  it('works when the bridge cannot be redefined', () => {
    const post = vi.fn();

    Object.defineProperty(window, 'AtomicFlutter', {
      value: { postMessage: post },
      configurable: true,
      writable: false,
    });
    window.history.replaceState(null, '', '/embed#ch=secret');

    expect(lockFlutterChannel()).toBe('secret');
    flutterChannel()!.postMessage('{"method":"ready"}');
    expect(post).toHaveBeenCalledWith('{"token":"secret","method":"ready"}');
  });

  it('leaves the channel alone without a token', () => {
    const channel = { postMessage: vi.fn() };

    window.AtomicFlutter = channel;

    expect(lockFlutterChannel()).toBeUndefined();
    expect(window.AtomicFlutter).toBe(channel);
    expect(flutterChannel()).toBe(channel);
  });
});

// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createFlutterHost,
  flutterChannel,
  lockFlutterChannel,
} from './flutterHost';

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

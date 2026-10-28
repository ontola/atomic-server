import type { NativeChannel } from '@tomic/lib';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

/**
 * Locks the app's channel to this page. The app puts a secret in the URL
 * fragment (`#ch=<token>`); this reads it once, removes it from the URL
 * (other fragment content stays) and makes every message carry it as its
 * first key, which the app checks. Android gives the channel to every frame
 * of the web view, so an app's sandboxed frame could post to it, but it
 * never saw the token.
 *
 * Returns the token, or undefined when the URL had none (a host that does not
 * check).
 */
export function lockFlutterChannel(win: Window = window): string | undefined {
  const channel = (win as { AtomicFlutter?: { postMessage(m: string): void } })
    .AtomicFlutter;
  const params = new URLSearchParams(win.location.hash.replace(/^#/, ''));
  const token = params.get('ch');

  if (!token) return undefined;

  params.delete('ch');
  const rest = params.toString();

  win.history.replaceState(
    win.history.state,
    '',
    win.location.pathname + win.location.search + (rest ? `#${rest}` : ''),
  );

  if (channel) {
    const post = channel.postMessage.bind(channel);
    const prefix = `{"token":${JSON.stringify(token)}`;
    const locked = {
      postMessage(message: string) {
        post(
          message.startsWith('{') && message !== '{}'
            ? `${prefix},${message.slice(1)}`
            : `${prefix}}`,
        );
      },
    };

    Object.defineProperty(win, 'AtomicFlutter', {
      value: locked,
      configurable: true,
      writable: true,
    });
  }

  return token;
}

/**
 * The channel inside the Flutter app. A call is a message on Flutter's
 * `JavaScriptChannel` (`{id, method, args}`); the app answers by calling
 * `window.__atomicReply(id, ok, payload)`, `payload` being the JSON of the
 * result, or the error text.
 */
export function createFlutterHost(channel: {
  postMessage(message: string): void;
}): NativeChannel {
  const pending = new Map<number, Pending>();
  let next = 0;

  Object.assign(window, {
    __atomicReply(id: number, ok: boolean, payload: string) {
      const waiting = pending.get(id);

      if (!waiting) return;

      pending.delete(id);

      if (ok) {
        waiting.resolve(JSON.parse(payload));
      } else {
        waiting.reject(new Error(payload));
      }
    },
  });

  return {
    call(method, args) {
      return new Promise((resolve, reject) => {
        const id = ++next;

        pending.set(id, { resolve, reject });
        channel.postMessage(JSON.stringify({ id, method, args }));
      });
    },
  };
}

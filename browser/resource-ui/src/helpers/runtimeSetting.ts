// @wc-ignore-file

import { isLoopbackHost } from '@tomic/lib';

/** HTTPS anywhere; plain HTTP only on loopback. */
export const isHttpsOrLoopback = (url: URL) =>
  url.protocol === 'https:' ||
  (url.protocol === 'http:' && isLoopbackHost(url.hostname));

/**
 * A build-time default that fails validation would make every read throw,
 * including on the settings screen that could fix it. Fall back to the
 * compiled-in value instead.
 */
export function validDefault(
  configured: string | undefined,
  validate: (value: string) => string,
  fallback: string,
): string {
  if (!configured) return fallback;

  try {
    return validate(configured);
  } catch {
    return fallback;
  }
}

/**
 * `useSyncExternalStore` subscription for a localStorage-backed setting:
 * `event` fires on a change in this tab, `storage` on one in another tab.
 */
export function subscribeToSetting(event: string) {
  return (listener: () => void) => {
    window.addEventListener(event, listener);
    window.addEventListener('storage', listener);

    return () => {
      window.removeEventListener(event, listener);
      window.removeEventListener('storage', listener);
    };
  };
}

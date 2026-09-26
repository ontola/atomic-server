// @wc-ignore-file
import { useSyncExternalStore } from 'react';
import {
  isHttpsOrLoopback,
  subscribeToSetting,
  validDefault,
} from './runtimeSetting';

/** The public LocalThought integration proxy. */
const DEFAULT_PROXY = 'https://localthought.io';
const storageKey = 'integration-proxy-url';

/** A bare HTTPS (or loopback HTTP) origin, or it throws. */
function proxyOrigin(value: string): string {
  const url = new URL(value);

  if (url.origin !== value || !isHttpsOrLoopback(url)) {
    throw new Error('Proxy must be an HTTPS origin or localhost');
  }

  return value;
}

// `proxyOrigin` rejects anything but a bare origin, so a build-time default
// with a path falls back to the compiled-in proxy.
export const defaultIntegrationProxy: string = validDefault(
  import.meta.env.VITE_INTEGRATION_PROXY_URL,
  proxyOrigin,
  DEFAULT_PROXY,
);

export const getIntegrationProxy = (): string => {
  // Seeded before the first paint by anything that can write localStorage for
  // the origin — the settings screen, or playwright's `storageState`. A stored
  // value that no longer validates (hand-edited, or left by an older build)
  // falls back to the default rather than throwing out of a render.
  try {
    return proxyOrigin(
      localStorage.getItem(storageKey) || defaultIntegrationProxy,
    );
  } catch {
    return defaultIntegrationProxy;
  }
};

const event = 'integration-proxy-change';

/** Saves a proxy origin; empty resets to the default. Throws when invalid. */
export function setIntegrationProxy(value: string) {
  const trimmed = value.trim();

  if (trimmed) {
    localStorage.setItem(storageKey, proxyOrigin(trimmed.replace(/\/$/, '')));
  } else {
    localStorage.removeItem(storageKey);
  }

  window.dispatchEvent(new Event(event));
}

const subscribe = subscribeToSetting(event);

export const useIntegrationProxy = () =>
  useSyncExternalStore(subscribe, getIntegrationProxy);

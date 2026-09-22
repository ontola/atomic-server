// @wc-ignore-file
import { useSyncExternalStore } from 'react';
import {
  configuredProxy,
  saveProxy,
} from '../../../../integrations/localthought/settings';
import {
  DEFAULT_PROXY,
  proxyOrigin,
} from '../../../../integrations/localthought/browser';

// A build-time default that isn't a bare origin (`proxyOrigin` rejects a path)
// would make every read throw, including the settings screen that could fix
// it. Fall back to the compiled-in proxy instead.
function validDefault(): string {
  const configured = import.meta.env.VITE_INTEGRATION_PROXY_URL;

  if (!configured) return DEFAULT_PROXY;

  try {
    return proxyOrigin(configured);
  } catch {
    return DEFAULT_PROXY;
  }
}

export const defaultIntegrationProxy: string = validDefault();

export const getIntegrationProxy = (): string => {
  // Seeded before the first paint by anything that can write localStorage for
  // the origin — the settings screen, or playwright's `storageState`. A stored
  // value that no longer validates (hand-edited, or left by an older build)
  // falls back to the default rather than throwing out of a render.
  try {
    return configuredProxy(localStorage, defaultIntegrationProxy);
  } catch {
    return defaultIntegrationProxy;
  }
};

const event = 'integration-proxy-change';

export function setIntegrationProxy(value: string) {
  saveProxy(localStorage, value);
  window.dispatchEvent(new Event(event));
}

function subscribe(listener: () => void) {
  window.addEventListener(event, listener);
  window.addEventListener('storage', listener);

  return () => {
    window.removeEventListener(event, listener);
    window.removeEventListener('storage', listener);
  };
}

export const useIntegrationProxy = () =>
  useSyncExternalStore(subscribe, getIntegrationProxy);

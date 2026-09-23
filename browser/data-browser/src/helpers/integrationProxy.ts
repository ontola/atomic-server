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
import { subscribeToSetting, validDefault } from './runtimeSetting';

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

const subscribe = subscribeToSetting(event);

export const useIntegrationProxy = () =>
  useSyncExternalStore(subscribe, getIntegrationProxy);

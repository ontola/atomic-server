// @wc-ignore-file
import { useSyncExternalStore } from 'react';
import { isLoopbackHost } from '../../../../integrations/localthought/browser';

const CATALOG_URL_KEY = 'plugin-catalog-url';

// Published from the `integrations/` folder of
// https://github.com/ontola/atomic-plugins (gh-pages), which mirrors
// this repo's own `integrations/` tree. Kept as a separate, publicly
// reachable catalog so a data-browser build isn't limited to the plugins its
// own paired atomic-server happens to embed.
const DEFAULT_PLUGIN_CATALOG_URL =
  'https://ontola.github.io/atomic-plugins/integrations/catalog.json';

export function validateCatalogUrl(value: string): string {
  const url = new URL(value);

  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && isLoopbackHost(url.hostname))
  ) {
    throw new Error('Catalog URL must be an HTTPS URL or a localhost HTTP URL');
  }

  return value;
}

// A build-time default that does not pass the same check as a hand-typed one
// would leave every read throwing, with no way to reach the settings screen
// that fixes it. Fall back to the compiled-in catalog instead.
function validDefault(): string {
  const configured = import.meta.env.VITE_PLUGIN_CATALOG_URL;

  if (!configured) return DEFAULT_PLUGIN_CATALOG_URL;

  try {
    return validateCatalogUrl(configured);
  } catch {
    return DEFAULT_PLUGIN_CATALOG_URL;
  }
}

export const defaultPluginCatalogUrl: string = validDefault();

export function getPluginCatalogUrl(): string {
  // Seeded before the first paint by anything that can write localStorage for
  // the origin — the settings screen, or playwright's `storageState`. That is
  // what lets one binary serve e2e lanes whose catalog sits on another port,
  // instead of a rebuild per lane.
  const stored = localStorage.getItem(CATALOG_URL_KEY);

  if (!stored) return defaultPluginCatalogUrl;

  try {
    return validateCatalogUrl(stored);
  } catch {
    return defaultPluginCatalogUrl;
  }
}

const event = 'plugin-catalog-url-change';

export function setPluginCatalogUrl(value: string) {
  const trimmed = value.trim();

  if (!trimmed) {
    localStorage.removeItem(CATALOG_URL_KEY);
  } else {
    localStorage.setItem(CATALOG_URL_KEY, validateCatalogUrl(trimmed));
  }

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

export const usePluginCatalogUrl = (): string =>
  useSyncExternalStore(subscribe, getPluginCatalogUrl);

// @wc-ignore-file
import { useSyncExternalStore } from 'react';
import {
  isHttpsOrLoopback,
  subscribeToSetting,
  validDefault,
} from './runtimeSetting';

const CATALOG_URL_KEY = 'plugin-catalog-url';

// Published from the `integrations/` folder of
// https://github.com/ontola/atomic-plugins (gh-pages). Kept as a separate,
// publicly reachable catalog so a data-browser build isn't tied to whichever
// atomic-server it happens to be paired with.
const DEFAULT_PLUGIN_CATALOG_URL =
  'https://ontola.github.io/atomic-plugins/integrations/catalog.json';

export function validateCatalogUrl(value: string): string {
  if (!isHttpsOrLoopback(new URL(value))) {
    throw new Error('Catalog URL must be an HTTPS URL or a localhost HTTP URL');
  }

  return value;
}

export const defaultPluginCatalogUrl: string = validDefault(
  import.meta.env.VITE_PLUGIN_CATALOG_URL,
  validateCatalogUrl,
  DEFAULT_PLUGIN_CATALOG_URL,
);

export function getPluginCatalogUrl(): string {
  // Seeded before the first paint by anything that can write localStorage for
  // the origin — the settings screen, or playwright's `storageState`. That is
  // what lets one binary serve e2e lanes whose catalog sits on another port,
  // instead of a rebuild per lane. Blocked storage or a stored value that no
  // longer validates falls back to the default rather than throwing.
  try {
    const stored = localStorage.getItem(CATALOG_URL_KEY);

    return stored ? validateCatalogUrl(stored) : defaultPluginCatalogUrl;
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

const subscribe = subscribeToSetting(event);

export const usePluginCatalogUrl = (): string =>
  useSyncExternalStore(subscribe, getPluginCatalogUrl);

// Extra marketplaces, on top of the primary catalog above. Earlier ones win a
// duplicate shortname, the primary first (see `mergeCatalogs`).
const MARKETPLACES_KEY = 'plugin-marketplaces';
const marketplacesEvent = 'plugin-marketplaces-change';

function readMarketplacesRaw(): string {
  try {
    return localStorage.getItem(MARKETPLACES_KEY) ?? '[]';
  } catch {
    return '[]';
  }
}

function parseMarketplaces(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);

    if (!Array.isArray(parsed)) return [];

    // A stored value that no longer validates is dropped, not thrown.
    return parsed.flatMap(value => {
      try {
        return typeof value === 'string' ? [validateCatalogUrl(value)] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

export function getExtraMarketplaces(): string[] {
  return parseMarketplaces(readMarketplacesRaw());
}

function writeMarketplaces(urls: string[]) {
  localStorage.setItem(MARKETPLACES_KEY, JSON.stringify(urls));
  window.dispatchEvent(new Event(marketplacesEvent));
}

/** Throws when the URL is invalid. Adding one already listed is a no-op. */
export function addMarketplace(value: string) {
  const url = validateCatalogUrl(value.trim());
  const current = getExtraMarketplaces();

  if (url === getPluginCatalogUrl() || current.includes(url)) return;

  writeMarketplaces([...current, url]);
}

export function removeMarketplace(url: string) {
  writeMarketplaces(getExtraMarketplaces().filter(u => u !== url));
}

const subscribeMarketplaces = subscribeToSetting(marketplacesEvent);

export function useExtraMarketplaces(): string[] {
  // The raw string is the snapshot: a fresh array each call would never settle.
  const raw = useSyncExternalStore(subscribeMarketplaces, readMarketplacesRaw);

  return parseMarketplaces(raw);
}

/** Primary catalog first, then the extra marketplaces. */
export function useMarketplaceUrls(): string[] {
  const primary = usePluginCatalogUrl();
  const extra = useExtraMarketplaces();

  return [primary, ...extra.filter(url => url !== primary)];
}

// @wc-ignore-file
import { useSyncExternalStore } from 'react';
import {
  isHttpsOrLoopback,
  subscribeToSetting,
  validDefault,
} from './runtimeSetting';

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

// The marketplaces, in order: earlier ones win a duplicate shortname (see
// `mergeCatalogs`). Seeded before the first paint by anything that can write
// localStorage for the origin (the settings screen, or playwright's
// `storageState`), so one binary serves e2e lanes whose catalog sits on another
// port. With no stored list it is just the default.
const MARKETPLACES_KEY = 'marketplaces';
// Earlier versions kept a primary catalog and a list of extras apart. Read as
// `[primary ?? default, ...extras]` until the first write, never written.
const LEGACY_KEY = 'plugin-catalog-url';
const LEGACY_EXTRAS_KEY = 'plugin-marketplaces';
const event = 'plugin-marketplaces-change';

/** The list as a JSON string, so it can be a stable store snapshot. */
function readRaw(): string {
  try {
    const stored = localStorage.getItem(MARKETPLACES_KEY);

    if (stored !== null) return stored;

    const legacy = localStorage.getItem(LEGACY_KEY);
    const extras = parse(localStorage.getItem(LEGACY_EXTRAS_KEY) ?? '[]');
    const primary = legacy
      ? validateCatalogUrl(legacy)
      : defaultPluginCatalogUrl;

    return JSON.stringify([primary, ...extras.filter(u => u !== primary)]);
  } catch {
    return JSON.stringify([defaultPluginCatalogUrl]);
  }
}

function parse(raw: string): string[] {
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

export function getMarketplaceUrls(): string[] {
  return parse(readRaw());
}

function write(urls: string[]) {
  localStorage.setItem(MARKETPLACES_KEY, JSON.stringify(urls));
  window.dispatchEvent(new Event(event));
}

/** Throws when the URL is invalid. Adding one already listed is a no-op. */
export function addMarketplace(value: string) {
  const url = validateCatalogUrl(value.trim());
  const current = getMarketplaceUrls();

  if (!current.includes(url)) write([...current, url]);
}

/** Any entry may go, the default included; an empty list stays empty. */
export function removeMarketplace(url: string) {
  write(getMarketplaceUrls().filter(u => u !== url));
}

/** Back to just the default marketplace. */
export function resetMarketplaces() {
  for (const key of [MARKETPLACES_KEY, LEGACY_KEY, LEGACY_EXTRAS_KEY]) {
    localStorage.removeItem(key);
  }

  window.dispatchEvent(new Event(event));
}

const subscribe = subscribeToSetting(event);

export function useMarketplaceUrls(): string[] {
  // The raw string is the snapshot: a fresh array each call would never settle.
  return parse(useSyncExternalStore(subscribe, readRaw));
}

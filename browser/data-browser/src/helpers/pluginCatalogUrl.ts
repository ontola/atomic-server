// @wc-ignore-file
import { useSyncExternalStore } from 'react';

const CATALOG_URL_KEY = 'plugin-catalog-url';

// Published from the `integrations/` folder of
// https://github.com/localthought/atomic-plugins (gh-pages), which mirrors
// this repo's own `integrations/` tree. Kept as a separate, publicly
// reachable catalog so a data-browser build isn't limited to the plugins its
// own paired atomic-server happens to embed.
const DEFAULT_PLUGIN_CATALOG_URL =
  'https://localthought.github.io/atomic-plugins/catalog.json';

export const defaultPluginCatalogUrl: string =
  import.meta.env.VITE_PLUGIN_CATALOG_URL || DEFAULT_PLUGIN_CATALOG_URL;

function validateCatalogUrl(value: string): string {
  const url = new URL(value);

  if (
    url.protocol !== 'https:' &&
    !(
      url.protocol === 'http:' &&
      ['localhost', '127.0.0.1'].includes(url.hostname)
    )
  ) {
    throw new Error(
      'Catalog URL must be an HTTPS URL or a localhost HTTP URL',
    );
  }

  return value;
}

export function getPluginCatalogUrl(): string {
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

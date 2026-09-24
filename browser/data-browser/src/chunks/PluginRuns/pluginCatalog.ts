import { useEffect, useState } from 'react';
import { parseCatalogApp, type CatalogApp } from '@tomic/react';
import { usePluginCatalogUrl } from '@helpers/pluginCatalogUrl';

const CATALOG_ENTRY_CLASS =
  'https://atomicdata.dev/integrations/classes/PluginCatalogEntry';
const IS_A_PROP = 'https://atomicdata.dev/properties/isA';
const SHORTNAME_PROP = 'https://atomicdata.dev/properties/shortname';
const EXPERIMENTAL_PROP =
  'https://atomicdata.dev/integrations/properties/experimental';
const ENABLED_PROP = 'https://atomicdata.dev/integrations/properties/enabled';
const REQUIRES_API_PLUGINS_PROP =
  'https://atomicdata.dev/integrations/properties/requires-api-plugins';

// A parsed integrations/catalog.json entry: the flags that decide what the
// Integrations page offers.
export interface CatalogEntry {
  shortname: string;
  experimental: boolean;
  enabled: boolean;
  requiresApiPlugins: boolean;
  /** Set when the entry is an installable drive app (`app-module`). */
  app?: CatalogApp;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Malformed entries are skipped, so one bad row can't hide the rest. */
export function parseCatalogEntries(
  raw: unknown,
  catalogUrl?: string,
): CatalogEntry[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((resource): CatalogEntry[] => {
    if (!isRecord(resource)) return [];
    const isA = resource[IS_A_PROP];
    const shortname = resource[SHORTNAME_PROP];

    if (!Array.isArray(isA) || !isA.includes(CATALOG_ENTRY_CLASS)) return [];
    if (typeof shortname !== 'string' || !shortname) return [];

    return [
      {
        shortname,
        experimental: resource[EXPERIMENTAL_PROP] !== false,
        enabled: resource[ENABLED_PROP] === true,
        requiresApiPlugins: resource[REQUIRES_API_PLUGINS_PROP] === true,
        // Resolved against the catalog it came from, so a catalog can name
        // its modules relative to itself.
        ...(catalogUrl ? { app: parseCatalogApp(resource, catalogUrl) } : {}),
      },
    ];
  });
}

// catalog.json is published from https://github.com/ontola/atomic-plugins
// (gh-pages, built from that repo's integrations/ tree) rather than
// bundled into the SPA at build time or fetched from the paired
// atomic-server — a Tauri desktop/mobile build ships a separate frontend
// that can pair with any server, so the catalog has to come from a fixed,
// publicly reachable location independent of both. The URL is
// user-configurable (see pluginCatalogUrl.ts / Settings > Integration) so a
// self-hosted or staging catalog can be used instead.
const cache = new Map<string, Promise<CatalogEntry[]>>();
// The settled value of each `cache` entry, so a remounted hook starts from it
// synchronously. With only the promise, the first render after a remount has
// no entries, so whatever the catalog drives (the "Show experimental plugins"
// toggle) drops out and comes back a tick later. Remounts are routine: the whole app remounts once per page load when
// its locale arrives (LocaleContext.tsx).
const resolved = new Map<string, CatalogEntry[]>();

function fetchIntegrationCatalog(catalogUrl: string): Promise<CatalogEntry[]> {
  let promise = cache.get(catalogUrl);

  if (!promise) {
    promise = fetch(catalogUrl)
      .then(response => {
        if (!response.ok) {
          throw new Error(
            `Failed to load integration catalog: ${response.status}`,
          );
        }

        return response.json();
      })
      .then(raw => parseCatalogEntries(raw, catalogUrl))
      .then(entries => {
        resolved.set(catalogUrl, entries);

        return entries;
      })
      .catch(reason => {
        cache.delete(catalogUrl);
        throw reason;
      });
    cache.set(catalogUrl, promise);
  }

  return promise;
}

export function useIntegrationCatalog(): {
  entries: CatalogEntry[];
  ready: boolean;
  error?: string;
  /** Where the entries came from. */
  catalogUrl: string;
} {
  const catalogUrl = usePluginCatalogUrl();
  const [entries, setEntries] = useState(() => resolved.get(catalogUrl));
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setError(undefined);
    fetchIntegrationCatalog(catalogUrl)
      .then(result => {
        if (active) setEntries(result);
      })
      .catch(reason => {
        if (active) setError(String(reason));
      });

    return () => {
      active = false;
    };
  }, [catalogUrl]);

  return {
    entries: entries ?? [],
    ready: entries !== undefined,
    error,
    catalogUrl,
  };
}

/**
 * Whether the catalog has an enabled experimental entry the app can offer.
 * Entries that need API plugins don't count: nothing can run them until the
 * host proxies their calls (#1624).
 */
export function hasExperimentalEntries(entries: CatalogEntry[]): boolean {
  return entries.some(
    entry => entry.enabled && entry.experimental && !entry.requiresApiPlugins,
  );
}

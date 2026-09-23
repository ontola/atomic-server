import { useEffect, useState } from 'react';
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
const PLATFORM_PROP = 'https://atomicdata.dev/integrations/properties/platform';

// A parsed integrations/catalog.json entry: the flags that decide whether a
// LocalThought proxy platform gets a card. `platform` names the proxy
// platform the entry describes; without it, the shortname is the platform.
export interface CatalogEntry {
  shortname: string;
  experimental: boolean;
  enabled: boolean;
  requiresApiPlugins: boolean;
  platform?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Malformed entries are skipped, so one bad row can't hide the rest. */
export function parseCatalogEntries(raw: unknown): CatalogEntry[] {
  if (!Array.isArray(raw)) return [];

  return raw.flatMap((resource): CatalogEntry[] => {
    if (!isRecord(resource)) return [];
    const isA = resource[IS_A_PROP];
    const shortname = resource[SHORTNAME_PROP];

    if (!Array.isArray(isA) || !isA.includes(CATALOG_ENTRY_CLASS)) return [];
    if (typeof shortname !== 'string' || !shortname) return [];

    const platform = resource[PLATFORM_PROP];

    return [
      {
        shortname,
        experimental: resource[EXPERIMENTAL_PROP] !== false,
        enabled: resource[ENABLED_PROP] === true,
        requiresApiPlugins: resource[REQUIRES_API_PLUGINS_PROP] === true,
        platform: typeof platform === 'string' ? platform : undefined,
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
      .then(parseCatalogEntries)
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
} {
  const catalogUrl = usePluginCatalogUrl();
  const [entries, setEntries] = useState<CatalogEntry[]>();
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

  return { entries: entries ?? [], ready: entries !== undefined, error };
}

/** Entries keyed by the proxy platform they describe (`platform ?? shortname`). */
export function catalogByPlatform(
  entries: CatalogEntry[],
): Map<string, CatalogEntry> {
  return new Map(
    entries.map(entry => [entry.platform ?? entry.shortname, entry]),
  );
}

export function isCatalogVisible(
  entry: CatalogEntry | undefined,
  showExperimentalPlugins: boolean,
): boolean {
  if (!entry || !entry.enabled) return false;

  return showExperimentalPlugins || !entry.experimental;
}

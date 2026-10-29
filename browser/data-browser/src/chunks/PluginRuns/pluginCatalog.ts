import { useEffect, useState } from 'react';
import { parseCatalogApp, type CatalogApp } from '@tomic/react';
import { useMarketplaceUrls } from '@helpers/pluginCatalogUrl';

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
  /** The marketplace (catalog.json URL) the entry came from. */
  catalogUrl?: string;
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
        ...(catalogUrl
          ? { app: parseCatalogApp(resource, catalogUrl), catalogUrl }
          : {}),
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
// toggle) drops out and comes back a tick later. The whole app still
// remounts when the person switches locale (LocaleContext.tsx).
const resolved = new Map<string, CatalogEntry[]>();

// An unreachable marketplace has to fail visibly instead of leaving the page
// on "Loading".
const FETCH_TIMEOUT_MS = 15_000;

function fetchIntegrationCatalog(catalogUrl: string): Promise<CatalogEntry[]> {
  let promise = cache.get(catalogUrl);

  if (!promise) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    promise = fetch(catalogUrl, { signal: controller.signal })
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
      })
      .finally(() => clearTimeout(timer));
    cache.set(catalogUrl, promise);
  }

  return promise;
}

/** What one marketplace gave: its entries, or why it could not be read. */
export type MarketplaceResult = { url: string } & (
  | { entries: CatalogEntry[] }
  | { error: string }
);

/**
 * Merges marketplaces in the order given: on a duplicate shortname the earlier
 * one wins. A failed marketplace is reported in `errors` and hides nothing.
 */
export function mergeCatalogs(results: MarketplaceResult[]): {
  entries: CatalogEntry[];
  errors: { url: string; error: string }[];
} {
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  const errors: { url: string; error: string }[] = [];

  for (const result of results) {
    if ('error' in result) {
      errors.push({ url: result.url, error: result.error });
      continue;
    }

    for (const entry of result.entries) {
      if (seen.has(entry.shortname)) continue;
      seen.add(entry.shortname);
      entries.push(entry);
    }
  }

  return { entries, errors };
}

export function useIntegrationCatalog(): {
  entries: CatalogEntry[];
  /** Every marketplace has answered, with entries or with an error. */
  ready: boolean;
  /** One per marketplace that could not be read, named by its host. */
  errors: string[];
  /** The marketplaces the entries came from, primary first. */
  catalogUrls: string[];
} {
  const catalogUrls = useMarketplaceUrls();
  const key = catalogUrls.join('\n');
  const [results, setResults] = useState<Record<string, MarketplaceResult>>(
    () =>
      Object.fromEntries(
        catalogUrls.flatMap(url => {
          const entries = resolved.get(url);

          return entries ? [[url, { url, entries }]] : [];
        }),
      ),
  );

  useEffect(() => {
    let active = true;

    for (const url of key.split('\n')) {
      fetchIntegrationCatalog(url)
        .then(entries => ({ url, entries }) as MarketplaceResult)
        .catch(reason => ({ url, error: String(reason) }) as MarketplaceResult)
        .then(result => {
          if (active) setResults(previous => ({ ...previous, [url]: result }));
        });
    }

    return () => {
      active = false;
    };
  }, [key]);

  const answered = catalogUrls.flatMap(url => results[url] ?? []);
  const merged = mergeCatalogs(answered);

  return {
    entries: merged.entries,
    ready: answered.length === catalogUrls.length,
    errors: merged.errors.map(({ url, error }) => `${hostOf(url)}: ${error}`),
    catalogUrls,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
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

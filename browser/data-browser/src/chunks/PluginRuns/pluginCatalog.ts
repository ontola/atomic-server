import { useEffect, useState } from 'react';
import { useStore } from '@tomic/react';

const CATALOG_ENTRY_CLASS =
  'https://atomicdata.dev/integrations/classes/PluginCatalogEntry';
const IS_A_PROP = 'https://atomicdata.dev/properties/isA';
const SHORTNAME_PROP = 'https://atomicdata.dev/properties/shortname';
const NAME_PROP = 'https://atomicdata.dev/properties/name';
const EMOJI_PROP = 'https://atomicdata.dev/properties/emoji';
const DESCRIPTION_PROP = 'https://atomicdata.dev/properties/description';
const EXPERIMENTAL_PROP =
  'https://atomicdata.dev/integrations/properties/experimental';
const ENABLED_PROP = 'https://atomicdata.dev/integrations/properties/enabled';
const CAPABILITIES_PROP =
  'https://atomicdata.dev/integrations/properties/capabilities';
const EVENTS_PROP = 'https://atomicdata.dev/integrations/properties/events';
const LIMITATION_PROP =
  'https://atomicdata.dev/integrations/properties/limitation';
const KEYWORDS_PROP = 'https://atomicdata.dev/integrations/properties/keywords';
const REQUIRES_API_PLUGINS_PROP =
  'https://atomicdata.dev/integrations/properties/requires-api-plugins';
const PLATFORM_PROP = 'https://atomicdata.dev/integrations/properties/platform';
const CALLBACK_PLATFORM_PROP =
  'https://atomicdata.dev/integrations/properties/callback-platform';

type CatalogResource = Record<string, unknown>;

// A parsed integrations/catalog.json entry. Every entry has an id, an
// experimental flag and an enabled flag; the rest are only present on the
// bundled integrations that own card copy (see IntegrationDiscovery.tsx) —
// a raw LocalThought proxy platform like 'pets' only carries the first three.
export interface CatalogEntry {
  shortname: string;
  experimental: boolean;
  enabled: boolean;
  name?: string;
  icon?: string;
  description?: string;
  capabilities?: string;
  events?: string;
  limitation?: string;
  keywords?: string;
  requiresApiPlugins?: boolean;
  platform?: string;
  callbackPlatform?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseCatalogEntries(raw: unknown): CatalogEntry[] {
  if (!Array.isArray(raw)) return [];

  return (raw as CatalogResource[])
    .filter(resource =>
      (resource[IS_A_PROP] as string[] | undefined)?.includes(
        CATALOG_ENTRY_CLASS,
      ),
    )
    .map(resource => ({
      shortname: resource[SHORTNAME_PROP] as string,
      experimental: resource[EXPERIMENTAL_PROP] !== false,
      enabled: resource[ENABLED_PROP] === true,
      name: asString(resource[NAME_PROP]),
      icon: asString(resource[EMOJI_PROP]),
      description: asString(resource[DESCRIPTION_PROP]),
      capabilities: asString(resource[CAPABILITIES_PROP]),
      events: asString(resource[EVENTS_PROP]),
      limitation: asString(resource[LIMITATION_PROP]),
      keywords: asString(resource[KEYWORDS_PROP]),
      requiresApiPlugins: resource[REQUIRES_API_PLUGINS_PROP] === true,
      platform: asString(resource[PLATFORM_PROP]),
      callbackPlatform: asString(resource[CALLBACK_PLATFORM_PROP]),
    }));
}

// integrations/catalog.json is compiled into the server as a static asset
// (see server/build.rs::embed_integrations) and served at
// /integrations/catalog.json, rather than bundled into the SPA at build
// time — a Tauri desktop/mobile build ships a separate frontend that can
// point at any paired server, so the catalog has to come from wherever
// `store.getServerUrl()` says the data actually lives, not from the origin
// the frontend itself was loaded from.
const cache = new Map<string, Promise<CatalogEntry[]>>();

function fetchIntegrationCatalog(server: string): Promise<CatalogEntry[]> {
  let promise = cache.get(server);

  if (!promise) {
    promise = fetch(`${server}/integrations/catalog.json`)
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
        cache.delete(server);
        throw reason;
      });
    cache.set(server, promise);
  }

  return promise;
}

export function useIntegrationCatalog(): {
  entries: CatalogEntry[];
  ready: boolean;
  error?: string;
} {
  const store = useStore();
  const server = store.getServerUrl();
  const [entries, setEntries] = useState<CatalogEntry[]>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let active = true;
    setError(undefined);
    fetchIntegrationCatalog(server)
      .then(result => {
        if (active) setEntries(result);
      })
      .catch(reason => {
        if (active) setError(String(reason));
      });

    return () => {
      active = false;
    };
  }, [server]);

  return { entries: entries ?? [], ready: entries !== undefined, error };
}

export function catalogByShortname(
  entries: CatalogEntry[],
): Map<string, CatalogEntry> {
  return new Map(entries.map(entry => [entry.shortname, entry]));
}

export function isCatalogVisible(
  entry: CatalogEntry | undefined,
  showExperimentalPlugins: boolean,
): boolean {
  if (!entry || !entry.enabled) return false;

  return showExperimentalPlugins || !entry.experimental;
}

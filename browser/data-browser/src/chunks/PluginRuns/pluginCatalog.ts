import pluginCatalog from '../../../../../integrations/catalog.json';

const CATALOG_ENTRY_CLASS =
  'https://atomicdata.dev/integrations/classes/PluginCatalogEntry';
const CATALOG_EXPERIMENTAL_PROP =
  'https://atomicdata.dev/integrations/properties/experimental';
const IS_A_PROP = 'https://atomicdata.dev/properties/isA';
const SHORTNAME_PROP = 'https://atomicdata.dev/properties/shortname';

type CatalogResource = Record<string, unknown>;

// integrations/catalog.json gates which integrations are visible by default —
// both the bundled ones and the raw platforms LocalThought advertises; an id
// missing from it, like one explicitly marked experimental, is only shown
// once the visitor enables 'Show experimental plugins'.
const experimentalById = new Map<string, boolean>(
  (pluginCatalog as CatalogResource[])
    .filter(resource =>
      (resource[IS_A_PROP] as string[] | undefined)?.includes(
        CATALOG_ENTRY_CLASS,
      ),
    )
    .map(resource => [
      resource[SHORTNAME_PROP] as string,
      resource[CATALOG_EXPERIMENTAL_PROP] !== false,
    ]),
);

export function isExperimental(id: string): boolean {
  return experimentalById.get(id) ?? true;
}

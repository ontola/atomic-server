import pluginCatalog from '../../../../../integrations/catalog.json';

const CATALOG_ENTRY_CLASS =
  'https://atomicdata.dev/integrations/classes/PluginCatalogEntry';
const CATALOG_EXPERIMENTAL_PROP =
  'https://atomicdata.dev/integrations/properties/experimental';
const IS_A_PROP = 'https://atomicdata.dev/properties/isA';
const SHORTNAME_PROP = 'https://atomicdata.dev/properties/shortname';

type CatalogResource = Record<string, unknown>;

// integrations/catalog.json gates which integrations are reachable at all —
// both the bundled ones and the raw platforms LocalThought advertises. An id
// missing from it is dark matter: compiled into the server as a static
// asset, but never offered, even with 'Show experimental plugins' on. A
// cataloged id is shown once the visitor enables that toggle, unless its
// entry sets `experimental: false`, in which case it's shown by default.
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

export function isCatalogVisible(
  id: string,
  showExperimentalPlugins: boolean,
): boolean {
  const experimental = experimentalById.get(id);
  if (experimental === undefined) return false;

  return showExperimentalPlugins || !experimental;
}

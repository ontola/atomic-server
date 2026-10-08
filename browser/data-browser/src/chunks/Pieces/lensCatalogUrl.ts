// @wc-ignore-file
import { isHttpsOrLoopback, validDefault } from '@helpers/runtimeSetting';

const LENS_CATALOG_URL_KEY = 'lens-catalog-url';

/**
 * The shared lens catalog release this host pins (ontola/atomic-plugins
 * `ontology-kit/LENSES.md`). A release lists every lens a host gets, and
 * published files never change, so a newer catalog reaches this host only
 * when this pin moves.
 *
 * Release 1 uses lens mapping version 2, which the vendored interpreter runs.
 * Release 2 (mapping version 3) is not pinned: it is unpublished, and the
 * vendored `lens.mjs` does not run version 3.
 *
 * The base is the ontology's temporary github.io one (pieces.md O11), which is
 * why the catalog loads only behind the split-pieces flag.
 */
export const PINNED_LENS_CATALOG_URL =
  'https://ontola.github.io/atomic-plugins/ontology/lenses/v1';

export function validateLensCatalogUrl(value: string): string {
  if (!isHttpsOrLoopback(new URL(value))) {
    throw new Error(
      'Lens catalog URL must be an HTTPS URL or a localhost HTTP URL',
    );
  }

  return value;
}

/** The build's pin: `VITE_LENS_CATALOG_URL`, else the release above. */
export const defaultLensCatalogUrl: string = validDefault(
  import.meta.env.VITE_LENS_CATALOG_URL,
  validateLensCatalogUrl,
  PINNED_LENS_CATALOG_URL,
);

/**
 * The release URL to load. Like the plugin catalog URL, it can be seeded in
 * localStorage before the first paint (playwright's `storageState`), so an e2e
 * lane can point one binary at the catalog its dev-server serves. A stored
 * value that no longer validates, or blocked storage, falls back to the pin.
 */
export function getLensCatalogUrl(): string {
  try {
    const stored = localStorage.getItem(LENS_CATALOG_URL_KEY);

    return stored ? validateLensCatalogUrl(stored) : defaultLensCatalogUrl;
  } catch {
    return defaultLensCatalogUrl;
  }
}

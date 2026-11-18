// @wc-ignore-file
/**
 * Declarative lenses between row classes: the host's one interpreter
 * (pieces.md L4).
 *
 * `vendor/lens.mjs` is ontola/atomic-plugins `ontology-kit/lens.mjs`, copied
 * byte for byte from main at 67baf939a97bbc0381397c3d64cf1dfe1aa4b167. The
 * same file runs the offer search's lenses here, the shared catalog's checks
 * in atomic-plugins, and (as script text, `LENS_INTERPRETER_SOURCE`) an
 * integration frame's `lensPath`. It reads mapping versions 1 (this
 * prototype's original format), 2 (catalog release 1: JSON Pointers, more
 * converters, read-only fields) and 3 (catalog release 2: `guards`, which
 * refuse a record outside the lens's domain with `out-of-domain`, and
 * per-field `absent`, which lets a put remove a field). To update it, copy
 * the file again and change the commit above; `lens.d.mts` has one local
 * edit, named in it.
 *
 * Differences from the prototype's own v1 interpreter it replaces
 * (atomic-plugins LENSES.md lists them): `put` writes only fields whose value
 * changed; converters refuse values outside their domain instead of passing
 * them through; values are copied and must be JSON-like; unknown keys in a
 * mapping are refused; errors are `LensError`s with a stable `code`.
 *
 * Laws, checked on every catalog lens's examples: `get(put(view, row))`
 * equals `view` on every mapped field, and `put(get(row), row)` equals `row`.
 * Properties a lens does not map keep their value on `put`.
 */
import interpreterSource from './vendor/lens.mjs?raw';
import type { LensDirection } from './vendor/lens.mjs';

export {
  CONVERTERS,
  LENS_MAPPING_VERSIONS,
  LensError,
  catalogLensInfo,
  getAlongPath,
  lensGet,
  lensPut,
  parseMapping,
  storedMapping,
} from './vendor/lens.mjs';
export type {
  CatalogLensFile,
  ConverterName,
  LensDirection,
  LensField,
  LensMapping,
} from './vendor/lens.mjs';

export interface LensStep {
  lens: string;
  direction: LensDirection;
}

/**
 * The interpreter as plain script text, for a frame whose source is one
 * script and cannot import modules: the same file with its `export` keywords
 * removed, so it declares `lensGet`, `getAlongPath` and the rest at the top
 * level.
 */
export const LENS_INTERPRETER_SOURCE: string = interpreterSource.replace(
  /^export /gm,
  '',
);

// @wc-ignore-file
import type { LensMapping } from './lens';

export interface CatalogLens {
  subject: string;
  name: string;
  source: string;
  target: string;
  mapping: LensMapping;
}

/**
 * The shared lens catalog (Q-089): lenses published next to the ontology in
 * ontola/atomic-plugins, reviewed there, and trusted on every drive.
 *
 * Stubbed as an empty list in this prototype. The real one would be fetched
 * from the published ontology release (like `ontology/v1`), pinned by version,
 * and would hold lenses between shared classes, e.g. the host's Time tracker
 * template row ↔ `time-entry-v1` and `time-entry-v1` ↔ the syncables Clockify
 * shape. The demo's classes are minted per drive, so its lenses are
 * drive-local and go through review instead.
 */
export async function loadLensCatalog(): Promise<CatalogLens[]> {
  return [];
}

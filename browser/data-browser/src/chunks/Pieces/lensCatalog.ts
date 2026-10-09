// @wc-ignore-file
import { isHttpsOrLoopback } from '@helpers/runtimeSetting';
import {
  catalogLensInfo,
  LENS_MAPPING_VERSIONS,
  parseMapping,
  storedMapping,
  type CatalogLensFile,
  type LensMapping,
} from './lens';
import { getLensCatalogUrl } from './lensCatalogUrl';
import { piecesEnabled } from './piecesFlag';

/**
 * A lens from the shared catalog, in the shape `catalogLensInfo()` gives:
 * the endpoints as the strings the offer search matches (a class subject, or
 * a provisional `record:`/`rdf:` key), and the mapping as stored.
 */
export interface CatalogLens {
  subject: string;
  name: string;
  source: string;
  target: string;
  mapping: LensMapping;
  mappingVersion: number;
}

/** The `lensFormat`s this host reads, for releases and lens files alike. */
export const LENS_FORMATS: readonly number[] = [1];

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const fetchJson = async (fetchImpl: Fetch, url: string): Promise<unknown> => {
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);

  // Pages serves these files as application/octet-stream.
  return JSON.parse(await response.text());
};

/** Why a lens was skipped, for the one warning that names them all. */
interface Skipped {
  subject: string;
  reason: string;
  /** A network or HTTP failure, which may pass, unlike a refusal. */
  transient: boolean;
}

export interface FetchedLensCatalog {
  lenses: CatalogLens[];
  skipped: Skipped[];
}

/**
 * Fetches a catalog release and every lens it lists (atomic-plugins
 * `ontology-kit/LENSES.md`). Throws when the release itself cannot be read or
 * has an unknown `lensFormat`. A lens that cannot be fetched, has an unknown
 * `lensFormat`, is not served at its own subject, or whose mapping this host
 * cannot run (an unknown `mappingVersion`, or one `parseMapping` refuses) is
 * skipped and reported, so it never fails the other lenses.
 */
export async function fetchLensCatalog(
  releaseUrl: string,
  fetchImpl: Fetch,
  /**
   * The mapping versions this host runs: the vendored interpreter's. A lens
   * at any other version is skipped and named, never run.
   */
  mappingVersions: readonly number[] = LENS_MAPPING_VERSIONS,
): Promise<FetchedLensCatalog> {
  const release = await fetchJson(fetchImpl, releaseUrl);

  if (
    !isObject(release) ||
    !LENS_FORMATS.includes(release.lensFormat as number)
  )
    throw new Error(
      `${releaseUrl}: unknown lensFormat ${JSON.stringify(isObject(release) ? release.lensFormat : undefined)}`,
    );

  if (
    !Array.isArray(release.lenses) ||
    !release.lenses.every(l => typeof l === 'string')
  )
    throw new Error(`${releaseUrl}: "lenses" is not a list of subjects`);

  const results = await Promise.all(
    (release.lenses as string[]).map(
      async (subject): Promise<CatalogLens | Skipped> => {
        let file: unknown;

        try {
          if (!isHttpsOrLoopback(new URL(subject)))
            return { subject, reason: 'not an HTTPS URL', transient: false };
          file = await fetchJson(fetchImpl, subject);
        } catch (e) {
          return { subject, reason: String(e), transient: true };
        }

        return toCatalogLens(subject, file, mappingVersions);
      },
    ),
  );

  const lenses: CatalogLens[] = [];
  const skipped: Skipped[] = [];

  for (const result of results) {
    if ('reason' in result) skipped.push(result);
    else lenses.push(result);
  }

  return { lenses, skipped };
}

function toCatalogLens(
  subject: string,
  file: unknown,
  mappingVersions: readonly number[],
): CatalogLens | Skipped {
  const skip = (reason: string): Skipped => ({
    subject,
    reason,
    transient: false,
  });

  if (!isObject(file) || !LENS_FORMATS.includes(file.lensFormat as number))
    return skip(
      `unknown lensFormat ${JSON.stringify(isObject(file) ? file.lensFormat : undefined)}`,
    );

  // A catalog lens is trusted by its subject in the pinned release, so the
  // file must be the one published at that subject.
  if (file['@id'] !== subject) return skip(`its @id is ${String(file['@id'])}`);

  try {
    const info = catalogLensInfo(file as unknown as CatalogLensFile);

    if (!(mappingVersions as readonly unknown[]).includes(info.mappingVersion))
      return skip(`mapping version ${String(info.mappingVersion)}`);

    return {
      subject: info.subject,
      name: info.name,
      source: info.source,
      target: info.target,
      // Plain data, so it can be handed to a frame in `lensPath`.
      mapping: storedMapping(parseMapping(info.mapping)),
      mappingVersion: info.mappingVersion,
    };
  } catch (e) {
    return skip(String(e));
  }
}

const cache = new Map<string, Promise<CatalogLens[]>>();

/**
 * The shared lens catalog (Q-089): lenses published next to the ontology in
 * ontola/atomic-plugins, reviewed there, and trusted on every drive. Loaded
 * from the release this host pins (`lensCatalogUrl.ts`).
 *
 * - Off, and nothing fetched, unless the split-pieces flag is on: catalog
 *   lenses carry the ontology's temporary github.io base (pieces.md O11).
 * - Cached per release URL: published files never change, so an entry never
 *   goes stale. A load that failed, wholly or for one lens, is not cached,
 *   so the next call tries again.
 * - Fail-soft: a failed load gives `[]` and a warning, so offers through
 *   drive-local lenses keep working.
 */
export function loadLensCatalog(
  releaseUrl: string = getLensCatalogUrl(),
  fetchImpl: Fetch = (url, init) => fetch(url, init),
): Promise<CatalogLens[]> {
  if (!piecesEnabled()) return Promise.resolve([]);

  const cached = cache.get(releaseUrl);
  if (cached) return cached;

  const loading = fetchLensCatalog(releaseUrl, fetchImpl).then(
    ({ lenses, skipped }) => {
      if (skipped.length > 0) {
        console.warn(
          `Lens catalog ${releaseUrl}: skipped ${skipped
            .map(s => `${s.subject} (${s.reason})`)
            .join('; ')}`,
        );
      }

      if (skipped.some(s => s.transient)) cache.delete(releaseUrl);

      return lenses;
    },
    (e: unknown) => {
      cache.delete(releaseUrl);
      console.warn(`Lens catalog ${releaseUrl} not loaded:`, e);

      return [];
    },
  );
  cache.set(releaseUrl, loading);

  return loading;
}

/** Forgets every cached release. For tests. */
export function clearLensCatalogCache(): void {
  cache.clear();
}

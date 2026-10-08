// Vendored from ontola/atomic-plugins `ontology-kit/lens.d.mts` at main
// 72be98006446d7b855ad62e8e756ecda01bb656b. The only edit: `ResolverLens` is
// declared here instead of imported from `resolver.mjs`, which is not vendored.
/** `resolver.mjs`'s lens hook, as `resolverLens()` returns it. */
interface ResolverLens {
  readonly from: string;
  readonly to: string;
  read(row: Row): Record<string, unknown>;
  write?(patch: Row, row: Row): Record<string, unknown>;
}

export type LensDirection = 'forward' | 'backward';

export type ConverterName =
  | 'identity'
  | 'ms-to-iso'
  | 'iso-to-ms'
  | 'iso-seconds-to-ms'
  | 'map'
  | 'day-of';

/** One field of a mapping, as stored. LENSES.md, "Mappings". */
export interface LensField {
  /** An absolute URL (a top-level key) or, in version 2, a JSON Pointer. */
  readonly source: string;
  readonly target: string;
  readonly convert?: ConverterName;
  readonly args?: { readonly pairs: readonly (readonly [unknown, unknown])[] };
  /** Version 2: the lens never writes this field's source. */
  readonly readOnly?: boolean;
}

/** Version 1 is ontola/atomic-server#2069's `LensMapping`; 2 extends it. */
export interface LensMapping {
  readonly version: 1 | 2;
  readonly fields: readonly LensField[];
}

export type Row = Readonly<Record<string, unknown>>;

export type LensErrorCode =
  | 'bad-mapping'
  | 'bad-reference'
  | 'bad-path'
  | 'bad-value'
  | 'bad-args'
  | 'bad-endpoint'
  | 'overlap'
  | 'precision'
  | 'read-only'
  | 'unmapped-value';

export declare class LensError extends Error {
  readonly code: LensErrorCode;
}

export type Endpoint =
  | { readonly class: string }
  | {
      readonly record: {
        readonly provider: string;
        readonly resource: string;
        readonly openapi?: string;
      };
    }
  | { readonly rdf: string };

/** A published catalog lens file, `ontology/lenses/<name>-v<N>`. */
export interface CatalogLensFile {
  readonly '@id': string;
  readonly lensFormat: 1;
  readonly release: string;
  readonly name: string;
  readonly description: string;
  readonly source: Endpoint;
  readonly target: Endpoint;
  readonly mapping: LensMapping;
  readonly limits?: readonly string[];
  readonly implementation?: string;
  readonly examples: readonly {
    readonly source: unknown;
    readonly target: unknown;
    readonly edits?: readonly {
      readonly target: unknown;
      readonly source?: unknown;
      readonly error?: LensErrorCode;
    }[];
  }[];
}

/** #2069's `CatalogLens`, plus the mapping version. */
export interface CatalogLensInfo {
  readonly subject: string;
  readonly name: string;
  readonly source: string;
  readonly target: string;
  readonly mapping: LensMapping;
  readonly mappingVersion: 1 | 2;
}

export declare const LENS_MAPPING_VERSIONS: readonly [1, 2];
export declare const CONVERTERS: Readonly<
  Record<
    ConverterName,
    {
      get(value: unknown, args?: unknown): unknown;
      put?(value: unknown, args?: unknown): unknown;
    }
  >
>;
export declare function deepEqual(a: unknown, b: unknown): boolean;
export declare function referenceKind(
  ref: string,
): 'key' | 'pointer' | undefined;
export declare function pointerTokens(pointer: string): string[];
export declare function parseMapping(input: unknown): LensMapping;
export declare function storedMapping(mapping: LensMapping): LensMapping;
export declare function lensGet(
  mapping: LensMapping,
  row: unknown,
  direction?: LensDirection,
): Record<string, unknown>;
export declare function lensPut(
  mapping: LensMapping,
  view: unknown,
  previous: unknown,
  direction?: LensDirection,
): Record<string, unknown>;
export declare function getAlongPath(
  steps: readonly { mapping: LensMapping; direction: LensDirection }[],
  row: unknown,
): Record<string, unknown>;
export declare function lawProblems(
  mapping: LensMapping,
  row: unknown,
  desired?: unknown,
  direction?: LensDirection,
): string[];
export declare const MAX_DEPTH: number;
export declare function endpointKey(endpoint: Endpoint): string;
export declare function catalogLensInfo(lens: CatalogLensFile): CatalogLensInfo;
export declare function resolverLens(lens: CatalogLensFile): ResolverLens;

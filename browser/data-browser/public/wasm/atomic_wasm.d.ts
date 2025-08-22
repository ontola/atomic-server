/* tslint:disable */
/* eslint-disable */
/**
 * Initialize panic hook for better error messages in the browser console.
 */
export function init(): void;
/**
 * A client-side Atomic Data database backed by redb (in-memory, future OPFS).
 * Provides indexed queries, resource storage, and commit application.
 */
export class ClientDb {
  free(): void;
  /**
   * Get all subjects in the database.
   */
  allSubjects(): any;
  /**
   * Apply a Commit (JSON-AD) to the local database.
   * This is the efficient incremental update path: the Loro diff
   * determines exactly which atoms changed, so only affected index
   * entries are updated. Use this for real-time updates (COMMIT messages).
   */
  applyCommit(commit_json_ad: string): Promise<void>;
  /**
   * Get a resource by its subject URL. Returns JSON-AD string or null.
   */
  getResource(subject: string): Promise<any>;
  /**
   * Store a resource from a JSON-AD string during initial bulk sync.
   * Rebuilds the full index for this resource (all atoms).
   * For incremental updates, use `applyCommit` instead — it only
   * touches changed properties via the Loro diff.
   */
  putResource(json_ad: string): Promise<void>;
  /**
   * Remove a resource by its subject URL.
   */
  removeResource(subject: string): Promise<void>;
  /**
   * Retrieve a Loro CRDT snapshot for a resource subject. Returns null if not found.
   */
  getLoroSnapshot(subject: string): any;
  /**
   * Store a Loro CRDT snapshot (raw bytes) for a resource subject.
   */
  putLoroSnapshot(subject: string, data: Uint8Array): void;
  /**
   * Export all resources as a JSON array of JSON-AD objects.
   * Used to snapshot the DB to IndexedDB for persistence across page reloads.
   */
  exportAllResources(): string;
  /**
   * Import resources from a JSON array of JSON-AD objects.
   * Used to restore a snapshot from IndexedDB on init.
   * Skips indexing during import and builds the index once at the end.
   */
  importAllResources(json_array: string): Promise<number>;
  /**
   * Get version vectors for all Loro snapshots in the database.
   * Returns a JSON object: `{ [subject]: { [peer_id]: counter } }`
   */
  getAllVersionVectors(): any;
  /**
   * Create a new ClientDb with OPFS persistence.
   * Data survives page reloads. Falls back to in-memory if OPFS is unavailable.
   * `base_url` is the server URL, e.g. "https://myserver.com".
   */
  constructor(base_url?: string | null);
  /**
   * Query the local database.
   * `property` and `value` are optional filters.
   * Returns a JSON object: `{ subjects: string[], resources: string[], count: number }`.
   */
  query(property?: string | null, value?: string | null, sort_by?: string | null, sort_desc?: boolean | null, limit?: number | null, offset?: number | null, include_resources?: boolean | null, drive?: string | null): Promise<any>;
  /**
   * Populate the database with default Atomic Data vocabulary
   * (classes, properties, datatypes).
   */
  populate(): Promise<void>;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_clientdb_free: (a: number, b: number) => void;
  readonly clientdb_allSubjects: (a: number) => [number, number, number];
  readonly clientdb_applyCommit: (a: number, b: number, c: number) => any;
  readonly clientdb_exportAllResources: (a: number) => [number, number, number, number];
  readonly clientdb_getAllVersionVectors: (a: number) => [number, number, number];
  readonly clientdb_getLoroSnapshot: (a: number, b: number, c: number) => [number, number, number];
  readonly clientdb_getResource: (a: number, b: number, c: number) => any;
  readonly clientdb_importAllResources: (a: number, b: number, c: number) => any;
  readonly clientdb_new: (a: number, b: number) => any;
  readonly clientdb_populate: (a: number) => any;
  readonly clientdb_putLoroSnapshot: (a: number, b: number, c: number, d: number, e: number) => [number, number];
  readonly clientdb_putResource: (a: number, b: number, c: number) => any;
  readonly clientdb_query: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number, i: number, j: number, k: number, l: number, m: number) => any;
  readonly clientdb_removeResource: (a: number, b: number, c: number) => any;
  readonly init: () => void;
  readonly __wbindgen_malloc: (a: number, b: number) => number;
  readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store: (a: number) => void;
  readonly __externref_table_alloc: () => number;
  readonly __wbindgen_export_4: WebAssembly.Table;
  readonly __wbindgen_free: (a: number, b: number, c: number) => void;
  readonly __wbindgen_export_6: WebAssembly.Table;
  readonly __externref_table_dealloc: (a: number) => void;
  readonly _dyn_core__ops__function__FnMut_____Output___R_as_wasm_bindgen__closure__WasmClosure___describe__invoke__h4e4489ce70a531f2: (a: number, b: number) => void;
  readonly closure2200_externref_shim: (a: number, b: number, c: any) => void;
  readonly closure2263_externref_shim: (a: number, b: number, c: any, d: any) => void;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;

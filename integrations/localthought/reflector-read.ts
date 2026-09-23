// @wc-ignore-file
/**
 * Reflector's read path, ported to the browser: turns a LocalThought catalog
 * document into a setup description and a one-way import.
 *
 * This replaces the removed WASM `describeIntegration`/`fetchIntegration`
 * bridge (atomic-server#1618) the way `planning/api-plugins.md` ("Reflector
 * supersedes the browser/WASM path") describes: an OpenAPI document plus its
 * overlays drives resource discovery, pagination and records, and the only
 * credential-bearing piece is an injected transport. In reflector that is
 * `AuthorizedFetcher.authorizedFetch()`; here it is
 * `BrowserIntegrations.request()`, LocalThought's rotating-code proxy call,
 * so the connection code still never leaves `browser.ts`.
 *
 * It is a port, not an import, because atomic-server's data-browser only has
 * `integrations/` (it cannot reach `reflector/` or `syncables/`), and the
 * published `syncables` entry point imports `node:http`/`node:fs`. Sources:
 * - resource model: `reflector/src/sync/resources.ts` (`discoverResourceModel`),
 *   plus the root-parameter rule of the removed Rust `resource_model.rs`;
 * - ontology: the removed Rust `sync/ontology.rs` (`derive_ontology`), whose
 *   `FetchedPlatform` shape `schema.ts` and the data-browser consume;
 * - pagination: `syncables/src/pagination/*` (the pagination-schemes subset:
 *   `pageNumber`, `pageToken`, `nextLink`, explicit `x-pagination` or
 *   auto-detection).
 * Standalone `x-crud` reads and cross-collection links from the Rust engine
 * are not ported; a collection only gets its context from constants or from
 * a parent collection's identity binding.
 *
 * GET only: nothing here writes to a provider.
 */
import type { BrowserIntegrations } from './browser.js';
import type { FetchedPlatform, FetchedRecord, Term } from './schema.js';

// ---------------------------------------------------------------------------
// Document shapes (only the fields this module reads)

interface Schema {
  $ref?: string;
  type?: string;
  format?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
}
interface Parameter {
  $ref?: string;
  name?: string;
  in?: string;
}
interface Operation {
  parameters?: Parameter[];
  responses?: Record<
    string,
    { content?: Record<string, { schema?: Schema }> } | undefined
  >;
  'x-pagination'?: { scheme: string; overrides?: Partial<Scheme> }[];
  [key: string]: unknown;
}
interface Field {
  role?: string;
}
interface Scheme {
  type: 'pageNumber' | 'pageToken' | 'nextLink';
  request?: { queryParameters?: Record<string, Field> };
  response?: {
    bodyFields?: Record<string, Field>;
    headers?: Record<string, Field>;
  };
  autoDetect?: boolean | { requireAll?: boolean; matchQueryParams?: boolean };
}

export interface CatalogDocument {
  info?: { title?: string };
  servers?: { url: string }[];
  paths?: Record<string, Record<string, Operation | Parameter[]> | undefined>;
  components?: {
    schemas?: Record<string, Schema>;
    parameters?: Record<string, Parameter>;
    paginationSchemes?: Record<string, Scheme>;
    crudResources?: Record<string, unknown>;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function deref<T extends { $ref?: string }>(
  doc: CatalogDocument,
  value: T | undefined,
  kind: 'schemas' | 'parameters' = 'schemas',
): T | undefined {
  const seen = new Set<string>();
  let node = value;

  while (node?.$ref) {
    const prefix = `#/components/${kind}/`;
    if (!node.$ref.startsWith(prefix) || seen.has(node.$ref)) return undefined;
    seen.add(node.$ref);
    node = doc.components?.[kind]?.[node.$ref.slice(prefix.length)] as
      | T
      | undefined;
  }

  return node;
}

// ---------------------------------------------------------------------------
// Resource model (after reflector/src/sync/resources.ts)

export interface Collection {
  name: string;
  resource: string;
  url: string;
  idField: string;
  contextParams: string[];
  listQuery: Record<string, string>;
}
interface Provider {
  collection: string;
  field: string;
}
interface Model {
  collections: Collection[];
  providers: Map<string, Provider>;
}

const pathVariables = (template: string) =>
  [...template.matchAll(/\{([^}]+)\}/g)].map(m => m[1]!);
const text = (value: unknown) =>
  typeof value === 'string'
    ? value
    : value === null || value === undefined
      ? ''
      : JSON.stringify(value);

function crudResources(doc: CatalogDocument) {
  const raw = doc.components?.crudResources;
  if (!isRecord(raw))
    throw new Error(
      'Catalog document declares no crudResources; apply the CRUD-causality overlay',
    );

  return raw;
}

function discoverModel(doc: CatalogDocument): Model {
  const collections: Collection[] = [];
  const firstCollection = new Map<string, string>();
  const bindings: { param: string; resource: string; field: string }[] = [];

  for (const [resource, def] of Object.entries(crudResources(doc))) {
    if (!isRecord(def)) continue;
    const identity = isRecord(def.identity) ? def.identity : {};
    const itemUrl =
      typeof identity.urlTemplate === 'string' ? identity.urlTemplate : '';
    const cols = isRecord(def.collections) ? def.collections : {};
    const collectionUrlHas = (param: string) =>
      Object.values(cols).some(
        c =>
          isRecord(c) &&
          typeof c.urlTemplate === 'string' &&
          c.urlTemplate.includes(`{${param}}`),
      );
    let idField = 'id';

    for (const [param, binding] of Object.entries(
      isRecord(identity.bindings) ? identity.bindings : {},
    )) {
      const field =
        isRecord(binding) && typeof binding.field === 'string'
          ? binding.field
          : 'id';
      bindings.push({ param, resource, field });
      // The variable bound in the item URL, not one that repeats a
      // parent-scoping context variable, is this resource's own id.
      if (itemUrl.includes(`{${param}}`) && !collectionUrlHas(param))
        idField = field;
    }

    for (const [name, col] of Object.entries(cols)) {
      if (!isRecord(col) || typeof col.urlTemplate !== 'string') continue;
      if (!firstCollection.has(resource)) firstCollection.set(resource, name);
      const listQuery: Record<string, string> = {};
      if (isRecord(col['x-list-query']))
        for (const [k, v] of Object.entries(col['x-list-query']))
          listQuery[k] = text(v);
      collections.push({
        name,
        resource,
        url: col.urlTemplate,
        idField,
        contextParams: pathVariables(col.urlTemplate),
        listQuery,
      });
    }
  }

  const providers = new Map<string, Provider>();

  for (const { param, resource, field } of bindings) {
    const collection = firstCollection.get(resource);
    // Only an enumerable resource (one with a collection) can supply a value.
    if (collection && !providers.has(param))
      providers.set(param, { collection, field });
  }

  return { collections, providers };
}

/** Parameters a user must supply: neither provided by a parent collection nor per item. */
function rootParameters(model: Model): string[] {
  const parameters = new Set<string>();

  for (const collection of model.collections)
    for (const param of collection.contextParams) {
      const provider = model.providers.get(param);
      if (!provider || provider.collection === collection.name)
        parameters.add(param);
    }

  return [...parameters].sort();
}

function upstreamOf(doc: CatalogDocument): URL {
  const raw = doc.servers?.[0]?.url;
  if (!raw) throw new Error('Catalog document declares no servers');
  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error('Catalog server must be an HTTP(S) URL');

  return url;
}

export interface PlatformDescription {
  /** Values the user fills in during setup, e.g. `workspaceId`. */
  parameters: string[];
  /** Collection names the import reads. */
  collections: string[];
  /** The provider API base, from the document's `servers`. */
  upstream: string;
}

export function describePlatform(doc: CatalogDocument): PlatformDescription {
  const model = discoverModel(doc);

  return {
    parameters: rootParameters(model),
    collections: model.collections.map(c => c.name),
    upstream: upstreamOf(doc).href,
  };
}

// ---------------------------------------------------------------------------
// Query selections (catalog defaults plus per-installation overrides)

export interface QuerySelection {
  query_overrides: { path: string; values: Record<string, unknown> }[];
}

function querySelection(value: unknown): QuerySelection {
  if (value === undefined || value === null) return { query_overrides: [] };
  if (!isRecord(value)) throw new Error('Invalid catalog selection');
  if (value.query_overrides === undefined) return { query_overrides: [] };
  if (
    !Array.isArray(value.query_overrides) ||
    value.query_overrides.some(
      item =>
        !isRecord(item) ||
        typeof item.path !== 'string' ||
        !isRecord(item.values),
    )
  )
    throw new Error('Invalid catalog selection');

  return value as unknown as QuerySelection;
}

export function mergeQuerySelections(
  defaults: unknown,
  explicit?: unknown,
): QuerySelection | undefined {
  const merged = new Map<string, Record<string, unknown>>();
  for (const selection of [querySelection(defaults), querySelection(explicit)])
    for (const override of selection.query_overrides)
      merged.set(override.path, {
        ...merged.get(override.path),
        ...override.values,
      });

  return merged.size
    ? {
        query_overrides: [...merged].map(([path, values]) => ({
          path,
          values,
        })),
      }
    : undefined;
}

function getOperation(doc: CatalogDocument, path: string) {
  const operation = doc.paths?.[path]?.get;

  return isRecord(operation) ? (operation as Operation) : undefined;
}

function applySelection(
  doc: CatalogDocument,
  model: Model,
  selection: QuerySelection | undefined,
) {
  for (const override of selection?.query_overrides ?? []) {
    const matches = model.collections.filter(c => c.url === override.path);
    if (matches.length !== 1)
      throw new Error(`Unknown or ambiguous collection path ${override.path}`);
    const operation = getOperation(doc, override.path);
    if (!operation)
      throw new Error(`Collection ${override.path} has no GET operation`);
    const declared = new Set(
      (operation.parameters ?? [])
        .map(p => deref(doc, p, 'parameters'))
        .filter(p => p?.in === 'query')
        .map(p => p!.name),
    );

    for (const [name, value] of Object.entries(override.values)) {
      if (!declared.has(name))
        throw new Error(`Unknown query parameter ${name} for ${override.path}`);
      matches[0]!.listQuery[name] = text(value);
    }
  }
}

// ---------------------------------------------------------------------------
// Ontology (after the removed Rust sync/ontology.rs)

const DATATYPE = 'https://atomicdata.dev/datatypes/';

/** `updated_at` -> `updated-at`: lowercase, runs of other characters collapse to one `-`. */
export function ontologyShortname(name: string): string {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .join('-');
}

function datatypeOf(schema: Schema | undefined): string | undefined {
  switch (schema?.type) {
    case 'string':
      return schema.format === 'date-time'
        ? `${DATATYPE}timestamp`
        : schema.format === 'date'
          ? `${DATATYPE}date`
          : `${DATATYPE}string`;
    case 'integer':
      return `${DATATYPE}integer`;
    case 'number':
      return `${DATATYPE}float`;
    case 'boolean':
      return `${DATATYPE}boolean`;
  }
}

function claim(claimed: Map<string, string>, original: string): string {
  const shortname = ontologyShortname(original);
  const existing = claimed.get(shortname);
  if (existing !== undefined && existing !== original)
    throw new Error(
      `Ontology shortname ${shortname} is claimed by both ${existing} and ${original}`,
    );
  claimed.set(shortname, original);

  return shortname;
}

function flatten(doc: CatalogDocument, schema: Schema | undefined): Schema {
  const resolved = deref(doc, schema);
  if (!resolved?.allOf) return resolved ?? {};

  return resolved.allOf
    .map(branch => flatten(doc, branch))
    .reduce<Schema>(
      (merged, branch) => ({
        ...merged,
        required: [...(merged.required ?? []), ...(branch.required ?? [])],
        properties: { ...merged.properties, ...branch.properties },
      }),
      { ...resolved, allOf: undefined },
    );
}

interface Ontology {
  description: string;
  terms: Term[];
}
/** Datatype URLs are the enum's values; the enum itself lives in browser/lib. */
const dt = (url: string) => url as Term['datatype'];

function deriveOntology(doc: CatalogDocument): Ontology {
  const title = doc.info?.title?.trim() ?? '';
  const base = title ? ontologyShortname(title) : 'ontology';
  const terms: Ontology['terms'] = [];
  const classNames = new Map<string, string>();
  const propertyNames = new Map<string, string>();
  const propertyTerms = new Map<string, number>();
  // Rust kept `None` for an unplaceable or conflicting type; JSON is the
  // same "preserve the value as-is" fallback, stated explicitly.
  const known = new Map<number, string | undefined>();

  for (const [resource, def] of Object.entries(crudResources(doc))) {
    if (!isRecord(def)) continue;
    const classShortname = claim(classNames, resource);
    const schema = flatten(doc, def.schema as Schema | undefined);
    const required = new Set(schema.required ?? []);
    const requires: string[] = [];
    const recommends: string[] = [];

    for (const [field, raw] of Object.entries(schema.properties ?? {})) {
      const fieldSchema = deref(doc, raw);
      const shortname = claim(propertyNames, field);
      const datatype = datatypeOf(fieldSchema);
      let index = propertyTerms.get(shortname);

      if (index === undefined) {
        index = terms.length;
        propertyTerms.set(shortname, index);
        known.set(index, datatype);
        terms.push({
          path: `${base}/property/${shortname}`,
          kind: 'property',
          shortname,
          description:
            fieldSchema?.description ?? `\`${field}\` of \`${resource}\`.`,
          datatype: dt(datatype ?? `${DATATYPE}json`),
          requires: [],
          recommends: [],
        });
      } else if (known.get(index) !== datatype) {
        // Shared across resources with different types: keep raw JSON.
        known.set(index, undefined);
        terms[index]!.datatype = dt(`${DATATYPE}json`);
      }

      (required.has(field) ? requires : recommends).push(terms[index]!.path);
    }

    terms.push({
      path: `${base}/class/${classShortname}`,
      kind: 'class',
      shortname: classShortname,
      description:
        typeof def.description === 'string'
          ? def.description
          : `The \`${resource}\` resource.`,
      datatype: dt(`${DATATYPE}json`),
      requires,
      recommends,
    });
  }

  return {
    description: title
      ? `Derived from the "${title}" OpenAPI document.`
      : 'Derived from an OpenAPI document.',
    terms,
  };
}

// ---------------------------------------------------------------------------
// Pagination (after syncables/src/pagination/*)

const SCHEME_TYPES = new Set(['pageNumber', 'pageToken', 'nextLink']);

function mergeDeep<T>(base: T, overrides: unknown): T {
  if (!isRecord(base) || !isRecord(overrides)) return overrides as T;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(overrides))
    out[k] = isRecord(out[k]) && isRecord(v) ? mergeDeep(out[k], v) : v;

  return out as T;
}

function effectiveScheme(
  doc: CatalogDocument,
  operation: Operation,
): Scheme | undefined {
  const schemes = Object.entries(
    doc.components?.paginationSchemes ?? {},
  ).filter(([, s]) => isRecord(s) && SCHEME_TYPES.has(s.type));
  const explicit = operation['x-pagination'];

  if (Array.isArray(explicit) && explicit.length) {
    const application = explicit[0]!;
    const base = schemes.find(([name]) => name === application.scheme)?.[1];
    if (!base) return undefined;

    return application.overrides
      ? mergeDeep(base, application.overrides)
      : base;
  }

  const declared = new Set(
    (operation.parameters ?? [])
      .map(p => deref(doc, p, 'parameters'))
      .filter(p => p?.in === 'query')
      .map(p => p!.name),
  );

  for (const [, scheme] of schemes) {
    if (scheme.autoDetect === false) continue;
    const options = isRecord(scheme.autoDetect) ? scheme.autoDetect : {};
    if (options.matchQueryParams === false) continue;
    const required = Object.keys(scheme.request?.queryParameters ?? {});
    if (required.length && required.every(name => declared.has(name)))
      return scheme;
  }
}

const withRole = (scheme: Scheme, role: string) =>
  Object.entries(scheme.request?.queryParameters ?? {})
    .filter(([, f]) => f.role === role)
    .map(([name]) => name);

interface Cursor {
  offset?: number;
  page?: number;
  token?: string;
}

function pageQuery(scheme: Scheme, cursor: Cursor): Record<string, string> {
  const query: Record<string, string> = {};
  for (const name of withRole(scheme, 'offset'))
    query[name] = String(cursor.offset ?? 0);
  for (const name of withRole(scheme, 'page'))
    query[name] = String(cursor.page ?? 1);
  if (cursor.token !== undefined)
    for (const name of [
      ...withRole(scheme, 'pageToken'),
      ...withRole(scheme, 'cursor'),
    ])
      query[name] = cursor.token;

  return query;
}

export function parseLinkHeader(header: string): string | null {
  for (const part of header.split(/,\s*(?=<)/)) {
    const match = part.match(/^\s*<([^>]+)>(.*)/);
    const rel = match?.[2]?.match(/\brel\s*=\s*"?([^";,\s]+)"?/i);
    if (rel?.[1]?.trim().toLowerCase() === 'next') return match![1]!;
  }

  return null;
}

function readPath(body: unknown, path: string): unknown {
  let node = body;

  for (const segment of path.split('.')) {
    if (!isRecord(node)) return undefined;
    node = node[segment];
  }

  return node;
}

interface PageState {
  token: string | null;
  link: string | null;
  hasNext: boolean;
}

function pageState(
  scheme: Scheme,
  body: unknown,
  headers: Record<string, string>,
  itemsSoFar: number,
): PageState {
  const roles = new Map<string, unknown>();

  for (const [path, field] of Object.entries(scheme.response?.bodyFields ?? {}))
    if (field.role) {
      const value = readPath(body, path);
      if (value !== undefined) roles.set(field.role, value);
    }

  for (const [name, field] of Object.entries(scheme.response?.headers ?? {}))
    if (field.role) {
      const raw = headers[name.toLowerCase()];
      if (raw === undefined) continue;
      if (field.role === 'nextLink') {
        const link = parseLinkHeader(raw);
        if (link) roles.set('nextLink', link);
      } else roles.set(field.role, raw);
    }

  const str = (v: unknown) =>
    v === null || v === undefined || v === '' ? null : String(v);
  const num = (v: unknown) =>
    v === null || v === undefined || Number.isNaN(Number(v)) ? null : Number(v);
  const token = str(roles.get('nextPageToken') ?? roles.get('nextCursor'));
  const link = str(roles.get('nextLink'));
  const total = num(roles.get('totalCount'));
  const current = num(roles.get('currentPage'));
  const pages = num(roles.get('totalPages'));
  const size = num(roles.get('pageSize'));
  let hasNext = false;

  if (token !== null || link !== null) hasNext = true;
  else if (total !== null) hasNext = itemsSoFar < total;
  else if (scheme.type === 'pageNumber' && current !== null) {
    if (pages !== null) hasNext = current < pages;
    else if (size !== null && total !== null) hasNext = current * size < total;
  }

  return { token, link, hasNext };
}

const COMMON_ITEMS_FIELDS = ['items', 'data', 'results', 'records', 'content'];

function responseItems(
  doc: CatalogDocument,
  operation: Operation,
  scheme: Scheme | undefined,
  body: unknown,
): Record<string, unknown>[] {
  const schema = flatten(
    doc,
    operation.responses?.['200']?.content?.['application/json']?.schema,
  );
  let array: unknown;

  if (schema.type === 'array') array = body;
  else {
    const metadata = new Set(
      Object.keys(scheme?.response?.bodyFields ?? {}).map(k => k.split('.')[0]),
    );
    const properties = schema.properties ?? {};
    const field =
      Object.entries(properties).find(
        ([name, s]) => !metadata.has(name) && deref(doc, s)?.type === 'array',
      )?.[0] ??
      COMMON_ITEMS_FIELDS.find(n => n in properties && !metadata.has(n));
    array = field !== undefined && isRecord(body) ? body[field] : body;
  }

  if (!Array.isArray(array))
    throw new Error('Could not locate the items array in the response');

  return array.filter(isRecord);
}

// ---------------------------------------------------------------------------
// The walk

/** One GET through the connection. Resolves with the provider's response. */
export type Transport = (
  url: URL,
) => Promise<{ status: number; headers: Record<string, string>; body: string }>;

export interface ReadLimits {
  /** Requests across the whole import, including retries. */
  maxRequests: number;
  /** Records across the whole import; more stops with a warning. */
  maxRecords: number;
  /** Wall-clock budget for the whole import. */
  timeoutMs: number;
  /** 429 retries per request, honouring Retry-After. */
  maxRetries: number;
}
export const DEFAULT_READ_LIMITS: ReadLimits = {
  maxRequests: 10000,
  maxRecords: 5000,
  timeoutMs: 30 * 60 * 1000,
  maxRetries: 3,
};

export interface ReadOptions {
  platform: string;
  constants: Record<string, string>;
  selection?: QuerySelection;
  transport: Transport;
  limits?: Partial<ReadLimits>;
  sleep?: (ms: number) => Promise<void>;
  /** Check access with the first request of the first root collection; import nothing. */
  probe?: boolean;
}

interface Origin {
  value: Record<string, unknown>;
  path: Record<string, string>;
}

/** A whole-import budget ran out: stop every collection, keep what was read. */
class BudgetExhausted extends Error {}
class ProbeDone extends Error {}

function bindPath(template: string, values: Record<string, string>): string {
  return template.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = values[name];
    if (value === undefined || value === '')
      throw new Error(`Missing value for ${name}`);

    return encodeURIComponent(value);
  });
}

/** Every combination of provider values, one parent record per provider collection. */
function invocations(
  collection: Collection,
  model: Model,
  constants: Record<string, string>,
  origins: Map<string, Origin[]>,
): Record<string, string>[] {
  const groups = new Map<string, { param: string; field: string }[]>();

  for (const param of collection.contextParams) {
    if (param in constants) continue;
    const provider = model.providers.get(param)!;
    groups.set(provider.collection, [
      ...(groups.get(provider.collection) ?? []),
      { param, field: provider.field },
    ]);
  }

  let combos: Record<string, string>[] = [{ ...constants }];

  for (const [source, params] of groups) {
    const next: Record<string, string>[] = [];

    for (const combo of combos)
      for (const parent of origins.get(source) ?? []) {
        const values = { ...parent.path, ...combo };
        for (const { param, field } of params)
          values[param] = text(parent.value[field]);
        if (params.every(({ param }) => values[param])) next.push(values);
      }

    combos = next;
  }

  const seen = new Set<string>();

  return combos.filter(combo => {
    const key = JSON.stringify(
      collection.contextParams.map(p => combo[p] ?? ''),
    );
    if (seen.has(key)) return false;
    seen.add(key);

    return true;
  });
}

function typedValue(value: unknown, datatype: string): unknown {
  if (value === null || value === undefined) return undefined;

  if (datatype === `${DATATYPE}timestamp`) {
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/i.test(
        value,
      )
    )
      throw new Error('Invalid provider timestamp');

    return Date.parse(value);
  }

  return value;
}

/**
 * Walk every collection of the document through `transport` and return the
 * records and the derived ontology. Collections whose context comes from a
 * parent run once per parent record, after the parent. A failed collection
 * becomes a warning in `errors`; an import with errors and no records throws.
 */
export async function readPlatform(
  doc: CatalogDocument,
  options: ReadOptions,
): Promise<FetchedPlatform> {
  const limits = { ...DEFAULT_READ_LIMITS, ...options.limits };
  const sleep =
    options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const model = discoverModel(doc);
  applySelection(doc, model, options.selection);
  const upstream = upstreamOf(doc);
  const basePath = upstream.pathname.replace(/\/$/, '');
  const constants = options.constants;
  for (const param of rootParameters(model))
    if (!constants[param]) throw new Error(`Enter a value for ${param}`);
  const ontology = options.probe ? undefined : deriveOntology(doc);
  const properties = new Map<string, string>(
    (ontology?.terms ?? [])
      .filter(t => t.kind === 'property')
      .map(t => [t.shortname, t.datatype]),
  );
  const deadline = Date.now() + limits.timeoutMs;
  let requests = 0;
  const records: FetchedRecord[] = [];
  const identities = new Set<string>();
  const errors: string[] = [];
  const origins = new Map<string, Origin[]>();

  const get = async (url: URL) => {
    for (let retries = 0; ; retries++) {
      if (Date.now() > deadline) throw new BudgetExhausted('Import timed out');
      if (++requests > limits.maxRequests)
        throw new BudgetExhausted(
          `Import exceeds ${limits.maxRequests} requests; narrow its scope`,
        );
      const raw = await options.transport(url);
      const response = {
        ...raw,
        headers: Object.fromEntries(
          Object.entries(raw.headers).map(([k, v]) => [k.toLowerCase(), v]),
        ),
      };
      if (response.status !== 429 || retries >= limits.maxRetries)
        return response;
      const retryAfter = response.headers['retry-after'];
      const seconds = Number(retryAfter);
      const at = Number.isFinite(seconds)
        ? Date.now() + Math.max(0, seconds) * 1000
        : retryAfter
          ? Date.parse(retryAfter)
          : NaN;
      if (!Number.isFinite(at)) return response;
      const delay = Math.max(0, at - Date.now());
      if (Date.now() + delay > deadline)
        throw new Error('API retry delay exceeds remaining import time');
      await sleep(delay);
    }
  };

  const walk = async (collection: Collection, path: Record<string, string>) => {
    const operation = getOperation(doc, collection.url);
    if (!operation)
      throw new Error(`${collection.url} declares no GET operation`);
    const scheme = effectiveScheme(doc, operation);
    const namespace = collection.contextParams
      .map(p => path[p] ?? '')
      .join('/');
    const first = new URL(upstream.href);
    first.pathname = basePath + bindPath(collection.url, path);
    const out: Origin[] = [];
    let cursor: Cursor = {};
    let next: URL | undefined;
    const seenPages = new Set<string>();

    for (;;) {
      let url = next;

      if (!url) {
        url = new URL(first.href);
        const query = {
          ...collection.listQuery,
          ...(scheme ? pageQuery(scheme, cursor) : {}),
        };
        for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
      }

      if (seenPages.has(url.href))
        throw new Error('Pagination repeated a page; stopping');
      seenPages.add(url.href);
      const response = await get(url);
      if (response.status < 200 || response.status >= 300)
        throw new Error(`GET ${url.pathname} responded ${response.status}`);
      let body: unknown;

      try {
        body = JSON.parse(response.body);
      } catch {
        throw new Error(`GET ${url.pathname} did not return JSON`);
      }

      const items = responseItems(doc, operation, scheme, body);
      if (options.probe) throw new ProbeDone();

      for (const value of items) {
        const id = text(value[collection.idField]);
        const key = JSON.stringify([collection.resource, namespace, id]);
        if (!id || identities.has(key))
          throw new Error(
            'Missing or repeated record identity; pagination may not be forwarded by the proxy',
          );
        if (records.length >= limits.maxRecords)
          throw new BudgetExhausted(
            `Import exceeds ${limits.maxRecords} records; narrow its scope`,
          );
        identities.add(key);
        const values: FetchedRecord['values'] = {};

        for (const [field, raw] of Object.entries(value)) {
          const shortname = ontologyShortname(field);
          const datatype = properties.get(shortname);
          if (!datatype) continue;
          const typed = typedValue(raw, datatype);
          if (typed !== undefined)
            values[shortname] = typed as FetchedRecord['values'][string];
        }

        const name = [value.title, value.summary, value.name].find(
          v => typeof v === 'string' && v,
        ) as string | undefined;
        records.push({
          resource: ontologyShortname(collection.resource),
          namespace,
          id,
          name: name ?? id,
          values,
        });
        out.push({ value, path });
      }

      if (!scheme) break;
      const state = pageState(scheme, body, response.headers, out.length);
      if (!state.hasNext) break;

      if (scheme.type === 'nextLink' || (state.link && !state.token)) {
        if (!state.link) break;
        const link = new URL(state.link, url);
        if (
          link.origin !== upstream.origin ||
          link.username ||
          link.password ||
          link.hash
        )
          throw new Error('Pagination left the catalog API origin');
        next = link;
      } else if (scheme.type === 'pageToken') {
        if (state.token === null) break;
        cursor = { token: state.token };
        next = undefined;
      } else {
        if (!items.length) break;
        if (withRole(scheme, 'offset').length)
          cursor = { offset: (cursor.offset ?? 0) + items.length };
        else if (withRole(scheme, 'page').length)
          cursor = { page: (cursor.page ?? 1) + 1 };
        else break;
        next = undefined;
      }
    }

    return out;
  };

  let pending = [...model.collections];

  while (pending.length) {
    const waiting: Collection[] = [];
    let progressed = false;

    for (const collection of pending) {
      const sources = collection.contextParams
        .filter(p => !(p in constants))
        .map(p => model.providers.get(p)!.collection);

      if (sources.includes(collection.name)) {
        errors.push(`${collection.name}: its context has no provider`);
        progressed = true;
        continue;
      }

      if (!sources.every(source => origins.has(source))) {
        waiting.push(collection);
        continue;
      }

      progressed = true;
      const read: Origin[] = [];

      for (const path of invocations(collection, model, constants, origins)) {
        try {
          read.push(...(await walk(collection, path)));
        } catch (error) {
          if (error instanceof ProbeDone) return emptyResult(options.platform);
          if (options.probe) throw error;
          errors.push(`${collection.name}: ${(error as Error).message}`);

          if (error instanceof BudgetExhausted) {
            pending = [];
            break;
          }
        }
      }

      origins.set(collection.name, read);
      if (!pending.length) break;
    }

    if (!pending.length) break;

    if (!progressed) {
      for (const c of waiting)
        errors.push(`${c.name}: its parent collection could not be read`);
      break;
    }

    pending = waiting;
  }

  if (options.probe) throw new Error('No collection available to check');
  if (!records.length && errors.length)
    throw new Error(
      `Import incomplete; no changes proposed: ${errors.join('; ')}`,
    );

  return {
    platform: options.platform,
    ontology: ontology as FetchedPlatform['ontology'],
    records,
    errors,
  };
}

const emptyResult = (platform: string): FetchedPlatform => ({
  platform,
  ontology: { description: '', terms: [] },
  records: [],
  errors: [],
});

// ---------------------------------------------------------------------------
// The browser-facing composition

/**
 * `BrowserIntegrations` (OAuth/PKCE, rotating-code transport) plus the read
 * path above. The one object the data-browser's LocalThought setup and sync
 * need; nothing in it is specific to a platform.
 */
export class PlatformReader {
  constructor(
    private integrations: BrowserIntegrations,
    private limits: Partial<ReadLimits> = {},
  ) {}

  /** Setup form: parameters to ask for, and what will be imported. */
  async describe(platform: string): Promise<PlatformDescription> {
    return describePlatform(await this.integrations.catalogDocument(platform));
  }

  private async run(
    connection: {
      drive: string;
      actor: string;
      connection: string;
      platform: string;
    },
    constants: Record<string, string>,
    selection: unknown,
    probe: boolean,
  ) {
    const { drive, actor, platform } = connection;
    const [doc, defaults] = await Promise.all([
      this.integrations.catalogDocument(platform),
      this.integrations.catalogSelection(platform),
    ]);
    const upstream = upstreamOf(doc);

    const transport: Transport = async url => {
      if (url.origin !== upstream.origin)
        throw new Error('Pagination left the catalog API origin');

      return this.integrations.request(
        drive,
        actor,
        connection.connection,
        platform,
        `${url.pathname}${url.search}`,
      );
    };

    return readPlatform(doc, {
      platform,
      constants,
      selection: mergeQuerySelections(defaults, selection),
      transport,
      limits: this.limits,
      probe,
    });
  }

  /** Import every collection of the connection's platform. */
  read(
    connection: {
      drive: string;
      actor: string;
      connection: string;
      platform: string;
    },
    constants: Record<string, string>,
    selection?: unknown,
  ): Promise<FetchedPlatform> {
    return this.run(connection, constants, selection, false);
  }

  /** One request to the first root collection: proves access, imports nothing. */
  async check(
    connection: {
      drive: string;
      actor: string;
      connection: string;
      platform: string;
    },
    constants: Record<string, string>,
    selection?: unknown,
  ): Promise<void> {
    await this.run(connection, constants, selection, true);
  }
}

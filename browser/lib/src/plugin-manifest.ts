import type { JSONValue } from './value.js';

/**
 * What a plugin declares it needs.
 *
 * Written in the plugin's own source, beside the code that uses it:
 *
 * ```js
 * export const manifest = {
 *   secrets: [{ name: 'google', origin: 'https://www.googleapis.com',
 *               description: 'Google Calendar API token' }],
 * };
 * ```
 *
 * Two things follow from putting it there rather than in resource properties.
 * The declaration cannot drift from the code that spends it — the same file
 * says `secret:google` and asks for `google`. And an author, human or model,
 * writes one artifact rather than remembering to fill in a form elsewhere.
 *
 * Version two of the schema is the single manifest for both runtimes; the
 * server's `server/src/plugins/manifest.rs` is the reference and both sides
 * are checked against the fixtures in `testdata/plugin-manifest/`.
 */
export interface DeclaredSecret {
  /** Referred to in the source as `secret:<name>`. */
  name: string;
  /** The exact origin it may be sent to. */
  origin: string;
  /** Shown to whoever has to find the credential. */
  description?: string;
}

export interface DeclaredOperation {
  id: string;
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Endpoint without query/fragment. Typed {number}/{uuid} segments permit positive decimal IDs/hyphenated UUIDs only. */
  url: string;
  effect: 'read' | 'write';
}

export type ManifestRuntime = 'atomic-js/1' | 'wasip2/1';

/** The trust boundary, independent of the language. */
export type ManifestWorld = 'extension' | 'server-extension';

export type CapabilityName =
  | 'storage'
  | 'full-drive-access'
  | 'extended-fuel'
  | 'extended-memory'
  | 'custom-view';

/** Either the bare name or the name with the reason shown at review. */
export type DeclaredCapability =
  | CapabilityName
  | { name: CapabilityName; reason?: string };

export interface DeclaredEntrypoints {
  /** Exports `run`. Defaults to true only when `entrypoints` is absent. */
  run?: boolean;
  /** Package-relative path of the custom view module. Needs `custom-view`. */
  view?: string;
  /** Class URLs whose hooks this package exports. Only in `server-extension`. */
  classExtender?: string[];
}

/**
 * Coarse egress allowance for packages that call the host `fetch` without an
 * operation id. Exact origins, no wildcards. Never widens `operations`.
 */
export interface DeclaredNetwork {
  origins?: string[];
  reason?: string;
}

export interface PluginManifestV2 {
  schemaVersion: 2;
  /** Defaults to `atomic-js/1`. */
  runtime?: ManifestRuntime;
  /** Defaults to `extension`. */
  world?: ManifestWorld;
  entrypoints?: DeclaredEntrypoints;
  capabilities?: DeclaredCapability[];
  secrets: DeclaredSecret[];
  operations?: DeclaredOperation[];
  actions?: DeclaredAction[];
  network?: DeclaredNetwork;
  configSchema?: Record<string, JSONValue>;
  defaultConfig?: Record<string, JSONValue>;
  name?: string;
  namespace?: string;
  version?: string;
  description?: string;
  author?: string;
}

export interface PluginManifest extends Omit<
  PluginManifestV2,
  'schemaVersion'
> {
  schemaVersion?: 1 | 2;
}

export interface DeclaredAction {
  name: string;
  title: string;
  description: string;
  operation: string;
  inputSchema: {
    type: 'object';
    properties: Record<
      string,
      { type: 'string' | 'integer' | 'boolean'; description: string }
    >;
    required?: string[];
    additionalProperties: false;
  };
}

/**
 * Normalizes whatever a plugin exported as `manifest`.
 *
 * Same posture as `parseVerdict`: the export is authored by an LLM as often as
 * a person, so anything malformed is dropped rather than trusted, and a plugin
 * that declares nothing usable declares nothing.
 */
export function parseManifest(raw: unknown): PluginManifest {
  if (raw && typeof raw === 'object' && 'schemaVersion' in raw) {
    return validateManifest(raw);
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { secrets: [] };
  }

  const secrets = (raw as { secrets?: unknown }).secrets;

  if (!Array.isArray(secrets)) return { secrets: [] };

  const seen = new Set<string>();

  return {
    secrets: secrets.flatMap(entry => {
      if (!entry || typeof entry !== 'object') return [];

      const { name, origin, description } = entry as Record<string, JSONValue>;

      if (typeof name !== 'string' || name.length === 0) return [];

      if (typeof origin !== 'string' || origin.length === 0) return [];

      // A name declared twice would render two slots writing to one secret.
      if (seen.has(name)) return [];

      seen.add(name);

      return [
        {
          name,
          origin,
          ...(typeof description === 'string' ? { description } : {}),
        },
      ];
    }),
  };
}

/**
 * Secret names a plugin's source actually spends, whether or not it declared
 * them.
 *
 * A plugin that writes `secret:google_calendar_token` needs that credential
 * even if it forgot to say so — and an author who forgot is exactly the one who
 * cannot work out where to enter it. Scanning the source means the page can
 * offer a slot anyway, asking for the origin the declaration would have named.
 */
export function secretsMentionedIn(source: string): string[] {
  const found = new Set<string>();

  for (const match of source.matchAll(/secret:([A-Za-z0-9_-]+)/g)) {
    found.add(match[1]);
  }

  return [...found].sort();
}

/**
 * Origins a plugin's source actually requests.
 *
 * Where a credential may be sent is a fact about the plugin, not a second part
 * of the credential — and the source already says it. Reading it here lets an
 * undeclared secret be stored with one field, instead of asking someone to copy
 * an origin out of code they were not looking at.
 *
 * Only literal URLs are found, which is the point: a host assembled at runtime
 * is exactly the one nobody should pre-authorise by guess.
 */
export function originsMentionedIn(source: string): string[] {
  const found = new Set<string>();

  for (const match of source.matchAll(/https?:\/\/[a-zA-Z0-9.-]+(?::\d+)?/g)) {
    found.add(match[0]);
  }

  return [...found].sort();
}

/** The values a manifest is read with once its defaults are filled in. */
export interface ResolvedManifest {
  runtime: ManifestRuntime;
  world: ManifestWorld;
  entrypoints: Required<Pick<DeclaredEntrypoints, 'run'>> &
    Omit<DeclaredEntrypoints, 'run'>;
  capabilities: { name: CapabilityName; reason?: string }[];
  network: { origins: string[]; reason?: string };
}

/**
 * Fills the defaults a version-one manifest is upgraded with: the JS runtime,
 * the `extension` world and a `run` entrypoint.
 */
export function resolveManifest(manifest: PluginManifest): ResolvedManifest {
  const entrypoints = manifest.entrypoints ?? { run: true };

  return {
    runtime: manifest.runtime ?? 'atomic-js/1',
    world: manifest.world ?? 'extension',
    entrypoints: { ...entrypoints, run: entrypoints.run ?? false },
    capabilities: (manifest.capabilities ?? []).map(capability =>
      typeof capability === 'string' ? { name: capability } : capability,
    ),
    network: { ...manifest.network, origins: manifest.network?.origins ?? [] },
  };
}

const RUNTIMES: ManifestRuntime[] = ['atomic-js/1', 'wasip2/1'];
const WORLDS: ManifestWorld[] = ['extension', 'server-extension'];
const CAPABILITIES: CapabilityName[] = [
  'storage',
  'full-drive-access',
  'extended-fuel',
  'extended-memory',
  'custom-view',
];
const IDENTIFIER = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Strict validation for released code. Draft source scans never grant access.
 *
 * Returns the manifest in its canonical serialized form: the one the server
 * stores in a release and addresses it by. A version-one manifest stays
 * version one; version-two fields at their default are left out.
 */
export function validateManifest(raw: unknown): PluginManifest {
  const object = (value: unknown, what = 'manifest entry') => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error(`${what}: invalid type, expected a map`);

    return value as Record<string, unknown>;
  };

  const known = (entry: Record<string, unknown>, keys: string[]) => {
    for (const key of Object.keys(entry))
      if (!keys.includes(key)) throw new Error(`unknown field \`${key}\``);
  };

  const text = (value: unknown, what: string): string => {
    if (typeof value !== 'string')
      throw new Error(`${what}: invalid type, expected a string`);

    return value;
  };

  const endpoint = (value: unknown) => {
    if (typeof value !== 'string')
      throw new Error(
        'operation URLs must be HTTP endpoints without credentials, query or fragment',
      );
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error(
        'operation URLs must be HTTP endpoints without credentials, query or fragment',
      );

    return url;
  };

  const exactOrigin = (value: unknown, what: string) => {
    if (endpoint(value).origin !== value)
      throw new Error(`${what} must be an exact HTTP origin`);

    return value as string;
  };

  const list = (value: unknown, what = 'manifest field'): unknown[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value))
      throw new Error(`${what}: invalid type, expected a sequence`);

    return value;
  };

  const entry = object(raw, 'manifest');
  const version = entry.schemaVersion;
  if (version !== 1 && version !== 2)
    throw new Error('unsupported manifest schemaVersion');
  known(
    entry,
    version === 1
      ? ['schemaVersion', 'secrets', 'operations', 'actions']
      : [
          'schemaVersion',
          'runtime',
          'world',
          'entrypoints',
          'capabilities',
          'secrets',
          'operations',
          'actions',
          'network',
          'configSchema',
          'defaultConfig',
          'name',
          'namespace',
          'version',
          'description',
          'author',
        ],
  );

  const names = new Set<string>();
  const secrets = list(entry.secrets, 'secrets').map(value => {
    const secret = object(value);
    known(secret, ['name', 'origin', 'description']);
    if (
      typeof secret.name !== 'string' ||
      !secret.name ||
      names.has(secret.name)
    )
      throw new Error('secret names must be nonempty and unique');
    names.add(secret.name);
    if (
      secret.description !== undefined &&
      typeof secret.description !== 'string'
    )
      throw new Error('secret description must be text');
    exactOrigin(secret.origin, 'secret origin');

    return secret as unknown as DeclaredSecret;
  });
  names.clear();
  const operations = list(entry.operations, 'operations').map(value => {
    const operation = object(value);
    known(operation, ['id', 'method', 'url', 'effect']);
    if (
      typeof operation.id !== 'string' ||
      !operation.id ||
      names.has(operation.id)
    )
      throw new Error('operation IDs must be nonempty and unique');
    names.add(operation.id);
    endpoint(operation.url);
    if (
      typeof operation.method !== 'string' ||
      !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(
        operation.method,
      )
    )
      throw new Error('operation has an unsupported HTTP method');
    if (
      typeof operation.effect !== 'string' ||
      !['read', 'write'].includes(operation.effect)
    )
      throw new Error('operation effect must be read or write');

    return operation as unknown as DeclaredOperation;
  });
  names.clear();
  const actions = list(entry.actions, 'actions').map(value => {
    const action = object(value);
    known(action, ['name', 'title', 'description', 'operation', 'inputSchema']);
    if (
      typeof action.name !== 'string' ||
      !/^[A-Za-z0-9_.-]{1,128}$/.test(action.name) ||
      names.has(action.name) ||
      typeof action.title !== 'string' ||
      !action.title ||
      typeof action.description !== 'string' ||
      action.description.length > 8192
    )
      throw new Error('invalid or duplicate action name/description');
    if (!operations.some(o => o.id === action.operation))
      throw new Error('action references an undeclared operation');
    names.add(action.name);
    const schema = object(action.inputSchema);
    known(schema, ['type', 'properties', 'required', 'additionalProperties']);
    const properties = object(schema.properties);
    if (
      schema.type !== 'object' ||
      schema.additionalProperties !== false ||
      Object.keys(properties).length > 32 ||
      list(schema.required).some(
        key => typeof key !== 'string' || !(key in properties),
      )
    )
      throw new Error('unsupported action input schema');

    for (const rawField of Object.values(properties)) {
      const field = object(rawField);
      known(field, ['type', 'description']);
      if (
        !['string', 'integer', 'boolean'].includes(String(field.type)) ||
        typeof field.description !== 'string'
      )
        throw new Error('unsupported action input schema');
    }

    return action as unknown as DeclaredAction;
  });
  if (actions.length > 64) throw new Error('at most 64 actions per release');

  if (version === 1) {
    return {
      schemaVersion: 1,
      secrets,
      operations,
      ...(actions.length ? { actions } : {}),
    };
  }

  const variant = <T extends string>(
    value: unknown,
    allowed: T[],
    fallback: T,
  ): T => {
    if (value === undefined) return fallback;
    if (typeof value !== 'string' || !allowed.includes(value as T))
      throw new Error(`unknown variant \`${String(value)}\``);

    return value as T;
  };
  const runtime = variant(entry.runtime, RUNTIMES, 'atomic-js/1');
  const world = variant(entry.world, WORLDS, 'extension');

  const network = { origins: [] as string[], reason: undefined as unknown };
  if (entry.network !== undefined) {
    const declared = object(entry.network, 'network');
    known(declared, ['origins', 'reason']);
    network.origins = list(declared.origins, 'network.origins').map(origin =>
      exactOrigin(origin, 'network origin'),
    );
    if (new Set(network.origins).size !== network.origins.length)
      throw new Error('network origins must be unique');
    if (declared.reason !== undefined)
      network.reason = text(declared.reason, 'network.reason');
  }

  const seenCapabilities = new Set<string>();
  const capabilities = list(entry.capabilities, 'capabilities').map(value => {
    let name: unknown;
    let reason: unknown;
    if (typeof value === 'string') name = value;
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const declared = value as Record<string, unknown>;
      if (Object.keys(declared).some(key => !['name', 'reason'].includes(key)))
        throw new Error('capability must be a known name or {name, reason}');
      name = declared.name;
      reason = declared.reason;
    }
    if (
      typeof name !== 'string' ||
      !CAPABILITIES.includes(name as CapabilityName) ||
      (reason !== undefined && typeof reason !== 'string')
    )
      throw new Error('capability must be a known name or {name, reason}');
    if (seenCapabilities.has(name))
      throw new Error('capabilities must be unique');
    seenCapabilities.add(name);

    return reason === undefined
      ? (name as CapabilityName)
      : { name: name as CapabilityName, reason: reason as string };
  });

  const entrypoints: Required<DeclaredEntrypoints> = {
    run: entry.entrypoints === undefined,
    view: undefined as unknown as string,
    classExtender: undefined as unknown as string[],
  };
  if (entry.entrypoints !== undefined) {
    const declared = object(entry.entrypoints, 'entrypoints');
    known(declared, ['run', 'view', 'classExtender']);
    if (declared.run !== undefined) {
      if (typeof declared.run !== 'boolean')
        throw new Error('entrypoints.run: invalid type, expected a boolean');
      entrypoints.run = declared.run;
    }
    if (declared.view !== undefined)
      entrypoints.view = text(declared.view, 'entrypoints.view');
    if (declared.classExtender !== undefined)
      entrypoints.classExtender = list(
        declared.classExtender,
        'entrypoints.classExtender',
      ).map(url => text(url, 'entrypoints.classExtender'));
  }
  const classUrls = entrypoints.classExtender ?? [];
  if (entrypoints.classExtender !== undefined && classUrls.length === 0)
    throw new Error('classExtender must list at least one class URL');
  names.clear();
  for (const cls of classUrls) {
    const url = new URL(cls);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname)
      throw new Error('classExtender entries must be class URLs');
    if (names.has(cls)) throw new Error('classExtender entries must be unique');
    names.add(cls);
  }
  if (world === 'extension' && classUrls.length > 0)
    throw new Error('world extension may not declare classExtender');
  if (
    world === 'server-extension' &&
    runtime !== 'wasip2/1' &&
    classUrls.length === 0
  )
    throw new Error(
      'world server-extension requires runtime wasip2/1 or entrypoints.classExtender',
    );
  if (entrypoints.view !== undefined) {
    const view = entrypoints.view;
    if (
      !view ||
      view.startsWith('/') ||
      view.includes('\\') ||
      view.split('/').some(segment => !segment || segment === '..')
    )
      throw new Error('view entrypoint must be a package-relative path');
    if (!seenCapabilities.has('custom-view'))
      throw new Error('view entrypoint requires the custom-view capability');
  }

  const metadata: Partial<
    Pick<
      PluginManifestV2,
      'name' | 'namespace' | 'version' | 'description' | 'author'
    >
  > = {};
  for (const key of [
    'name',
    'namespace',
    'version',
    'description',
    'author',
  ] as const) {
    if (entry[key] !== undefined) metadata[key] = text(entry[key], key);
  }
  for (const key of ['namespace', 'name'] as const) {
    const value = metadata[key];
    if (value !== undefined && !IDENTIFIER.test(value))
      throw new Error(
        `plugin ${key} '${value}' is invalid: only ASCII letters, digits, '-' and '_' are allowed`,
      );
  }

  const entrypointsDefault =
    entrypoints.run === true &&
    entrypoints.view === undefined &&
    entrypoints.classExtender === undefined;

  return {
    schemaVersion: 2,
    ...(runtime !== 'atomic-js/1' ? { runtime } : {}),
    ...(world !== 'extension' ? { world } : {}),
    ...(entrypointsDefault
      ? {}
      : {
          entrypoints: {
            ...(entrypoints.run ? { run: true } : {}),
            ...(entrypoints.view !== undefined
              ? { view: entrypoints.view }
              : {}),
            ...(entrypoints.classExtender !== undefined
              ? { classExtender: entrypoints.classExtender }
              : {}),
          },
        }),
    ...(capabilities.length ? { capabilities } : {}),
    secrets,
    operations,
    ...(actions.length ? { actions } : {}),
    ...(network.origins.length || network.reason !== undefined
      ? {
          network: {
            ...(network.origins.length ? { origins: network.origins } : {}),
            ...(network.reason !== undefined
              ? { reason: network.reason as string }
              : {}),
          },
        }
      : {}),
    ...(entry.configSchema !== undefined
      ? {
          configSchema: object(entry.configSchema, 'configSchema') as Record<
            string,
            JSONValue
          >,
        }
      : {}),
    ...(entry.defaultConfig !== undefined
      ? {
          defaultConfig: object(entry.defaultConfig, 'defaultConfig') as Record<
            string,
            JSONValue
          >,
        }
      : {}),
    ...metadata,
  };
}

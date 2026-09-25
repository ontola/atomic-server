/**
 * The `http` block of a version-three plugin manifest: the public endpoints a
 * plugin asks the host to open, which gate they need, the `requires` derived
 * from them, and the refusal a node gives when its gates don't allow them.
 *
 * Mirrors `server/src/plugins/manifest_http.rs`. Both are checked against
 * `testdata/plugin-manifest/http-index.json` and `http-refusals.json`.
 * Design: atomic-plugins `docs/design/server-plugin-routes.md`, sections 0.1,
 * 0.4, 1 and 2.2.
 */

import { AtomicError } from './error.js';

export type RouteMount = 'installation-origin' | 'drive-host' | 'drive-prefix';
export type RoutePrincipal = 'anonymous' | 'installation' | 'caller';
export type RouteAuth =
  | 'none'
  | 'atomic'
  | 'http-signature'
  | 'bearer'
  | 'dpop';
export type RouteMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface DeclaredRoute {
  id: string;
  /** Literal segments, `{param}`, and a trailing `{*rest}`. No regex. */
  path: string;
  methods: RouteMethod[];
  /** Defaults to `anonymous`. */
  principal?: RoutePrincipal;
  /** Defaults to `none`. */
  auth?: RouteAuth;
  accept?: string[];
  /** Defaults to `none`. */
  cors?: 'none' | 'any-origin-no-credentials';
  maxBodyBytes?: number;
  body?: 'json' | 'text' | 'blob';
  /** Ids from `http.writeTargets`. */
  writes?: string[];
  /** Ids of declared write operations this route may schedule. */
  enqueues?: string[];
  timeoutMs?: number;
}

export interface DeclaredWellKnown {
  name: string;
  kind: 'shared' | 'exclusive';
  match?: { resourcePrefix: string };
  route: string;
}

export interface DeclaredWriteTarget {
  id: string;
  /** `config:<key>`, or a resource URL. */
  parent: string;
  classes: string[];
}

export interface DeclaredKey {
  name: string;
  alg: 'rsa-sha256' | 'ed25519';
  reason?: string;
}

export interface DeclaredOperatorNamed {
  name: string;
  reason?: string;
}

export interface DeclaredHttp {
  /** Defaults to `installation-origin`. */
  mount?: RouteMount;
  routes?: DeclaredRoute[];
  wellKnown?: DeclaredWellKnown[];
  writeTargets?: DeclaredWriteTarget[];
  keys?: DeclaredKey[];
  tokens?: DeclaredOperatorNamed[];
  /** Raw ports; only in `world: server-extension`. */
  listeners?: DeclaredOperatorNamed[];
  /** Loopback daemons the operator runs next to the server. */
  sidecars?: DeclaredOperatorNamed[];
  reason?: string;
}

/** A node's plugin-routes gate as `/plugin-catalog`'s `hostFeatures.pluginRoutes` reports it. */
export type PluginRoutesLevel = 'off' | 'read-only' | 'read-write';

export interface PluginRoutesStatus {
  compiled: boolean;
  level: PluginRoutesLevel;
  routesOrigin?: string | null;
  listeners: string[];
  sidecars: string[];
}

export interface GateSurface {
  /** How the review and the refusal name it: "route `POST /users/{name}/inbox`". */
  surface: string;
  needs: Exclude<PluginRoutesLevel, 'off'>;
}

export interface ReleaseGate {
  needed: 'none' | Exclude<PluginRoutesLevel, 'off'>;
  listeners: string[];
  sidecars: string[];
  surfaces: GateSurface[];
}

/** The typed problem a node answers when its gates don't allow a release. */
export interface HostFeatureUnavailable {
  type: 'host-feature-unavailable';
  feature: 'plugin-routes';
  needed: Exclude<PluginRoutesLevel, 'off'>;
  compiled: boolean;
  level: PluginRoutesLevel;
  /** What asked for more than the node allows. */
  surfaces: string[];
  /** Declared listeners and sidecars the operator has not configured. */
  listeners: string[];
  sidecars: string[];
}

export const HOST_FEATURE_UNAVAILABLE = 'host-feature-unavailable';

/** Thrown when the server refuses a release with `host-feature-unavailable`. */
export class HostFeatureUnavailableError extends Error {
  public readonly problem: HostFeatureUnavailable;

  public constructor(problem: HostFeatureUnavailable) {
    super(hostFeatureMessage(problem));
    this.name = 'HostFeatureUnavailableError';
    this.problem = problem;
  }
}

export const MAX_ROUTES = 32;
export const MAX_INLINE_BODY_BYTES = 1_048_576;
export const MAX_TIMEOUT_MS = 30_000;
const METHODS: RouteMethod[] = [
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
];
const SHARED_WELL_KNOWN = ['webfinger'];
const EXCLUSIVE_WELL_KNOWN = [
  'nodeinfo',
  'ocm',
  'atproto-did',
  'solid',
  'oauth-authorization-server',
  'oauth-protected-resource',
  'openid-configuration',
  'did.json',
];
const LEVELS: PluginRoutesLevel[] = ['off', 'read-only', 'read-write'];
const rank = (level: string) =>
  Math.max(0, LEVELS.indexOf(level as PluginRoutesLevel));

type Raw = Record<string, unknown>;

const object = (value: unknown, what: string): Raw => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${what}: invalid type, expected a map`);

  return value as Raw;
};

const known = (entry: Raw, keys: string[]) => {
  for (const key of Object.keys(entry))
    if (!keys.includes(key)) throw new Error(`unknown field \`${key}\``);
};

const list = (value: unknown, what: string): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value))
    throw new Error(`${what}: invalid type, expected a sequence`);

  return value;
};

const text = (value: unknown, what: string): string => {
  if (typeof value !== 'string')
    throw new Error(`${what}: invalid type, expected a string`);

  return value;
};

const optionalText = (value: unknown, what: string) =>
  value === undefined ? undefined : text(value, what);

const variant = <T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback?: T,
): T => {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T))
    throw new Error(`unknown variant \`${String(value)}\``);

  return value as T;
};

const texts = (value: unknown, what: string) =>
  list(value, what).map(v => text(v, what));

const validName = (name: string) =>
  name.length > 0 && name.length <= 64 && /^[a-z0-9-]+$/.test(name);

const uniqueNames = (names: string[], what: string) => {
  const seen = new Set<string>();

  for (const name of names) {
    if (!validName(name) || seen.has(name))
      throw new Error(
        `${what} must be names (lowercase letters, digits and -) and unique`,
      );
    seen.add(name);
  }

  return seen;
};

type Segment = { literal: string } | 'param' | 'rest';

function pattern(path: string): Segment[] {
  const invalid = () =>
    new Error(
      `route path \`${path}\` must be \`/\`-separated literal segments, \`{param}\` and a trailing \`{*rest}\`, without regex`,
    );
  if (!path.startsWith('/') || path.length > 256) throw invalid();
  const rest = path.slice(1);
  if (rest === '') return [];
  const identifier = (s: string) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s);
  const literal = (s: string) =>
    s !== '.' && s !== '..' && /^[A-Za-z0-9\-._~:@!,;=]+$/.test(s);
  const raw = rest.split('/');
  const params = new Set<string>();

  return raw.map((segment, i) => {
    const restMatch = /^\{\*(.*)\}$/.exec(segment);
    const paramMatch = /^\{(.*)\}$/.exec(segment);

    if (restMatch) {
      const name = restMatch[1];
      if (i + 1 !== raw.length || !identifier(name) || params.has(name))
        throw invalid();
      params.add(name);

      return 'rest' as const;
    }

    if (paramMatch) {
      const name = paramMatch[1];
      if (!identifier(name) || params.has(name)) throw invalid();
      params.add(name);

      return 'param' as const;
    }

    if (!literal(segment)) throw invalid();

    return { literal: segment };
  });
}

/** Whether some request path matches both. `{*rest}` matches one or more segments. */
function overlaps(a: Segment[], b: Segment[]): boolean {
  if (a.length === 0 && b.length === 0) return true;
  if (a[0] === 'rest') return b.length > 0;
  if (b[0] === 'rest') return a.length > 0;
  if (a.length === 0 || b.length === 0) return false;
  if (
    typeof a[0] === 'object' &&
    typeof b[0] === 'object' &&
    a[0].literal !== b[0].literal
  )
    return false;

  return overlaps(a.slice(1), b.slice(1));
}

/** An operation whose destination comes from data: `https://*\/inbox`. */
export function isWildcardHost(url: string): boolean {
  try {
    return new URL(url).hostname === '*';
  } catch {
    return false;
  }
}

export interface HttpContext {
  serverExtension: boolean;
  operations: { id: string; effect: string; url: string }[];
}

/**
 * Validates an `http` block and returns its canonical form: defaults left
 * out, and `undefined` when it holds nothing, so an empty block never changes
 * a release id.
 */
export function validateHttp(
  raw: unknown,
  context: HttpContext,
): DeclaredHttp | undefined {
  const entry = object(raw, 'http');
  known(entry, [
    'mount',
    'routes',
    'wellKnown',
    'writeTargets',
    'keys',
    'tokens',
    'listeners',
    'sidecars',
    'reason',
  ]);
  const mount = variant<RouteMount>(
    entry.mount,
    ['installation-origin', 'drive-host', 'drive-prefix'],
    'installation-origin',
  );

  const routes = list(entry.routes, 'http.routes').map(value => {
    const route = object(value, 'route');
    known(route, [
      'id',
      'path',
      'methods',
      'principal',
      'auth',
      'accept',
      'cors',
      'maxBodyBytes',
      'body',
      'writes',
      'enqueues',
      'timeoutMs',
    ]);

    const number = (key: string) => {
      const v = route[key];
      if (v === undefined) return undefined;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 0)
        throw new Error(`${key}: invalid type, expected an unsigned integer`);

      return v;
    };

    return {
      id: text(route.id, 'route id'),
      path: text(route.path, 'route path'),
      methods: texts(route.methods, 'route methods') as RouteMethod[],
      principal: variant<RoutePrincipal>(
        route.principal,
        ['anonymous', 'installation', 'caller'],
        'anonymous',
      ),
      auth: variant<RouteAuth>(
        route.auth,
        ['none', 'atomic', 'http-signature', 'bearer', 'dpop'],
        'none',
      ),
      accept: texts(route.accept, 'route accept'),
      cors: variant(route.cors, ['none', 'any-origin-no-credentials'], 'none'),
      maxBodyBytes: number('maxBodyBytes'),
      body:
        route.body === undefined
          ? undefined
          : variant(route.body, ['json', 'text', 'blob'] as const),
      writes: texts(route.writes, 'route writes'),
      enqueues: texts(route.enqueues, 'route enqueues'),
      timeoutMs: number('timeoutMs'),
    };
  });

  const wellKnown = list(entry.wellKnown, 'http.wellKnown').map(value => {
    const claim = object(value, 'well-known claim');
    known(claim, ['name', 'kind', 'match', 'route']);
    let match: { resourcePrefix: string } | undefined;

    if (claim.match !== undefined) {
      const m = object(claim.match, 'match');
      known(m, ['resourcePrefix']);
      match = { resourcePrefix: text(m.resourcePrefix, 'resourcePrefix') };
    }

    return {
      name: text(claim.name, 'well-known name'),
      kind: variant(claim.kind, ['shared', 'exclusive'] as const),
      match,
      route: text(claim.route, 'well-known route'),
    };
  });

  const writeTargets = list(entry.writeTargets, 'http.writeTargets').map(
    value => {
      const target = object(value, 'write target');
      known(target, ['id', 'parent', 'classes']);

      return {
        id: text(target.id, 'write target id'),
        parent: text(target.parent, 'write target parent'),
        classes: texts(target.classes, 'write target classes'),
      };
    },
  );

  const named = (value: unknown, what: string) => {
    const item = object(value, what);
    known(item, ['name', 'reason']);

    return {
      name: text(item.name, `${what} name`),
      reason: optionalText(item.reason, `${what} reason`),
    };
  };

  const keys = list(entry.keys, 'http.keys').map(value => {
    const key = object(value, 'key');
    known(key, ['name', 'alg', 'reason']);

    return {
      name: text(key.name, 'key name'),
      alg: variant(key.alg, ['rsa-sha256', 'ed25519'] as const),
      reason: optionalText(key.reason, 'key reason'),
    };
  });
  const tokens = list(entry.tokens, 'http.tokens').map(v => named(v, 'token'));
  const listeners = list(entry.listeners, 'http.listeners').map(v =>
    named(v, 'listener'),
  );
  const sidecars = list(entry.sidecars, 'http.sidecars').map(v =>
    named(v, 'sidecar'),
  );
  const reason = optionalText(entry.reason, 'http.reason');

  // The same checks, in the same order, as `Http::validate` in Rust.
  if (routes.length > MAX_ROUTES)
    throw new Error(
      `at most ${MAX_ROUTES} routes per installation, got ${routes.length}`,
    );
  uniqueNames(
    routes.map(r => r.id),
    'route IDs',
  );
  const targets = uniqueNames(
    writeTargets.map(t => t.id),
    'write target IDs',
  );
  uniqueNames(
    keys.map(k => k.name),
    'key names',
  );
  uniqueNames(
    tokens.map(t => t.name),
    'token names',
  );
  uniqueNames(
    listeners.map(l => l.name),
    'listener names',
  );
  uniqueNames(
    sidecars.map(s => s.name),
    'sidecar names',
  );

  const patterns: { id: string; methods: string[]; segments: Segment[] }[] = [];

  for (const route of routes) {
    const segments = pattern(route.path);
    if (
      route.methods.length === 0 ||
      route.methods.some(
        (m, i) => !METHODS.includes(m) || route.methods.indexOf(m) !== i,
      )
    )
      throw new Error(
        `route methods must be unique and from ${METHODS.join(', ')}`,
      );
    if (route.principal === 'caller' && route.auth !== 'atomic')
      throw new Error('principal caller requires auth atomic');
    if (
      mount === 'drive-prefix' &&
      route.principal !== 'anonymous' &&
      route.auth !== 'atomic'
    )
      throw new Error(
        'routes on the drive-prefix mount must use principal anonymous unless auth is atomic',
      );
    if (route.auth === 'bearer' && tokens.length === 0)
      throw new Error('auth bearer requires http.tokens');
    if (route.accept.some(a => !a.includes('/')))
      throw new Error('route accept entries must be media types');

    if (route.maxBodyBytes !== undefined) {
      const cap = route.body === 'blob' ? Infinity : MAX_INLINE_BODY_BYTES;
      if (route.maxBodyBytes === 0 || route.maxBodyBytes > cap)
        throw new Error(
          `maxBodyBytes must be between 1 and ${MAX_INLINE_BODY_BYTES}`,
        );
    }

    if (
      route.timeoutMs !== undefined &&
      (route.timeoutMs === 0 || route.timeoutMs > MAX_TIMEOUT_MS)
    )
      throw new Error(`timeoutMs must be between 1 and ${MAX_TIMEOUT_MS}`);
    if (route.writes.some(w => !targets.has(w)))
      throw new Error('writes must name declared writeTargets');
    if (
      route.enqueues.some(
        id =>
          !context.operations.some(o => o.id === id && o.effect === 'write'),
      )
    )
      throw new Error('enqueues must name declared write operations');

    for (const other of patterns) {
      const shared = route.methods.some(m => other.methods.includes(m));
      if (shared && overlaps(other.segments, segments))
        throw new Error(`routes \`${other.id}\` and \`${route.id}\` overlap`);
    }

    patterns.push({ id: route.id, methods: route.methods, segments });
  }

  const claimed = new Set<string>();

  for (const claim of wellKnown) {
    const allowed = (
      claim.kind === 'shared' ? SHARED_WELL_KNOWN : EXCLUSIVE_WELL_KNOWN
    ).includes(claim.name);
    if (!allowed || claimed.has(claim.name))
      throw new Error(
        `well-known name \`${claim.name}\` is not claimable as ${claim.kind} (or claimed twice)`,
      );
    claimed.add(claim.name);
    const hasMatch = !!claim.match && claim.match.resourcePrefix.length > 0;
    if (hasMatch !== (claim.kind === 'shared'))
      throw new Error(
        'shared well-known claims need match.resourcePrefix; exclusive ones take none',
      );
    if (!routes.some(r => r.id === claim.route))
      throw new Error('well-known claims must name a declared route');
  }

  const isUrl = (value: string, schemes: string[], needsHost: boolean) => {
    try {
      const url = new URL(value);

      return schemes.includes(url.protocol) && (!needsHost || !!url.hostname);
    } catch {
      return false;
    }
  };

  for (const target of writeTargets) {
    const parentOk = target.parent.startsWith('config:')
      ? /^[A-Za-z0-9_.-]{1,128}$/.test(target.parent.slice('config:'.length))
      : isUrl(target.parent, ['https:', 'http:', 'did:'], false);
    const classesOk =
      target.classes.length > 0 &&
      new Set(target.classes).size === target.classes.length &&
      target.classes.every(c => isUrl(c, ['https:', 'http:'], true));
    if (!parentOk || !classesOk)
      throw new Error(
        `write target \`${target.id}\` needs a parent (\`config:<key>\` or a URL) and unique class URLs`,
      );
  }

  if (listeners.length > 0 && !context.serverExtension)
    throw new Error('http.listeners requires world server-extension');

  for (const operation of context.operations) {
    if (
      isWildcardHost(operation.url) &&
      !routes.some(r => r.enqueues.includes(operation.id))
    )
      throw new Error(
        "wildcard-host operations must be listed in a route's enqueues",
      );
  }

  const withReason = <T extends { reason?: string }>(item: T) => {
    const { reason: itemReason, ...rest } = item;

    return itemReason === undefined ? rest : { ...rest, reason: itemReason };
  };

  const canonical: DeclaredHttp = {
    ...(mount !== 'installation-origin' ? { mount } : {}),
    ...(routes.length
      ? {
          routes: routes.map(r => ({
            id: r.id,
            path: r.path,
            methods: r.methods,
            ...(r.principal !== 'anonymous' ? { principal: r.principal } : {}),
            ...(r.auth !== 'none' ? { auth: r.auth } : {}),
            ...(r.accept.length ? { accept: r.accept } : {}),
            ...(r.cors !== 'none' ? { cors: r.cors } : {}),
            ...(r.maxBodyBytes !== undefined
              ? { maxBodyBytes: r.maxBodyBytes }
              : {}),
            ...(r.body !== undefined ? { body: r.body } : {}),
            ...(r.writes.length ? { writes: r.writes } : {}),
            ...(r.enqueues.length ? { enqueues: r.enqueues } : {}),
            ...(r.timeoutMs !== undefined ? { timeoutMs: r.timeoutMs } : {}),
          })),
        }
      : {}),
    ...(wellKnown.length
      ? {
          wellKnown: wellKnown.map(({ match, ...claim }) =>
            match ? { ...claim, match } : claim,
          ),
        }
      : {}),
    ...(writeTargets.length ? { writeTargets } : {}),
    ...(keys.length ? { keys: keys.map(withReason) } : {}),
    ...(tokens.length ? { tokens: tokens.map(withReason) } : {}),
    ...(listeners.length ? { listeners: listeners.map(withReason) } : {}),
    ...(sidecars.length ? { sidecars: sidecars.map(withReason) } : {}),
    ...(reason !== undefined ? { reason } : {}),
  };

  return Object.keys(canonical).length ? canonical : undefined;
}

const isReadOnlyRoute = (route: DeclaredRoute) =>
  route.methods.every(m => m === 'GET' || m === 'HEAD') &&
  (route.principal ?? 'anonymous') === 'anonymous' &&
  (route.auth ?? 'none') === 'none' &&
  !route.writes?.length &&
  !route.enqueues?.length &&
  route.body === undefined;

/** What a release needs from the node's plugin-routes gates (design 0.1). */
export function httpGate(http: DeclaredHttp | undefined): ReleaseGate {
  const surfaces: GateSurface[] = [];
  const add = (surface: string, needs: GateSurface['needs']) =>
    surfaces.push({ surface, needs });

  for (const route of http?.routes ?? [])
    add(
      `route \`${route.methods.join(',')} ${route.path}\``,
      isReadOnlyRoute(route) ? 'read-only' : 'read-write',
    );
  for (const claim of http?.wellKnown ?? [])
    add(`well-known \`${claim.name}\``, 'read-only');
  for (const target of http?.writeTargets ?? [])
    add(`write target \`${target.id}\``, 'read-write');
  for (const key of http?.keys ?? []) add(`key \`${key.name}\``, 'read-write');
  for (const token of http?.tokens ?? [])
    add(`token store \`${token.name}\``, 'read-write');
  const deliveries = [
    ...new Set((http?.routes ?? []).flatMap(r => r.enqueues ?? [])),
  ];
  for (const id of deliveries) add(`delivery \`${id}\``, 'read-write');
  for (const listener of http?.listeners ?? [])
    add(`listener \`${listener.name}\``, 'read-write');
  for (const sidecar of http?.sidecars ?? [])
    add(`sidecar \`${sidecar.name}\``, 'read-write');

  const top = Math.max(0, ...surfaces.map(s => rank(s.needs)));

  return {
    needed: top === 0 ? 'none' : (LEVELS[top] as ReleaseGate['needed']),
    listeners: (http?.listeners ?? []).map(l => l.name),
    sidecars: (http?.sidecars ?? []).map(s => s.name),
    surfaces,
  };
}

/** What `derivedRequires` needs from a manifest. */
export interface RequiresInput {
  runtime?: string;
  entrypoints?: { run?: boolean };
  secrets?: unknown[];
  http?: DeclaredHttp;
}

/**
 * The `requires` list derived from a manifest's declarations (design section
 * 1), sorted. Authors never write it, so it can't disagree with the manifest.
 * Expects the canonical form `validateManifest` returns.
 */
export function derivedRequires(manifest: RequiresInput): string[] {
  const { http } = manifest;
  const gate = httpGate(http);
  const requires = new Set<string>();
  // Absent `entrypoints` means `run`, as in version one.
  const runs =
    manifest.runtime === 'wasip2/1' ||
    (manifest.entrypoints === undefined ? true : !!manifest.entrypoints.run);
  const publicSurface = !!(
    http?.routes?.length ||
    http?.wellKnown?.length ||
    http?.writeTargets?.length ||
    http?.keys?.length ||
    http?.tokens?.length
  );

  if (manifest.secrets?.length) requires.add('host-credentials');
  if (runs || publicSurface) requires.add('wasm-sandbox');

  if (publicSurface) {
    requires.add('persistent-host');
    requires.add('public-origin');
  }

  if (gate.needed !== 'none') requires.add(`plugin-routes:${gate.needed}`);
  for (const name of gate.listeners) requires.add(`operator-listener:${name}`);
  for (const name of gate.sidecars) requires.add(`operator-sidecar:${name}`);

  return [...requires].sort();
}

/**
 * Compares a release's needs with a node's gates, as the server does at
 * install, upgrade and release pin. `undefined` when the node allows it.
 */
export function checkHostFeatures(
  http: DeclaredHttp | undefined,
  node: PluginRoutesStatus,
): HostFeatureUnavailable | undefined {
  return checkGate(httpGate(http), node);
}

/**
 * A catalog entry's `requires` when the server couldn't read or verify the
 * release (#1743): not in its cache and not derivable in time. Treat it
 * conservatively: mark the entry, don't hide it, and let the review read the
 * manifest before anything is installed.
 */
export const REQUIRES_UNKNOWN = 'unknown';

/**
 * `requires` as `/plugin-catalog` sends it: the derived list; null for a
 * release without versioned declarations, which needs no gate; or
 * {@link REQUIRES_UNKNOWN}.
 */
export type CatalogRequires =
  | readonly string[]
  | null
  | typeof REQUIRES_UNKNOWN;

/**
 * The gate a catalog entry's derived `requires` names (`plugin-routes:<level>`,
 * `operator-listener:<name>`, `operator-sidecar:<name>`), so a client can
 * compare it with `hostFeatures` without fetching the manifest. It carries no
 * surfaces: `requires` doesn't say which endpoints asked for the level.
 */
export function requiresGate(
  requires: CatalogRequires | undefined,
): ReleaseGate {
  let top = 0;
  const listeners: string[] = [];
  const sidecars: string[] = [];

  // `unknown` says nothing about the gate; callers mark such entries.
  for (const entry of Array.isArray(requires) ? requires : []) {
    const [kind, value] = [
      entry.slice(0, entry.indexOf(':')),
      entry.slice(entry.indexOf(':') + 1),
    ];
    if (kind === 'plugin-routes') top = Math.max(top, rank(value));

    // Only nodes at `read-write` configure listeners and sidecars.
    if (kind === 'operator-listener') {
      listeners.push(value);
      top = Math.max(top, rank('read-write'));
    }

    if (kind === 'operator-sidecar') {
      sidecars.push(value);
      top = Math.max(top, rank('read-write'));
    }
  }

  return {
    needed: top === 0 ? 'none' : (LEVELS[top] as ReleaseGate['needed']),
    listeners,
    sidecars,
    surfaces: [],
  };
}

/**
 * `checkHostFeatures` for a gate already computed, by `httpGate` from a
 * manifest or by `requiresGate` from a catalog entry.
 */
export function checkGate(
  gate: ReleaseGate,
  node: PluginRoutesStatus,
): HostFeatureUnavailable | undefined {
  if (gate.needed === 'none') return undefined;
  const level: PluginRoutesLevel = node.compiled ? node.level : 'off';
  const listeners = gate.listeners.filter(n => !node.listeners.includes(n));
  const sidecars = gate.sidecars.filter(n => !node.sidecars.includes(n));
  let surfaces: string[];

  if (rank(gate.needed) > rank(level)) {
    surfaces = gate.surfaces
      .filter(s => rank(s.needs) > rank(level))
      .map(s => s.surface);
  } else if (listeners.length || sidecars.length) {
    surfaces = [
      ...listeners.map(n => `listener \`${n}\``),
      ...sidecars.map(n => `sidecar \`${n}\``),
    ];
  } else {
    return undefined;
  }

  return {
    type: HOST_FEATURE_UNAVAILABLE,
    feature: 'plugin-routes',
    needed: gate.needed,
    compiled: node.compiled,
    level,
    surfaces,
    listeners,
    sidecars,
  };
}

/** The refusal text of design 0.4; the server sends the same words. */
export function hostFeatureMessage(problem: HostFeatureUnavailable): string {
  const opens = `This plugin opens public endpoints on the server (${problem.surfaces.join(', ')}).`;

  if (!problem.compiled)
    return `${opens} This AtomicServer was built without plugin routes, so the plugin can't be installed here.`;

  if (rank(problem.level) < rank(problem.needed))
    return `${opens} The server operator hasn't enabled them. To allow it, start AtomicServer with \`--plugin-routes ${problem.needed}\` (or \`ATOMIC_PLUGIN_ROUTES=${problem.needed}\`).`;

  const additions: string[] = [];
  if (problem.listeners.length)
    additions.push(
      `${problem.listeners.map(n => `\`${n}:<port>\``).join(', ')} to \`ATOMIC_PLUGIN_LISTENERS\``,
    );
  if (problem.sidecars.length)
    additions.push(
      `${problem.sidecars.map(n => `\`${n}=http://127.0.0.1:<port>\``).join(', ')} to \`ATOMIC_PLUGIN_SIDECARS\``,
    );

  return `${opens} The server operator hasn't configured them. To allow it, add ${additions.join(' and ')}.`;
}

/**
 * The typed problem in a server response body, if that is what it is. The
 * server answers `application/problem+json` with the fields of
 * `HostFeatureUnavailable` plus `status`, `title` and `detail`.
 */
export function parseHostFeatureUnavailable(
  body: unknown,
): HostFeatureUnavailable | undefined {
  if (!body || typeof body !== 'object') return undefined;
  const raw = body as Raw;
  if (raw.type !== HOST_FEATURE_UNAVAILABLE) return undefined;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

  return {
    type: HOST_FEATURE_UNAVAILABLE,
    feature: 'plugin-routes',
    needed: raw.needed === 'read-only' ? 'read-only' : 'read-write',
    compiled: raw.compiled === true,
    level: LEVELS.includes(raw.level as PluginRoutesLevel)
      ? (raw.level as PluginRoutesLevel)
      : 'off',
    surfaces: strings(raw.surfaces),
    listeners: strings(raw.listeners),
    sidecars: strings(raw.sidecars),
  };
}

/**
 * The typed refusal an error carries, as a `HostFeatureUnavailableError`:
 * the error itself when it already is one (`/plugin-release-pin`'s `409`), or
 * one built from a refused commit (an Installation's install, upgrade or
 * resume), whose `AtomicError.problem` holds the same fields. `undefined` for
 * any other error.
 */
export function hostFeatureUnavailableError(
  error: unknown,
): HostFeatureUnavailableError | undefined {
  if (error instanceof HostFeatureUnavailableError) return error;
  if (!(error instanceof AtomicError)) return undefined;
  const problem = parseHostFeatureUnavailable(error.problem);

  return problem ? new HostFeatureUnavailableError(problem) : undefined;
}

/**
 * `hostFeatures.pluginRoutes` from a `/plugin-catalog` response body.
 * `undefined` for a server from before the gates (#1711), which answered a
 * bare array and can't open public endpoints at all.
 */
export function parsePluginRoutesStatus(
  body: unknown,
): PluginRoutesStatus | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    return undefined;
  const features = (body as Raw).hostFeatures as Raw | undefined;
  const raw = features?.pluginRoutes as Raw | undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const strings = (v: unknown) =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];

  return {
    compiled: raw.compiled === true,
    level: LEVELS.includes(raw.level as PluginRoutesLevel)
      ? (raw.level as PluginRoutesLevel)
      : 'off',
    routesOrigin:
      typeof raw.routesOrigin === 'string' ? raw.routesOrigin : null,
    listeners: strings(raw.listeners),
    sidecars: strings(raw.sidecars),
  };
}

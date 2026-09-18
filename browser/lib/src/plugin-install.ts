/**
 * One install path for both plugin runtimes.
 *
 * A Release is an immutable, content-addressed package (JS source or a wasip2
 * zip). Installing it into a drive means committing an `Installation`
 * resource with `installationStatus: active`; the server resolves the pinned
 * release, verifies its id, checks the grants and materializes by runtime.
 * Pausing, revoking or destroying that resource undoes it. See
 * `planning/plugin-runtime-convergence.md`, "One install path and a
 * marketplace".
 */
import { signRequest } from './authentication.js';
import { core } from './ontologies/core.js';
import { server, type Server } from './ontologies/server.js';
import type { Store } from './store.js';
import type { JSONValue } from './value.js';

export const RUNTIME_JS = 'atomic-js/1';
export const RUNTIME_WASIP2 = 'wasip2/1';
export const WORLD_EXTENSION = 'extension';
export const WORLD_SERVER_EXTENSION = 'server-extension';

export type InstallationStatus = 'draft' | 'active' | 'paused' | 'revoked';
export const INSTALLATION_STATUSES: readonly InstallationStatus[] = [
  'draft',
  'active',
  'paused',
  'revoked',
];

/** The release record the server publishes and serves (`lib/src/db/plugin_release.rs`). */
export interface PublishedRelease {
  runtime: string;
  /** Defaults to `extension` when absent. */
  world?: string;
  manifest: JSONValue;
  source?: string;
  /** Blake3 hex of the zip bytes for `wasip2/1`. */
  package?: string;
  schemas?: Record<string, string>;
  version?: string;
  previousRelease?: string;
}

/**
 * Where an Installation finds its Release and what it pins.
 *
 * `url` is what the server resolves: a `Release` resource URL, or a bare
 * release id (`blake3:…`) for releases that only exist in this server's
 * release cache (the catalog and zip-publish paths today). `id` is always the
 * content hash the installer reviewed; the server refuses to install when
 * `url` resolves to anything else.
 */
export interface ReleaseReference {
  url: string;
  id: string;
}

export type CapabilityKind =
  | 'permission'
  | 'secret'
  | 'operation'
  | 'capability'
  | 'network';

/** One line of the install review: what the plugin asks for and why. */
export interface ReviewCapability {
  kind: CapabilityKind;
  title: string;
  reason?: string;
  /**
   * The grant name written to `Installation.grants` when the installer
   * approves. Absent for entries the server does not accept as grants yet
   * (secrets and operations are declared, not granted, until the unified
   * manifest carries them as capabilities).
   */
  grant?: string;
}

export interface InstallationReview {
  name?: string;
  namespace?: string;
  description?: string;
  author?: string;
  version?: string;
  runtime: string;
  world: string;
  releaseId?: string;
  capabilities: ReviewCapability[];
  configSchema?: JSONValue;
  defaultConfig?: JSONValue;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * Turns a release's manifest into what the review screen shows before the
 * installer approves. Understands both manifest forms that exist today and
 * drops anything malformed instead of trusting it.
 */
export function readInstallationReview(
  release: Pick<PublishedRelease, 'manifest'> &
    Partial<PublishedRelease> & { id?: string },
): InstallationReview {
  const manifest = asObject(release.manifest) ?? {};
  const capabilities: ReviewCapability[] = [];

  // plugin.json style (wasip2): `permissions: [{ permission, reason }]`,
  // or bare permission names.
  for (const entry of asArray(manifest.permissions)) {
    const name = asString(entry) ?? asString(asObject(entry)?.permission);
    if (!name) continue;
    capabilities.push({
      kind: 'permission',
      title: name,
      reason: asString(asObject(entry)?.reason),
      grant: name,
    });
  }

  // Versioned JS manifest (`plugin-manifest.ts`): secrets and operations.
  for (const entry of asArray(manifest.secrets)) {
    const secret = asObject(entry);
    const name = asString(secret?.name);
    if (!name) continue;
    const origin = asString(secret?.origin);
    const description = asString(secret?.description);
    capabilities.push({
      kind: 'secret',
      title: `Secret "${name}"`,
      reason: [description, origin && `Sent only to ${origin}`]
        .filter(Boolean)
        .join('. '),
    });
  }

  for (const entry of asArray(manifest.operations)) {
    const operation = asObject(entry);
    const id = asString(operation?.id);
    if (!id) continue;
    const method = asString(operation?.method) ?? 'GET';
    const url = asString(operation?.url) ?? '';
    const effect = asString(operation?.effect);
    capabilities.push({
      kind: 'operation',
      title: `${method} ${url}`.trim(),
      reason: effect ? `${id}: ${effect}s external data` : id,
    });
  }

  // Manifest v2 (`DeclaredCapability` in plugin-manifest.ts): a bare name or
  // `{ name, reason }`. These are what `Installation.grants` records and what
  // the server's `check_grants` accepts.
  for (const entry of asArray(manifest.capabilities)) {
    const object = asObject(entry);
    const name = asString(entry) ?? asString(object?.name);
    if (!name) continue;
    capabilities.push({
      kind: 'capability',
      title: name,
      reason: asString(object?.reason),
      grant: name,
    });
  }

  // Manifest v2 `network`: coarse egress for host `fetch` without an
  // operation id. Declared, not granted.
  const network = asObject(manifest.network);
  const origins = asArray(network?.origins).flatMap(o => asString(o) ?? []);

  if (origins.length > 0) {
    capabilities.push({
      kind: 'network',
      title: `Network access to ${origins.join(', ')}`,
      reason: asString(network?.reason),
    });
  }

  return {
    name: asString(manifest.name),
    namespace: asString(manifest.namespace),
    description: asString(manifest.description),
    author: asString(manifest.author),
    version: release.version ?? asString(manifest.version),
    runtime: release.runtime ?? RUNTIME_JS,
    world: release.world ?? WORLD_EXTENSION,
    releaseId: release.id,
    capabilities,
    configSchema: manifest.configSchema as JSONValue | undefined,
    defaultConfig: manifest.defaultConfig as JSONValue | undefined,
  };
}

/** The grant names an installer approves when accepting the whole review. */
export function grantsFor(review: InstallationReview): string[] {
  return review.capabilities.flatMap(c => (c.grant ? [c.grant] : []));
}

/** Namespace for releases whose manifest declares none (catalog JS releases). */
export const DEFAULT_INSTALLATION_NAMESPACE = 'community';

/**
 * A plugin identifier the server accepts (`validate_plugin_identifier`):
 * ASCII letters, digits, `-` and `_`, at most 128 characters.
 */
export function installationIdentifier(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 128);

  return cleaned || 'plugin';
}

export interface InstallReleaseOptions {
  drive: string;
  release: ReleaseReference;
  /** Plugin identifier on the drive; for wasip2 it must equal the manifest's name. */
  name: string;
  /** For wasip2 it must equal the manifest's namespace. */
  namespace?: string;
  description?: string;
  version?: string;
  config?: JSONValue;
  /** Capability names the installer approved. */
  grants: string[];
  /** Committing `active` (the default) is what installs. */
  status?: InstallationStatus;
}

/**
 * Creates and saves an `Installation` under the drive. The server's commit
 * hook does the actual install; the returned subject is the resource to
 * open, pause, revoke or destroy.
 */
export async function installRelease(
  store: Store,
  options: InstallReleaseOptions,
): Promise<string> {
  const {
    drive,
    release,
    name,
    namespace,
    description,
    version,
    config,
    grants,
    status = 'active',
  } = options;
  const propVals: Record<string, JSONValue> = {
    [core.properties.name]: name,
    [server.properties.releaseId]: release.id,
    [server.properties.installationStatus]: status,
    [server.properties.grants]: grants,
  };
  if (namespace) propVals[server.properties.namespace] = namespace;
  if (description) propVals[core.properties.description] = description;
  if (version) propVals[server.properties.version] = version;
  if (config !== undefined) propVals[server.properties.config] = config;

  const installation = await store.newResource<Server.Installation>({
    isA: server.classes.installation,
    parent: drive,
    propVals,
  });
  // `release` is an atomicURL, but a release published to this server's
  // cache has no Release resource yet, only an id. The server resolves
  // either, so skip the client-side URL check for it.
  await installation.set(server.properties.release, release.url, false);
  await installation.save();

  return installation.subject;
}

export type InstallStore = Pick<Store, 'getAgent' | 'getServerUrl'>;

/**
 * Publishes a wasip2 zip as a private release on the store's server and
 * returns its id with the record the server built, so the caller can review
 * and install it without a second request.
 */
export async function publishZipRelease(
  store: InstallStore,
  drive: string,
  file: Blob,
  options: { world?: string; public?: boolean } = {},
  transport: typeof fetch = fetch,
): Promise<{ id: string; release: PublishedRelease }> {
  const agent = store.getAgent();
  if (!agent) throw new Error('sign in before publishing a plugin release');
  const url = new URL('/plugin-release-package', store.getServerUrl());
  url.searchParams.set('drive', drive);
  if (options.world) url.searchParams.set('world', options.world);
  if (options.public) url.searchParams.set('public', 'true');
  const response = await transport(url.toString(), {
    method: 'POST',
    headers: {
      ...(await signRequest(url.toString(), agent, {})),
      'Content-Type': 'application/zip',
    },
    body: await file.arrayBuffer(),
  });
  if (!response.ok) throw new Error(await response.text());

  return response.json() as Promise<{ id: string; release: PublishedRelease }>;
}

import { core } from './ontologies/core.js';
import { dataBrowser } from './ontologies/dataBrowser.js';
import { Datatype } from './datatypes.js';
import {
  createApp,
  describeApp,
  updateApp,
  type AppDescription,
  type CreatedApp,
} from './plugin-app.js';
import {
  ensureSchema,
  findSchema,
  type SchemaSpec,
  type SchemaStore,
} from './plugin-schema.js';

/**
 * Drive apps published in a plugin catalog (ontola/atomic-plugins
 * `integrations/catalog.json`), installed as ordinary apps.
 *
 * A catalog entry names one built, immutable ES module for exactly one
 * version, and the Subresource Integrity hash of its bytes. Installing fetches
 * those bytes, refuses them unless the hash matches, and hands them to
 * `createApp` as the entry point's source — the same app, ontology, table and
 * identity the New menu makes. The app then records where it came from, so the
 * catalog can say which version is installed and offer the next one.
 *
 * Updating is `updateApp`: only the entry point's source changes, so the app's
 * rows, schema, identity and rights survive it.
 */

const CATALOG = 'https://atomicdata.dev/integrations/properties/';

/** The catalog's own vocabulary for an app entry. */
export const catalogAppProperties = {
  shortname: core.properties.shortname,
  name: core.properties.name,
  description: core.properties.description,
  emoji: dataBrowser.properties.emoji,
  version: `${CATALOG}version`,
  module: `${CATALOG}app-module`,
  integrity: `${CATALOG}app-module-integrity`,
  rowName: `${CATALOG}app-row-name`,
  rowNamePlural: `${CATALOG}app-row-name-plural`,
} as const;

/** One installable app, as a catalog entry describes it. */
export interface CatalogApp {
  /** The entry's shortname: stable across versions. */
  id: string;
  name: string;
  emoji?: string;
  description?: string;
  version: string;
  /** Absolute URL of the module for exactly `version`. */
  module: string;
  /** `sha256-`, `sha384-` or `sha512-` followed by base64, as in SRI. */
  integrity: string;
  rowName?: { singular: string; plural: string };
}

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim().length > 0 ? value : undefined;

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Where a module may be fetched from: HTTPS, or HTTP on this machine for
 * development. A relative URL is resolved against the catalog it came from.
 */
export function resolveModuleUrl(value: string, catalogUrl: string): string {
  const url = new URL(value, catalogUrl);

  if (
    url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && LOOPBACK.has(url.hostname))
  ) {
    throw new Error(`An app module must be served over HTTPS: ${url.href}`);
  }

  if (url.username || url.password) {
    throw new Error('An app module URL cannot carry credentials');
  }

  return url.href;
}

const INTEGRITY = /^(sha256|sha384|sha512)-[A-Za-z0-9+/]+={0,2}$/;

/**
 * Reads an app out of a catalog entry, or `undefined` for an entry that is not
 * an installable app. Malformed app fields are skipped the same way, so one bad
 * row cannot hide the rest of the catalog.
 */
export function parseCatalogApp(
  entry: unknown,
  catalogUrl: string,
): CatalogApp | undefined {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return undefined;
  }

  const values = entry as Record<string, unknown>;
  const p = catalogAppProperties;
  const id = asString(values[p.shortname]);
  const name = asString(values[p.name]);
  const version = asString(values[p.version]);
  const module = asString(values[p.module]);
  const integrity = asString(values[p.integrity]);

  if (!id || !name || !version || !module || !integrity) return undefined;
  if (!INTEGRITY.test(integrity)) return undefined;

  let resolved: string;

  try {
    resolved = resolveModuleUrl(module, catalogUrl);
  } catch {
    return undefined;
  }

  const singular = asString(values[p.rowName]);
  const plural = asString(values[p.rowNamePlural]);

  return {
    id,
    name,
    version,
    module: resolved,
    integrity,
    emoji: asString(values[p.emoji]),
    description: asString(values[p.description]),
    rowName: singular && plural ? { singular, plural } : undefined,
  };
}

const ALGORITHMS = {
  sha256: 'SHA-256',
  sha384: 'SHA-384',
  sha512: 'SHA-512',
} as const;

function base64(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) binary += String.fromCharCode(byte);

  return btoa(binary);
}

/** The SRI string (`sha384-…`) for `text`'s UTF-8 bytes. */
export async function subresourceIntegrity(
  text: string,
  algorithm: keyof typeof ALGORITHMS = 'sha384',
): Promise<string> {
  const digest = await crypto.subtle.digest(
    ALGORITHMS[algorithm],
    new TextEncoder().encode(text),
  );

  return `${algorithm}-${base64(new Uint8Array(digest))}`;
}

/** Four megabytes: the same ceiling an app package gets. */
const MAX_MODULE_BYTES = 4 * 1024 * 1024;

/**
 * Fetches an app's module and returns its text, or throws unless its bytes
 * match the integrity the catalog pinned.
 *
 * Nothing is evaluated here: the text is only ever stored, and runs later in
 * the app's own null-origin frame.
 */
export async function fetchCatalogAppModule(
  app: Pick<CatalogApp, 'module' | 'integrity' | 'name' | 'version'>,
  transport: typeof fetch = fetch,
): Promise<string> {
  const response = await transport(app.module, { credentials: 'omit' });

  if (!response.ok) {
    throw new Error(
      `${app.name} ${app.version} could not be downloaded (${response.status}) from ${app.module}`,
    );
  }

  const text = await response.text();

  if (new TextEncoder().encode(text).length > MAX_MODULE_BYTES) {
    throw new Error(`${app.name} ${app.version} is larger than 4 MiB`);
  }

  const algorithm = app.integrity.split('-')[0] as keyof typeof ALGORITHMS;

  if (!(algorithm in ALGORITHMS)) {
    throw new Error(`Unsupported integrity algorithm: ${algorithm}`);
  }

  const actual = await subresourceIntegrity(text, algorithm);

  if (actual !== app.integrity) {
    throw new Error(
      `${app.name} ${app.version} does not match the catalog: expected ${app.integrity}, got ${actual}. Nothing was installed.`,
    );
  }

  return text;
}

/**
 * Where an installed app says it came from. Drive-local, like the rest of the
 * app vocabulary (`pluginSchema`), so it needs no change to the core ontology.
 */
export function catalogAppSchema(): SchemaSpec {
  return {
    properties: [
      {
        shortname: 'app-catalog-id',
        name: 'Catalog entry',
        description:
          'The catalog entry (its shortname) this app was installed from. Apps made by hand have none.',
        datatype: Datatype.STRING,
      },
      {
        shortname: 'app-version',
        name: 'Installed version',
        description:
          "The catalog version whose module is this app's entry point. Compared against the catalog to offer an update.",
        datatype: Datatype.STRING,
      },
      {
        shortname: 'app-module',
        name: 'Module URL',
        description: 'Where the installed module was downloaded from.',
        datatype: Datatype.STRING,
      },
      {
        shortname: 'app-module-integrity',
        name: 'Module integrity',
        description:
          'The Subresource Integrity hash the installed module was checked against.',
        datatype: Datatype.STRING,
      },
    ],
    classes: [],
  };
}

async function recordProvenance(
  store: SchemaStore,
  drive: string,
  subject: string,
  app: CatalogApp,
): Promise<void> {
  const schema = await ensureSchema(store, drive, catalogAppSchema());
  const resource = await store.getResource(subject);
  await resource.set(schema.properties['app-catalog-id'], app.id);
  await resource.set(schema.properties['app-version'], app.version);
  await resource.set(schema.properties['app-module'], app.module);
  await resource.set(schema.properties['app-module-integrity'], app.integrity);
  await resource.save();
}

/**
 * Installs a catalog app into `drive`: downloads and verifies its module, then
 * creates the app, its ontology, row class, table, entry point and identity
 * through `createApp`. The returned secret is the app agent's, as from
 * `createApp`; the caller decides where it goes (the data-browser hands it to
 * the node).
 */
export async function installCatalogApp(
  store: SchemaStore,
  options: { drive: string; app: CatalogApp; transport?: typeof fetch },
): Promise<CreatedApp> {
  const { drive, app } = options;
  const source = await fetchCatalogAppModule(app, options.transport);
  const created = await createApp(store, {
    drive,
    name: app.name,
    emoji: app.emoji,
    description: app.description,
    rowName: app.rowName,
    source,
  });
  await recordProvenance(store, drive, created.app, app);

  return created;
}

/**
 * Moves an installed app to the catalog's version. Only the entry point's
 * source and the provenance change; rows, schema, identity and rights stay.
 */
export async function updateCatalogApp(
  store: SchemaStore,
  options: {
    drive: string;
    subject: string;
    app: CatalogApp;
    transport?: typeof fetch;
  },
): Promise<AppDescription> {
  const { drive, subject, app } = options;
  const source = await fetchCatalogAppModule(app, options.transport);
  await updateApp(store, drive, { app: subject, source });
  await recordProvenance(store, drive, subject, app);

  return describeApp(store, drive, subject);
}

/** An app on the drive that came from a catalog. */
export interface InstalledCatalogApp {
  subject: string;
  id: string;
  version?: string;
}

/**
 * The catalog apps installed on `drive`, found by their `app-catalog-id`.
 * `list` lists every resource on the drive carrying a property (the host's
 * `/query`, e.g. `readConnectionSubjects`). Read-only: a drive that never
 * installed one has no such property and yields nothing.
 */
export async function readInstalledCatalogApps(
  store: SchemaStore,
  drive: string,
  list: (property: string) => Promise<string[]>,
): Promise<InstalledCatalogApp[]> {
  const schema = await findSchema(store, drive, catalogAppSchema());
  const idProp = schema.properties?.['app-catalog-id'];
  const versionProp = schema.properties?.['app-version'];

  if (!idProp) return [];

  const found: InstalledCatalogApp[] = [];

  for (const subject of await list(idProp)) {
    const resource = await store.getResource(subject);
    const id = asString(resource.get(idProp));
    if (!id) continue;
    found.push({
      subject,
      id,
      version: versionProp ? asString(resource.get(versionProp)) : undefined,
    });
  }

  return found;
}

/**
 * Compares dotted numeric versions (`0.10.0` > `0.9.1`). A pre-release suffix
 * (`-beta.1`) sorts before its release. Anything unparseable compares by string.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core_, pre] = v.split('-', 2);

    return { parts: core_.split('.').map(Number), pre };
  };

  const x = parse(a);
  const y = parse(b);

  if ([...x.parts, ...y.parts].some(n => !Number.isInteger(n))) {
    return a.localeCompare(b);
  }

  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const d = (x.parts[i] ?? 0) - (y.parts[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }

  if (x.pre === y.pre) return 0;
  if (x.pre === undefined) return 1;
  if (y.pre === undefined) return -1;

  return x.pre.localeCompare(y.pre);
}

/**
 * What the catalog should offer for `app` given what is installed: install it,
 * nothing (current, or newer than the catalog — never a downgrade), or an
 * update to the catalog's version.
 */
export function catalogAppState(
  app: Pick<CatalogApp, 'version'>,
  installed: Pick<InstalledCatalogApp, 'version'> | undefined,
): 'install' | 'current' | 'update' | 'ahead' {
  if (!installed) return 'install';
  if (!installed.version) return 'update';
  const order = compareVersions(app.version, installed.version);

  return order > 0 ? 'update' : order < 0 ? 'ahead' : 'current';
}

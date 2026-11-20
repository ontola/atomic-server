/**
 * Provision the provider connection manager reached through Apps. Principal
 * resources are promoted separately into the drive's user-facing Apps.
 * Installing metadata never silently authorizes an external service.
 */
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  AtomicError,
  core,
  dataBrowser,
  Datatype,
  ensureSchema,
  ErrorType,
  findSchema,
  pluginSchema,
  subjectsReferToSameResource,
  isAtomicIdentifier,
  readConnectionSubjects,
  server,
  type Store,
  type PropertySpec,
  type SchemaSpec,
  type SchemaStore,
} from '@tomic/lib';

type SchemaResource = Awaited<ReturnType<SchemaStore['getResource']>>;

export const syncableNameProperty: PropertySpec = {
  subject: core.properties.name,
  shortname: 'name',
  name: 'Name',
  description: 'The name of a thing or person.',
  datatype: Datatype.STRING,
};

/** Stored on the installation, so its identity survives renaming and moving. */
export const syncablePlatformSchema = (): SchemaSpec => ({
  properties: [
    syncableNameProperty,
    {
      shortname: 'builtin-app',
      name: 'Built-in app',
      description: 'A registered app delivered by this Atomic Server release.',
      datatype: Datatype.STRING,
    },
    {
      shortname: 'syncable-legacy-accounts',
      name: 'Legacy Accounts container',
      description:
        'Installation-owned compatibility data retained after moving source roots directly under the App.',
      datatype: Datatype.ATOMIC_URL,
    },
    {
      shortname: 'syncable-api-document',
      name: 'Integration API description',
      description:
        'Public composed OpenAPI metadata saved from the configured integration catalog.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-api-selection',
      name: 'Integration API selection',
      description:
        'Public catalog consumer selections for the saved API description.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-platform-setup',
      name: 'Integration connection manager',
      description:
        'A native provider setup resource accessed from Apps rather than the drive tree.',
      datatype: Datatype.BOOLEAN,
    },
    {
      shortname: 'syncable-principal-app-index',
      name: 'Principal App index',
      description:
        'Native lookup hint for validated principal Apps; registrations remain authoritative.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-principal-app-key',
      name: 'Principal App registration key',
      description:
        'Native-only typed principal installation identity; independent of physical location.',
      datatype: Datatype.STRING,
    },
    {
      shortname: 'syncable-principal-app-ready',
      name: 'Principal App registration complete',
      description:
        'Native recovery marker written after promotion reaches its drive destination.',
      datatype: Datatype.BOOLEAN,
    },
    {
      shortname: 'syncable-principal-app-target',
      name: 'Registered principal App',
      description:
        'Native-only registration target retained across same-drive moves.',
      datatype: Datatype.ATOMIC_URL,
    },
    {
      shortname: 'syncable-platform-index',
      name: 'Connected platform tables',
      description:
        'Drive-owned lookup of platform identity to Atomic table, independent of parent path.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-platform-id',
      name: 'Syncable platform ID',
      description:
        'Platform identifier in the selected integration proxy catalog.',
      datatype: Datatype.STRING,
    },
    {
      shortname: 'syncable-proxy-origin',
      name: 'Integration proxy origin',
      description: 'The HTTPS origin of the proxy describing this platform.',
      datatype: Datatype.STRING,
    },
  ],
  classes: [
    {
      shortname: 'syncable-principal-app-registration',
      name: 'Principal App registration',
      description:
        'Native uniqueness registration outside any integration iframe write root.',
      recommends: [
        'syncable-principal-app-key',
        'syncable-principal-app-target',
      ],
    },
    {
      shortname: 'syncable-account',
      name: 'Syncable account',
      description:
        'A connected account through which remote collection instances can be discovered.',
      recommends: ['name'],
    },
  ],
});

/**
 * Stable *installation* identity, independent of the display name.
 *
 * The drive is part of the lookup scope, not the key, and one provider from
 * two separately configured proxies must not silently share credentials.
 */
export function platformLocalId(proxyOrigin: string, platform: string): string {
  const origin = new URL(proxyOrigin);
  if (origin.origin !== proxyOrigin)
    throw new Error('The integration proxy must be an origin');
  if (!/^[a-z0-9-]{1,80}$/.test(platform))
    throw new Error('Invalid integration platform ID');

  return `syncables:platform:${encodeURIComponent(proxyOrigin)}:${platform}`;
}

export interface PlatformProvisioner extends SchemaStore {
  getServerUrl?: Store['getServerUrl'];
  fetchResourceFromServer?: Store['fetchResourceFromServer'];
}

const DRIVE_PROPERTY = 'https://atomicdata.dev/properties/drive';
const provisioning = new WeakMap<SchemaStore, Map<string, Promise<unknown>>>();

/** A host store serializes updates to its drive-owned indexes and schemas. */
export async function queueSyncableProvisioning<T>(
  store: SchemaStore,
  drive: string,
  provision: () => Promise<T>,
): Promise<T> {
  let writes = provisioning.get(store);

  if (!writes) {
    writes = new Map();
    provisioning.set(store, writes);
  }

  const previous = writes.get(drive);
  const pending = previous ? previous.then(provision, provision) : provision();
  writes.set(drive, pending);

  try {
    return await pending;
  } finally {
    if (writes.get(drive) === pending) writes.delete(drive);
  }
}

/** Reject external navigation/index subjects before the store can fetch them. */
export function assertSyncableLocalSubject(
  store: SchemaStore,
  subject: unknown,
): asserts subject is string {
  if (typeof subject !== 'string' || !subject || subject.includes('#'))
    throw new Error('The integration resource belongs to another server');
  if (isAtomicIdentifier(subject)) return;
  const getServerUrl = (store as PlatformProvisioner).getServerUrl;

  if (!getServerUrl) {
    // Embedded SchemaStores have opaque local keys and no HTTP transport.
    if (subject.includes('://') || subject.startsWith('//'))
      throw new Error('The integration resource belongs to another server');

    return;
  }

  let url: URL;

  try {
    url = new URL(subject);
  } catch {
    throw new Error('Invalid integration resource subject');
  }

  if (
    url.origin !== new URL(getServerUrl.call(store)).origin ||
    url.username ||
    url.password ||
    url.hash
  )
    throw new Error('The integration resource belongs to another server');
}

export async function loadSyncableResource(
  store: SchemaStore,
  subject: string,
  required = false,
): Promise<SchemaResource | undefined> {
  try {
    assertSyncableLocalSubject(store, subject);
    const resource = await store.getResource(subject);
    assertSyncableLocalSubject(store, resource.subject);
    if ('error' in resource && resource.error) throw resource.error;

    return resource;
  } catch (error) {
    if (
      !required &&
      error instanceof AtomicError &&
      (error.type === ErrorType.NotFound ||
        error.type === ErrorType.Unauthorized)
    ) {
      return undefined;
    }

    throw error;
  }
}

/** Verify ancestry too: moving an ancestor may leave an old drive stamp. */
export function isSyncableResourceInDrive(
  store: SchemaStore,
  drive: string,
  subject: string,
): Promise<boolean> {
  return resourceDriveMembership(store, drive, subject, false);
}

/** Strict query filtering may omit only a resource proven to belong to another
 * Drive. Missing or inconsistent ancestry is an error, never an empty result. */
export function classifySyncableResourceDrive(
  store: SchemaStore,
  drive: string,
  subject: string,
): Promise<boolean> {
  assertSyncableLocalSubject(store, drive);

  return resourceDriveMembership(store, drive, subject, true);
}

// @wc-ignore
async function resourceDriveMembership(
  store: SchemaStore,
  drive: string,
  subject: string,
  strict: boolean,
): Promise<boolean> {
  const seen = new Set<string>();
  const stamps: string[] = [];
  let current = subject;

  const verifyStamps = (root: string) => {
    if (stamps.some(stamp => !subjectsReferToSameResource(stamp, root)))
      throw new Error('The resource Drive stamp conflicts with its ancestry');
  };

  while (!seen.has(current) && seen.size < 64) {
    if (subjectsReferToSameResource(drive, current)) {
      if (strict) verifyStamps(drive);

      return true;
    }

    seen.add(current);
    const resource = await loadSyncableResource(store, current, strict);
    if (!resource) return false;
    const assignedDrive = resource.get(DRIVE_PROPERTY);

    if (strict) {
      if (assignedDrive !== undefined) {
        assertSyncableLocalSubject(store, assignedDrive);
        stamps.push(assignedDrive);
      }

      const classes = resource.get(core.properties.isA);
      if (
        classes !== undefined &&
        (!Array.isArray(classes) ||
          classes.some(type => typeof type !== 'string'))
      )
        throw new Error('The resource has malformed Drive ancestry');

      if (Array.isArray(classes) && classes.includes(server.classes.drive)) {
        verifyStamps(resource.subject);

        return false;
      }
    } else if (
      assignedDrive !== undefined &&
      (typeof assignedDrive !== 'string' ||
        !subjectsReferToSameResource(drive, assignedDrive))
    ) {
      return false;
    }

    const parent = resource.get(core.properties.parent);

    if (typeof parent !== 'string' || !parent) {
      if (strict)
        throw new Error('The resource Drive ancestry could not be proven');

      return false;
    }

    current = parent;
  }

  if (strict)
    throw new Error('The resource Drive ancestry is cyclic or too deep');

  return false;
}

/** Read-only lookup, including an installed App moved elsewhere in the drive. */
export async function findSyncablePlatform(
  store: PlatformProvisioner,
  input: { drive: string; proxyOrigin: string; platform: string },
): Promise<string | undefined> {
  const { drive, proxyOrigin, platform } = input;
  assertSyncableLocalSubject(store, drive);
  const localId = platformLocalId(proxyOrigin, platform);
  const schema = await findSchema(store, drive, syncablePlatformSchema());
  const indexProperty = schema.properties?.['syncable-platform-index'];
  const platformProperty = schema.properties?.['syncable-platform-id'];
  const proxyProperty = schema.properties?.['syncable-proxy-origin'];
  if (!platformProperty || !proxyProperty) return undefined;

  const app = await findSchema(store, drive, pluginSchema());
  const hierarchy = await findSchema(store, drive, syncableHierarchySchema());
  const principalKind = hierarchy.properties?.['syncable-node-kind'];
  const builtinProperty = schema.properties?.['builtin-app'];

  const isMatchingInstallation = (target: SchemaResource) => {
    const classes = target.get(core.properties.isA);

    return (
      (!principalKind || target.get(principalKind) !== 'principal') &&
      Array.isArray(classes) &&
      (classes.includes(dataBrowser.classes.table) ||
        (app.classes?.app &&
          classes.includes(app.classes.app) &&
          builtinProperty &&
          target.get(builtinProperty) === 'syncables')) &&
      target.get(platformProperty) === platform &&
      target.get(proxyProperty) === proxyOrigin
    );
  };

  if (indexProperty) {
    const root = await store.getResource(drive);
    const map = root.get(indexProperty);

    if (map && typeof map === 'object' && !Array.isArray(map)) {
      const subject = (map as Record<string, unknown>)[localId];

      if (typeof subject === 'string') {
        const target = await loadSyncableResource(store, subject);

        if (
          target &&
          isMatchingInstallation(target) &&
          (await isSyncableResourceInDrive(store, drive, target.subject))
        ) {
          return target.subject;
        }
      }
    }
  }

  // The index is a hint. A complete drive query also finds a moved setup when
  // a concurrent index update or an interrupted installation lost that hint.
  if (store.getServerUrl && store.fetchResourceFromServer) {
    const candidates = await readConnectionSubjects(
      store as Pick<Store, 'getServerUrl' | 'fetchResourceFromServer'>,
      drive,
      core.properties.localId,
      localId,
    );
    const matching: string[] = [];

    for (const subject of candidates) {
      const target = await loadSyncableResource(store, subject);
      if (
        target &&
        isMatchingInstallation(target) &&
        (await isSyncableResourceInDrive(store, drive, target.subject))
      )
        matching.push(target.subject);
    }

    if (matching.length > 1)
      throw new Error(
        'This integration has conflicting connection managers; review the existing copies',
      );

    return matching[0];
  }

  // Compatibility with tables provisioned before the drive index existed.
  const original = await store.findByLocalId(drive, drive, localId);

  if (
    original &&
    isMatchingInstallation(original) &&
    (await isSyncableResourceInDrive(store, drive, original.subject))
  ) {
    return original.subject;
  }
}

async function indexSyncablePlatform(
  store: PlatformProvisioner,
  drive: string,
  property: string,
  localId: string,
  subject: string,
): Promise<void> {
  const root = await store.getResource(drive);
  const current = root.get(property);
  const map: Record<string, string> = {};

  if (current && typeof current === 'object' && !Array.isArray(current)) {
    for (const [key, value] of Object.entries(current)) {
      if (typeof value === 'string') map[key] = value;
    }
  }

  if (map[localId] === subject) return;
  await root.set(property, { ...map, [localId]: subject });
  await root.save();
}

/** Return the same installed App after reinstalling, renaming or moving it. */
export function ensureSyncablePlatform(
  store: PlatformProvisioner,
  input: PlatformInstall,
): Promise<string> {
  return queueSyncableProvisioning(store, input.drive, () =>
    provisionPlatform(store, input),
  );
}

interface PlatformInstall {
  drive: string;
  proxyOrigin: string;
  platform: string;
  name: string;
}

const ACCOUNTS_LOCAL_ID = 'syncables:accounts';

type ParentResource = SchemaResource & {
  getChildrenCollection?: () => Promise<{ getAllMembers(): Promise<string[]> }>;
};

function classesOf(resource: SchemaResource): string[] {
  const value = resource.get(core.properties.isA);

  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

async function validLegacyAccounts(
  store: PlatformProvisioner,
  drive: string,
  root: SchemaResource,
  accounts: SchemaResource,
  platformProperty: string,
  proxyProperty: string,
): Promise<boolean> {
  const parent = accounts.get(core.properties.parent);

  return (
    typeof parent === 'string' &&
    subjectsReferToSameResource(parent, root.subject) &&
    accounts.get(core.properties.localId) === ACCOUNTS_LOCAL_ID &&
    classesOf(accounts).includes(dataBrowser.classes.table) &&
    accounts.get(platformProperty) === root.get(platformProperty) &&
    accounts.get(proxyProperty) === root.get(proxyProperty) &&
    (await isSyncableResourceInDrive(store, drive, accounts.subject))
  );
}

/** Read-only, validated compatibility reference; a local ID alone hides nothing. */
export async function findSyncableLegacyAccounts(
  store: PlatformProvisioner,
  drive: string,
  subject: string,
): Promise<string | undefined> {
  const terms = await findSchema(store, drive, syncablePlatformSchema());
  const app = await findSchema(store, drive, pluginSchema());
  const marker = terms.properties?.['builtin-app'];
  const platform = terms.properties?.['syncable-platform-id'];
  const proxy = terms.properties?.['syncable-proxy-origin'];
  const data = app.properties?.['app-data'];
  if (!marker || !platform || !proxy || !data || !app.classes?.app)
    return undefined;
  const root = await loadSyncableResource(store, subject);
  if (
    !root ||
    root.get(marker) !== 'syncables' ||
    !classesOf(root).includes(app.classes.app) ||
    typeof root.get(platform) !== 'string' ||
    typeof root.get(proxy) !== 'string' ||
    !(await isSyncableResourceInDrive(store, drive, subject))
  )
    return undefined;

  try {
    platformLocalId(root.get(proxy) as string, root.get(platform) as string);
  } catch {
    return undefined;
  }

  const pointer = terms.properties?.['syncable-legacy-accounts'];
  const saved = pointer && root.get(pointer);
  const binding = root.get(data);
  if (binding !== undefined && typeof binding !== 'string') return undefined;
  const legacyBinding =
    typeof binding === 'string' &&
    !subjectsReferToSameResource(binding, subject)
      ? binding
      : undefined;
  if (
    saved !== undefined &&
    (typeof saved !== 'string' ||
      (legacyBinding && !subjectsReferToSameResource(saved, legacyBinding)))
  )
    return undefined;
  const target = typeof saved === 'string' ? saved : legacyBinding;
  if (!target) return undefined;
  const accounts = await loadSyncableResource(store, target);

  return accounts &&
    (await validLegacyAccounts(store, drive, root, accounts, platform, proxy))
    ? accounts.subject
    : undefined;
}

/** Explicit installation/Open migration only; source and descendant identities stay put. */
async function migratePlatformRows(
  store: PlatformProvisioner,
  drive: string,
  root: SchemaResource,
  accounts: ParentResource,
  accountClass: string,
  platform: string,
  proxyOrigin: string,
) {
  if (!accounts.getChildrenCollection)
    throw new Error('Cannot enumerate this installation for migration');
  const hierarchy = await findSchema(store, drive, syncableHierarchySchema());
  const kindProperty = hierarchy.properties?.['syncable-node-kind'];
  const sourceProperty = hierarchy.properties?.['syncable-source-key'];
  if (!kindProperty || !sourceProperty) return;
  const collection = await accounts.getChildrenCollection();
  const children = await collection.getAllMembers();

  for (const subject of new Set(children)) {
    const child = await store.getResource(subject);
    const parent = child.get(core.properties.parent);
    if (
      typeof parent !== 'string' ||
      !subjectsReferToSameResource(parent, accounts.subject) ||
      !(await isSyncableResourceInDrive(store, drive, subject))
    )
      continue;
    const kind = child.get(kindProperty);
    const classes = classesOf(child);
    if (
      !(
        (kind === 'account' || kind === 'principal') &&
        classes.includes(accountClass)
      ) &&
      !(kind === 'public' && classes.includes(dataBrowser.classes.table))
    )
      continue;
    const source = child.get(sourceProperty);
    let key: unknown;

    try {
      key = typeof source === 'string' ? JSON.parse(source) : undefined;
    } catch {
      continue;
    }

    if (
      !Array.isArray(key) ||
      ![5, 6].includes(key.length) ||
      !key.every(value => typeof value === 'string') ||
      key[0] !== proxyOrigin ||
      key[1] !== platform ||
      key[2] !== kind ||
      !key[3] ||
      child.get(core.properties.localId) !==
        'syncables:node:' + encodeURIComponent(source as string)
    )
      continue;
    await child.set(core.properties.parent, root.subject);
    await child.save();
  }
}

async function provisionPlatform(
  store: PlatformProvisioner,
  input: PlatformInstall,
): Promise<string> {
  const { drive, proxyOrigin, platform, name } = input;
  const localId = platformLocalId(proxyOrigin, platform);
  const existing = await findSyncablePlatform(store, input);
  const schema = await ensureSchema(store, drive, syncablePlatformSchema());
  const app = await ensureSchema(store, drive, pluginSchema());
  let subject = existing;

  if (!subject) {
    const root = await store.newResource({
      parent: drive,
      isA: [app.classes.app],
      propVals: {
        [core.properties.name]: name,
        [core.properties.localId]: localId,
        [schema.properties['builtin-app']]: 'syncables',
        [schema.properties['syncable-platform-id']]: platform,
        [schema.properties['syncable-proxy-origin']]: proxyOrigin,
      },
    });

    try {
      await root.save();
      subject = root.subject;
    } catch (error) {
      subject = await findSyncablePlatform(store, input);
      if (!subject) throw error;
    }
  }

  const root = await store.getResource(subject);
  const data = root.get(app.properties['app-data']);
  const savedLegacy = root.get(schema.properties['syncable-legacy-accounts']);
  const legacyBinding =
    typeof data === 'string' && !subjectsReferToSameResource(data, subject)
      ? data
      : undefined;
  if (
    (data !== undefined && typeof data !== 'string') ||
    (savedLegacy !== undefined && typeof savedLegacy !== 'string') ||
    (typeof savedLegacy === 'string' &&
      legacyBinding &&
      !subjectsReferToSameResource(savedLegacy, legacyBinding))
  )
    throw new Error('The installed App has conflicting Accounts references');
  const legacySubject =
    typeof savedLegacy === 'string' ? savedLegacy : legacyBinding;
  const accounts = legacySubject
    ? await loadSyncableResource(store, legacySubject)
    : data === undefined
      ? await store.findByLocalId(drive, subject, ACCOUNTS_LOCAL_ID)
      : undefined;
  if (
    (legacySubject && !accounts) ||
    (accounts &&
      !(await validLegacyAccounts(
        store,
        drive,
        root,
        accounts,
        schema.properties['syncable-platform-id'],
        schema.properties['syncable-proxy-origin'],
      )))
  )
    throw new Error('The installed App has no matching legacy Accounts table');

  if (accounts) {
    // Persist recovery information before the first parent update. Never delete
    // the old table or rewrite its view definitions and user data.
    if (savedLegacy !== accounts.subject) {
      await root.set(
        schema.properties['syncable-legacy-accounts'],
        accounts.subject,
      );
      await root.save();
    }

    await migratePlatformRows(
      store,
      drive,
      root,
      accounts as ParentResource,
      schema.classes['syncable-account'],
      platform,
      proxyOrigin,
    );
  }

  await root.set(schema.properties['syncable-platform-setup'], true);
  await root.set(app.properties['app-data'], subject);
  await root.set(schema.properties['builtin-app'], 'syncables');
  await root.set(core.properties.isA, [
    ...classesOf(root).filter(kind => kind !== dataBrowser.classes.table),
    ...(!classesOf(root).includes(app.classes.app) ? [app.classes.app] : []),
  ]);
  await root.save();
  await indexSyncablePlatform(
    store,
    drive,
    schema.properties['syncable-platform-index'],
    localId,
    subject,
  );

  return subject;
}

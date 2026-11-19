/**
 * A provider installation is an ordinary drive App with an Accounts table.
 *
 * This is the first provisioning slice of planning/builtin-syncables-apps.md.
 * Source connections and sandboxed view mounting are deliberately separate:
 * installing an app must never silently authorize an external service.
 */
import { ensureSyncablesTableViews } from './syncablesViews';
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

export interface PlatformProvisioner extends SchemaStore {}

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

export async function loadSyncableResource(
  store: SchemaStore,
  subject: string,
): Promise<SchemaResource | undefined> {
  try {
    const resource = await store.getResource(subject);
    if ('error' in resource && resource.error) throw resource.error;

    return resource;
  } catch (error) {
    if (
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
export async function isSyncableResourceInDrive(
  store: SchemaStore,
  drive: string,
  subject: string,
): Promise<boolean> {
  const seen = new Set<string>();
  let current = subject;

  while (!seen.has(current) && seen.size < 64) {
    if (subjectsReferToSameResource(drive, current)) return true;
    seen.add(current);
    const resource = await loadSyncableResource(store, current);
    if (!resource) return false;
    const assignedDrive = resource.get(DRIVE_PROPERTY);
    if (
      assignedDrive !== undefined &&
      (typeof assignedDrive !== 'string' ||
        !subjectsReferToSameResource(drive, assignedDrive))
    )
      return false;
    const parent = resource.get(core.properties.parent);
    if (typeof parent !== 'string' || !parent) return false;
    current = parent;
  }

  return false;
}

/** Read-only lookup, including an installed App moved elsewhere in the drive. */
export async function findSyncablePlatform(
  store: PlatformProvisioner,
  input: { drive: string; proxyOrigin: string; platform: string },
): Promise<string | undefined> {
  const { drive, proxyOrigin, platform } = input;
  const localId = platformLocalId(proxyOrigin, platform);
  const schema = await findSchema(store, drive, syncablePlatformSchema());
  const indexProperty = schema.properties?.['syncable-platform-index'];
  const platformProperty = schema.properties?.['syncable-platform-id'];
  const proxyProperty = schema.properties?.['syncable-proxy-origin'];
  if (!platformProperty || !proxyProperty) return undefined;

  const app = await findSchema(store, drive, pluginSchema());
  const builtinProperty = schema.properties?.['builtin-app'];

  const isMatchingInstallation = (target: SchemaResource) => {
    const classes = target.get(core.properties.isA);

    return (
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
  remove?: (property: string) => void;
};

function classesOf(resource: SchemaResource): string[] {
  const value = resource.get(core.properties.isA);

  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Migrate only installation-owned direct rows; every source identity stays put. */
async function migratePlatformRows(
  store: PlatformProvisioner,
  drive: string,
  root: ParentResource,
  accounts: SchemaResource,
  accountClass: string,
) {
  if (!root.getChildrenCollection)
    throw new Error('Cannot enumerate this installation for migration');
  const hierarchy = await findSchema(store, drive, syncableHierarchySchema());
  const kindProperty = hierarchy.properties?.['syncable-node-kind'];
  const collection = await root.getChildrenCollection();
  const children = await collection.getAllMembers();
  const rawViews = root.get(dataBrowser.properties.tableViews);
  const views = Array.isArray(rawViews)
    ? rawViews.filter((value): value is string => typeof value === 'string')
    : [];
  const adoptedViews: string[] = [];

  for (const subject of new Set([...children, ...views])) {
    if (subject === accounts.subject) continue;
    const child = await store.getResource(subject);
    const parent = child.get(core.properties.parent);
    const atRoot =
      typeof parent === 'string' &&
      subjectsReferToSameResource(parent, root.subject);
    const alreadyMoved =
      typeof parent === 'string' &&
      subjectsReferToSameResource(parent, accounts.subject);
    if (!atRoot && !alreadyMoved) continue;
    if (!(await isSyncableResourceInDrive(store, drive, subject))) continue;
    const classes = classesOf(child);
    const view =
      views.includes(subject) && classes.includes(dataBrowser.classes.view);
    const row =
      classes.includes(accountClass) ||
      (kindProperty &&
        child.get(kindProperty) === 'public' &&
        classes.includes(dataBrowser.classes.table));
    if (!view && !row) continue;

    if (atRoot) {
      await child.set(core.properties.parent, accounts.subject);
      await child.save();
    }

    if (view) adoptedViews.push(subject);
  }

  if (adoptedViews.length) {
    const existing = accounts.get(dataBrowser.properties.tableViews);
    const combined = new Set([
      ...(Array.isArray(existing)
        ? existing.filter((value): value is string => typeof value === 'string')
        : []),
      ...adoptedViews,
    ]);
    await accounts.set(dataBrowser.properties.tableViews, [...combined]);
    const priorDefault = root.get(dataBrowser.properties.tableDefaultView);
    if (typeof priorDefault === 'string' && adoptedViews.includes(priorDefault))
      await accounts.set(dataBrowser.properties.tableDefaultView, priorDefault);
    await accounts.save();
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

  const root = (await store.getResource(subject)) as ParentResource;
  const data = root.get(app.properties['app-data']);
  let accounts =
    typeof data === 'string'
      ? await loadSyncableResource(store, data)
      : await store.findByLocalId(drive, subject, ACCOUNTS_LOCAL_ID);
  if (typeof data === 'string' && !accounts)
    throw new Error('The installed app accounts table is unavailable');
  const accountsParent = accounts?.get(core.properties.parent);
  if (
    accounts &&
    (typeof accountsParent !== 'string' ||
      !subjectsReferToSameResource(accountsParent, subject) ||
      !classesOf(accounts).includes(dataBrowser.classes.table) ||
      accounts.get(schema.properties['syncable-platform-id']) !== platform ||
      accounts.get(schema.properties['syncable-proxy-origin']) !==
        proxyOrigin ||
      !(await isSyncableResourceInDrive(store, drive, accounts.subject)))
  )
    throw new Error('The installed app accounts table has a different source');

  if (!accounts) {
    accounts = await store.newResource({
      parent: subject,
      isA: [dataBrowser.classes.table],
      propVals: {
        [core.properties.name]: 'Accounts',
        [core.properties.localId]: ACCOUNTS_LOCAL_ID,
        [core.properties.classtype]: schema.classes['syncable-account'],
        [schema.properties['syncable-platform-id']]: platform,
        [schema.properties['syncable-proxy-origin']]: proxyOrigin,
      },
    });
    await accounts.save();
  }

  if (classesOf(root).includes(dataBrowser.classes.table))
    await migratePlatformRows(
      store,
      drive,
      root,
      accounts,
      schema.classes['syncable-account'],
    );
  await ensureSyncablesTableViews(store, accounts.subject);
  await root.set(app.properties['app-data'], accounts.subject);
  await root.set(schema.properties['builtin-app'], 'syncables');
  await root.set(core.properties.isA, [
    ...classesOf(root).filter(kind => kind !== dataBrowser.classes.table),
    ...(!classesOf(root).includes(app.classes.app) ? [app.classes.app] : []),
  ]);
  root.remove?.(core.properties.classtype);
  root.remove?.(dataBrowser.properties.tableViews);
  root.remove?.(dataBrowser.properties.tableDefaultView);
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

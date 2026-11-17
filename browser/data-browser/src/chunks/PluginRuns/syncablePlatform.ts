/**
 * A provider installation is an ordinary Atomic table, not an executable App.
 *
 * This is the first provisioning slice of planning/builtin-syncables-apps.md.
 * Source connections and sandboxed view mounting are deliberately separate:
 * creating a table must never silently authorize an external service.
 */
import { ensureSyncablesTableViews } from './syncablesViews';
import {
  AtomicError,
  core,
  dataBrowser,
  Datatype,
  ensureSchema,
  ErrorType,
  findSchema,
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

/** Stored on the table, so its identity survives renaming and moving. */
export const syncablePlatformSchema = (): SchemaSpec => ({
  properties: [
    syncableNameProperty,
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

/** Cert-based resources have a stable drive; older resources may only have a parent. */
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
    if (typeof assignedDrive === 'string')
      return subjectsReferToSameResource(drive, assignedDrive);
    const parent = resource.get(core.properties.parent);
    if (typeof parent !== 'string' || !parent) return false;
    current = parent;
  }

  return false;
}

/** Read-only lookup, including a platform table moved elsewhere in the drive. */
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

  const isMatchingTable = (target: SchemaResource) => {
    const classes = target.get(core.properties.isA);

    return (
      Array.isArray(classes) &&
      classes.includes(dataBrowser.classes.table) &&
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
          isMatchingTable(target) &&
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
    isMatchingTable(original) &&
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

/**
 * Return an existing platform table or create it at the current drive root.
 * Reopening an installed provider must not create a second table.
 *
 * The table starts with the built-in Syncables view and a standard table view.
 */
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

async function provisionPlatform(
  store: PlatformProvisioner,
  input: PlatformInstall,
): Promise<string> {
  const { drive, proxyOrigin, platform, name } = input;
  const localId = platformLocalId(proxyOrigin, platform);

  const existing = await findSyncablePlatform(store, input);
  const schema = await ensureSchema(store, drive, syncablePlatformSchema());

  if (existing) {
    await ensureSyncablesTableViews(store, existing);
    await indexSyncablePlatform(
      store,
      drive,
      schema.properties['syncable-platform-index'],
      localId,
      existing,
    );

    return existing;
  }

  const table = await store.newResource({
    parent: drive,
    isA: [dataBrowser.classes.table],
    propVals: {
      [core.properties.name]: name,
      [core.properties.localId]: localId,
      [core.properties.classtype]: schema.classes['syncable-account'],
      [schema.properties['syncable-platform-id']]: platform,
      [schema.properties['syncable-proxy-origin']]: proxyOrigin,
    },
  });

  try {
    await table.save();
  } catch (error) {
    // If a concurrent install won the same localId, reuse the winner.
    const winner = await findSyncablePlatform(store, input);

    if (winner) {
      await ensureSyncablesTableViews(store, winner);
      await indexSyncablePlatform(
        store,
        drive,
        schema.properties['syncable-platform-index'],
        localId,
        winner,
      );

      return winner;
    }

    throw error;
  }

  await ensureSyncablesTableViews(store, table.subject);
  await indexSyncablePlatform(
    store,
    drive,
    schema.properties['syncable-platform-index'],
    localId,
    table.subject,
  );

  return table.subject;
}

/**
 * A provider installation is an ordinary Atomic table, not an executable App.
 *
 * This is the first provisioning slice of planning/builtin-syncables-apps.md.
 * Source connections and sandboxed view mounting are deliberately separate:
 * creating a table must never silently authorize an external service.
 */
import {
  core,
  dataBrowser,
  Datatype,
  ensureSchema,
  findSchema,
  type SchemaSpec,
  type SchemaStore,
} from '@tomic/lib';

/** Stored on the table, so its identity survives renaming and moving. */
export const syncablePlatformSchema = (): SchemaSpec => ({
  properties: [
    {
      shortname: 'syncable-platform-index',
      name: 'Connected platform tables',
      description: 'Drive-owned lookup of platform identity to Atomic table, independent of parent path.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-platform-id',
      name: 'Syncable platform ID',
      description: 'Platform identifier in the selected integration proxy catalog.',
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
      description: 'A connected account through which remote collection instances can be discovered.',
      recommends: [],
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

/** Read-only lookup, including a platform table moved elsewhere in the drive. */
export async function findSyncablePlatform(
  store: PlatformProvisioner,
  input: { drive: string; proxyOrigin: string; platform: string },
): Promise<string | undefined> {
  const { drive, proxyOrigin, platform } = input;
  const localId = platformLocalId(proxyOrigin, platform);
  const schema = await findSchema(store, drive, syncablePlatformSchema()).catch(
    () => undefined,
  );
  const indexProperty = schema?.properties?.['syncable-platform-index'];
  const platformProperty = schema?.properties?.['syncable-platform-id'];
  const proxyProperty = schema?.properties?.['syncable-proxy-origin'];

  if (indexProperty && platformProperty && proxyProperty) {
    const root = await store.getResource(drive);
    const map = root.get(indexProperty);
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      const subject = (map as Record<string, unknown>)[localId];
      if (typeof subject === 'string') {
        const target = await store.getResource(subject);
        if (
          target.get(platformProperty) === platform &&
          target.get(proxyProperty) === proxyOrigin
        ) {
          return subject;
        }
      }
    }
  }

  // Compatibility with tables provisioned before the drive index existed.
  const original = await store.findByLocalId(drive, drive, localId);
  return original?.subject;
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
  await root.set(property, { ...map, [localId]: subject });
  await root.save();
}


/**
 * Return an existing platform table or create it at the current drive root.
 * Reopening an installed provider must not create a second table.
 *
 * The table starts as an ordinary, readable Atomic Table. The planned
 * SyncableAccountsTable sandbox view and account connection are added by
 * later host milestones, never by executing catalog-supplied JavaScript.
 */
export async function ensureSyncablePlatform(
  store: PlatformProvisioner,
  input: {
    drive: string;
    proxyOrigin: string;
    platform: string;
    name: string;
  },
): Promise<string> {
  const { drive, proxyOrigin, platform, name } = input;
  const localId = platformLocalId(proxyOrigin, platform);

  const existing = await findSyncablePlatform(store, input);
  const schema = await ensureSchema(store, drive, syncablePlatformSchema());
  if (existing) {
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
    const winner = await store.findByLocalId(drive, drive, localId);
    if (winner) {
      await indexSyncablePlatform(
        store,
        drive,
        schema.properties['syncable-platform-index'],
        localId,
        winner.subject,
      );
      return winner.subject;
    }
    throw error;
  }

  await indexSyncablePlatform(
    store,
    drive,
    schema.properties['syncable-platform-index'],
    localId,
    table.subject,
  );
  return table.subject;
}

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
  type SchemaSpec,
  type SchemaStore,
} from '@tomic/lib';

const BASE = 'https://atomicdata.dev/properties/';

/** Stored on the table, so its identity survives renaming and moving. */
export const syncablePlatformSchema = (): SchemaSpec => ({
  properties: [
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

  const existing = await store.findByLocalId(drive, drive, localId);
  if (existing) return existing.subject;

  const schema = await ensureSchema(store, drive, syncablePlatformSchema());
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
    return table.subject;
  } catch (error) {
    // If a concurrent install won the same localId, reuse the winner.
    const winner = await store.findByLocalId(drive, drive, localId);
    if (winner) return winner.subject;
    throw error;
  }
}

/**
 * Provision normal Atomic resources for the Syncables discovery hierarchy.
 *
 * Called only by a trusted host action after a user has chosen a connection
 * or collection. The iframe never receives a drive-root write capability.
 * This module does not make provider requests or handle provider credentials.
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

export type SyncableNodeKind =
  | 'account'
  | 'organizations'
  | 'owner'
  | 'repositories'
  | 'repository'
  | 'mirror';

export interface SyncableNodeInput {
  drive: string;
  /** Initial parent only; re-discovery must never undo a user's move. */
  parent: string;
  proxyOrigin: string;
  platform: string;
  kind: SyncableNodeKind;
  /** Provider-stable identifier, not an Atomic subject or display name. */
  remoteId: string;
  name: string;
  /** Different read-only views of one remote resource, e.g. Issues vs PRs. */
  collectionName?: string;
  /** Organization, user, etc. Relevant only for an owner namespace. */
  ownerKind?: 'organization' | 'personal';
}

export const syncableHierarchySchema = (): SchemaSpec => ({
  properties: [
    {
      shortname: 'syncable-resource-index',
      name: 'Syncable resource index',
      description: 'Drive-level lookup of synced resources by canonical source key.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-source-key',
      name: 'Syncable source identity',
      description: 'Canonical proxy/platform/kind/remote binding, independent of Atomic parent.',
      datatype: Datatype.STRING,
    },
    {
      shortname: 'syncable-node-kind',
      name: 'Syncable node kind',
      description: 'Role of this resource in the discovery hierarchy.',
      datatype: Datatype.STRING,
    },
    {
      shortname: 'syncable-owner-kind',
      name: 'Remote owner kind',
      description: 'Whether this owner namespace is an organization or personal account.',
      datatype: Datatype.STRING,
    },
  ],
  classes: [
    {
      shortname: 'syncable-account',
      name: 'Syncable account',
      description: 'An authorized remote account.',
      recommends: [],
    },
    {
      shortname: 'syncable-owner',
      name: 'Syncable owner namespace',
      description: 'A remote organization or personal repository owner.',
      recommends: [],
    },
    {
      shortname: 'syncable-repository',
      name: 'Syncable repository',
      description: 'A repository within its canonical remote owner namespace.',
      recommends: [],
    },
    {
      shortname: 'syncable-record',
      name: 'Syncable record',
      description: 'A record mirrored from a selected remote collection.',
      recommends: [],
    },
  ],
});

/**
 * The remote identity deliberately contains no parent or display name. An
 * account is identified by the proxy's non-secret connection ID; an owner
 * is identified by its remote owner ID, even if many accounts can see it.
 */
export function syncableSourceKey(input: SyncableNodeInput): string {
  const { proxyOrigin, platform, kind, remoteId, collectionName } = input;
  const origin = new URL(proxyOrigin);
  if (origin.origin !== proxyOrigin) throw new Error('Proxy must be an origin');
  if (!/^[a-z0-9-]{1,80}$/.test(platform))
    throw new Error('Invalid platform ID');
  if (!remoteId) throw new Error('A remote identity is required');
  if (kind === 'mirror' && !collectionName)
    throw new Error('A mirrored collection needs a collection name');

  return JSON.stringify([
    proxyOrigin,
    platform,
    kind,
    remoteId,
    collectionName ?? '',
  ]);
}

const localIdFor = (key: string): string =>
  `syncables:node:${encodeURIComponent(key)}`;

function fromIndex(value: unknown): Record<string, string> {
  const entries: Record<string, string> = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, subject] of Object.entries(value)) {
      if (typeof subject === 'string') entries[key] = subject;
    }
  }
  return entries;
}

export async function findSyncableNode(
  store: SchemaStore,
  input: SyncableNodeInput,
): Promise<string | undefined> {
  const key = syncableSourceKey(input);
  const schema = await findSchema(
    store,
    input.drive,
    syncableHierarchySchema(),
  ).catch(() => undefined);
  const idx = schema?.properties?.['syncable-resource-index'];
  const source = schema?.properties?.['syncable-source-key'];
  if (idx && source) {
    const root = await store.getResource(input.drive);
    const subject = fromIndex(root.get(idx))[key];
    if (subject) {
      const node = await store.getResource(subject);
      if (node.get(source) === key) return subject;
    }
  }

  const existing = await store.findByLocalId(
    input.drive,
    input.parent,
    localIdFor(key),
  );
  return existing?.subject;
}

async function registerSource(
  store: SchemaStore,
  drive: string,
  property: string,
  key: string,
  subject: string,
): Promise<void> {
  const root = await store.getResource(drive);
  const index = fromIndex(root.get(property));
  if (index[key] === subject) return;
  await root.set(property, { ...index, [key]: subject });
  await root.save();
}

/**
 * Idempotent creation, called with the parent the *new* resource belongs to.
 * Existing matches are returned at their current location; no reparenting.
 */
export async function ensureSyncableNode(
  store: SchemaStore,
  input: SyncableNodeInput,
): Promise<string> {
  const key = syncableSourceKey(input);
  const existing = await findSyncableNode(store, input);
  const schema = await ensureSchema(
    store,
    input.drive,
    syncableHierarchySchema(),
  );
  const indexProperty = schema.properties['syncable-resource-index'];
  if (existing) {
    await registerSource(store, input.drive, indexProperty, key, existing);
    return existing;
  }

  const rowClass =
    input.kind === 'organizations'
      ? schema.classes['syncable-owner']
      : input.kind === 'repositories'
        ? schema.classes['syncable-repository']
        : schema.classes['syncable-record'];

  const isTable =
    input.kind === 'organizations' ||
    input.kind === 'repositories' ||
    input.kind === 'mirror';
  const klass =
    input.kind === 'account'
      ? schema.classes['syncable-account']
      : input.kind === 'owner'
        ? schema.classes['syncable-owner']
        : schema.classes['syncable-repository'];

  const node = await store.newResource({
    parent: input.parent,
    isA: [isTable ? dataBrowser.classes.table : klass],
    propVals: {
      [core.properties.name]: input.name,
      [core.properties.localId]: localIdFor(key),
      [schema.properties['syncable-source-key']]: key,
      [schema.properties['syncable-node-kind']]: input.kind,
      ...(isTable ? { [core.properties.classtype]: rowClass } : {}),
      ...(input.kind === 'owner' && input.ownerKind
        ? {
            [schema.properties['syncable-owner-kind']]: input.ownerKind,
          }
        : {}),
    },
  });

  try {
    await node.save();
  } catch (error) {
    const winner = await store.findByLocalId(
      input.drive,
      input.parent,
      localIdFor(key),
    );
    if (!winner) throw error;
    await registerSource(store, input.drive, indexProperty, key, winner.subject);
    return winner.subject;
  }

  await registerSource(store, input.drive, indexProperty, key, node.subject);
  return node.subject;
}

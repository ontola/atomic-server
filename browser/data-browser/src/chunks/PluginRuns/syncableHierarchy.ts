/**
 * Provision normal Atomic resources for the Syncables discovery hierarchy.
 *
 * Called only by a trusted host action after a user has chosen a connection
 * or collection. The iframe never receives a drive-root write capability.
 * This module does not make provider requests or handle provider credentials.
 */
import { ensureSyncablesTableViews } from './syncablesViews';
import {
  isSyncableResourceInDrive,
  loadSyncableResource,
  queueSyncableProvisioning,
  syncableNameProperty,
} from './syncablePlatform';
import {
  core,
  dataBrowser,
  Datatype,
  ensureSchema,
  findSchema,
  type SchemaSpec,
  type SchemaStore,
} from '@tomic/lib';

type SchemaResource = Awaited<ReturnType<SchemaStore['getResource']>>;

export type SyncableNodeKind =
  | 'account'
  | 'organizations'
  | 'owner'
  | 'repositories'
  | 'repository'
  | 'mirror'
  | 'public'
  | 'public-owner'
  | 'public-repository'
  | 'public-mirror';

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
  /** Public source bindings, never an OAuth token or other credential. */
  config?: Record<string, string>;
}

export const syncableHierarchySchema = (): SchemaSpec => ({
  properties: [
    syncableNameProperty,
    {
      shortname: 'syncable-mirror-status',
      name: 'Mirror status',
      description: 'Last acknowledged synchronization and pause state.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-issue-number',
      name: 'GitHub issue number',
      description: 'Stable issue number within its repository.',
      datatype: Datatype.INTEGER,
    },
    {
      shortname: 'syncable-issue-state',
      name: 'Issue state',
      description: 'Open or closed at last successful read.',
      datatype: Datatype.STRING,
    },
    {
      shortname: 'syncable-issue-updated',
      name: 'Updated at',
      description: 'Last GitHub update timestamp.',
      datatype: Datatype.TIMESTAMP,
    },
    {
      shortname: 'syncable-issue-link',
      name: 'Issue URL',
      description: 'Canonical GitHub issue link.',
      datatype: Datatype.URI,
    },
    {
      shortname: 'syncable-issue-body',
      name: 'Issue body',
      description: 'GitHub issue description in Markdown.',
      datatype: Datatype.MARKDOWN,
    },
    {
      shortname: 'syncable-source-config',
      name: 'Syncable source configuration',
      description:
        'Non-secret source bindings and selected collection parameters.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-resource-index',
      name: 'Syncable resource index',
      description:
        'Drive-level lookup of synced resources by canonical source key.',
      datatype: Datatype.JSON,
    },
    {
      shortname: 'syncable-source-key',
      name: 'Syncable source identity',
      description:
        'Canonical proxy/platform/kind/remote binding, independent of Atomic parent.',
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
      description:
        'Whether this owner namespace is an organization or personal account.',
      datatype: Datatype.STRING,
    },
  ],
  classes: [
    {
      shortname: 'syncable-account',
      name: 'Syncable account',
      description: 'An authorized remote account.',
      recommends: ['name'],
    },
    {
      shortname: 'syncable-owner',
      name: 'Syncable owner namespace',
      description: 'A remote organization or personal repository owner.',
      recommends: ['name'],
    },
    {
      shortname: 'syncable-repository',
      name: 'Syncable repository',
      description: 'A repository within its canonical remote owner namespace.',
      recommends: ['name'],
    },
    {
      shortname: 'syncable-record',
      name: 'Syncable record',
      description: 'A record mirrored from a selected remote collection.',
      recommends: [
        'name',
        'syncable-issue-number',
        'syncable-issue-state',
        'syncable-issue-updated',
        'syncable-issue-link',
        'syncable-issue-body',
      ],
    },
  ],
});

/**
 * The remote identity deliberately contains no parent or display name. An
 * account is identified by the proxy's non-secret connection ID. Owners and
 * repositories have canonical provider identities. Their listing and mirror
 * tables are tied to the connection that authorizes their reads.
 */
function sourceKeys(input: SyncableNodeInput): [string, ...string[]] {
  const { proxyOrigin, platform, kind, remoteId, collectionName } = input;
  const origin = new URL(proxyOrigin);
  if (origin.origin !== proxyOrigin) throw new Error('Proxy must be an origin');
  if (!/^[a-z0-9-]{1,80}$/.test(platform))
    throw new Error('Invalid platform ID');
  if (!remoteId) throw new Error('A remote identity is required');
  if ((kind === 'mirror' || kind === 'public-mirror') && !collectionName)
    throw new Error('A mirrored collection needs a collection name');
  if (kind.startsWith('public') && input.config?.connectionId !== undefined)
    throw new Error('Public resources cannot have a connection ID');

  const identity = [
    proxyOrigin,
    platform,
    kind,
    remoteId,
    collectionName ?? '',
  ];
  const legacyKey = JSON.stringify(identity);
  if (kind !== 'repositories' && kind !== 'mirror') return [legacyKey];
  const connectionId = input.config?.connectionId;
  if (!connectionId) throw new Error('A connection ID is required');
  const instance = kind === 'repositories' ? 'ownerId' : 'repoId';
  if (!input.config?.[instance])
    throw new Error('The source configuration must bind the remote instance');

  return [JSON.stringify([...identity, connectionId]), legacyKey];
}

export function syncableSourceKey(input: SyncableNodeInput): string {
  return sourceKeys(input)[0];
}

const localIdFor = (key: string): string =>
  `syncables:node:${encodeURIComponent(key)}`;

const isTableKind = (kind: SyncableNodeKind): boolean =>
  kind === 'organizations' ||
  kind === 'repositories' ||
  kind === 'mirror' ||
  kind === 'public' ||
  kind === 'public-mirror';

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
  return (await findSyncableNodeResource(store, input))?.subject;
}

async function findSyncableNodeResource(
  store: SchemaStore,
  input: SyncableNodeInput,
): Promise<SchemaResource | undefined> {
  const keys = sourceKeys(input);
  const schema = await findSchema(
    store,
    input.drive,
    syncableHierarchySchema(),
  );
  const indexProperty = schema.properties?.['syncable-resource-index'];
  const source = schema.properties?.['syncable-source-key'];
  const nodeKind = schema.properties?.['syncable-node-kind'];
  const sourceConfig = schema.properties?.['syncable-source-config'];
  if (!source || !nodeKind) return undefined;

  const isMatchingNode = async (node?: SchemaResource) => {
    if (!node || node.get(nodeKind) !== input.kind) return false;
    const storedKey = node.get(source);
    if (typeof storedKey !== 'string' || !keys.includes(storedKey))
      return false;

    if (isTableKind(input.kind)) {
      const classes = node.get(core.properties.isA);
      if (
        !Array.isArray(classes) ||
        !classes.includes(dataBrowser.classes.table)
      )
        return false;
    }

    if (keys.length > 1) {
      const config = sourceConfig ? node.get(sourceConfig) : undefined;
      if (!config || typeof config !== 'object' || Array.isArray(config))
        return false;
      const bindings = config as Record<string, unknown>;
      const instance = input.kind === 'repositories' ? 'ownerId' : 'repoId';
      if (
        bindings.connectionId !== input.config?.connectionId ||
        typeof bindings[instance] !== 'string' ||
        bindings[instance] !== input.config?.[instance]
      )
        return false;
    }

    return isSyncableResourceInDrive(store, input.drive, node.subject);
  };

  const index = indexProperty
    ? fromIndex((await store.getResource(input.drive)).get(indexProperty))
    : {};

  for (const key of keys) {
    const subject = index[key];

    if (subject) {
      const node = await loadSyncableResource(store, subject);
      if (await isMatchingNode(node)) return node;
    }

    const existing = await store.findByLocalId(
      input.drive,
      input.parent,
      localIdFor(key),
    );
    if (await isMatchingNode(existing)) return existing;
  }
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
export function ensureSyncableNode(
  store: SchemaStore,
  input: SyncableNodeInput,
): Promise<string> {
  return queueSyncableProvisioning(store, input.drive, () =>
    provisionSyncableNode(store, input),
  );
}

async function provisionSyncableNode(
  store: SchemaStore,
  input: SyncableNodeInput,
): Promise<string> {
  const key = syncableSourceKey(input);
  if (!(await isSyncableResourceInDrive(store, input.drive, input.parent)))
    throw new Error('The destination is outside this Syncables drive');
  const existing = await findSyncableNodeResource(store, input);
  const schema = await ensureSchema(
    store,
    input.drive,
    syncableHierarchySchema(),
  );
  const indexProperty = schema.properties['syncable-resource-index'];
  const sourceProperty = schema.properties['syncable-source-key'];
  const isTable = isTableKind(input.kind);

  if (existing) {
    if (existing.get(sourceProperty) !== key) {
      await existing.set(sourceProperty, key);
      await existing.save();
    }

    if (isTable) await ensureSyncablesTableViews(store, existing.subject);
    await registerSource(
      store,
      input.drive,
      indexProperty,
      key,
      existing.subject,
    );

    return existing.subject;
  }

  const rowClass =
    input.kind === 'organizations' || input.kind === 'public'
      ? schema.classes['syncable-owner']
      : input.kind === 'repositories'
        ? schema.classes['syncable-repository']
        : schema.classes['syncable-record'];

  const klass =
    input.kind === 'account'
      ? schema.classes['syncable-account']
      : input.kind === 'owner' || input.kind === 'public-owner'
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
      ...(input.config
        ? { [schema.properties['syncable-source-config']]: input.config }
        : {}),
      ...(isTable ? { [core.properties.classtype]: rowClass } : {}),
      ...((input.kind === 'owner' || input.kind === 'public-owner') &&
      input.ownerKind
        ? {
            [schema.properties['syncable-owner-kind']]: input.ownerKind,
          }
        : {}),
    },
  });

  try {
    await node.save();
  } catch (error) {
    const winner = await findSyncableNodeResource(store, input);
    if (!winner) throw error;
    if (isTable) await ensureSyncablesTableViews(store, winner.subject);
    await registerSource(
      store,
      input.drive,
      indexProperty,
      key,
      winner.subject,
    );

    return winner.subject;
  }

  if (isTable) await ensureSyncablesTableViews(store, node.subject);
  await registerSource(store, input.drive, indexProperty, key, node.subject);

  return node.subject;
}

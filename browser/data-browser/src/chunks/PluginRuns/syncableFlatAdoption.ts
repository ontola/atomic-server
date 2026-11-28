// @wc-ignore-file
/** Read-only adoption proofs. No allocation, provider reads, merging or deletion. */
import {
  collections,
  core,
  isCommitSubject,
  subjectsReferToSameResource,
  type Collections,
  type Store,
} from '@tomic/lib';
import {
  bindCollection,
  describeCollections,
  relatedCollectionReads,
  resolveEntityIdentity,
  type OpenApiDocument,
  type QuerySelection,
  type ReadSelection,
} from 'syncables/browser';
import {
  collectionIdentity,
  entitySourceKey,
  entityTableKey,
  sourceConfigFingerprint,
  type FlatIdentityAlias,
  type SyncablePrincipal,
} from './builtinSyncIdentity.js';
import {
  parseSyncableSourceConfig,
  parseSyncableSourceKey,
  sourceConfigMatchesKey,
  type SyncableSourceConfig,
  type SyncableSourceKey,
} from './syncableSource';
import { parseSyncableRuleConfig } from './syncableRules';
import { validateSyncableReferenceEvidence } from './syncableReferenceRecords';
import { assertSyncableLocalSubject } from './syncablePlatform';

export interface FlatMigrationBlock {
  principal: SyncablePrincipal;
  resource: string;
  message: string;
}

export interface SyncableFlatAdoptionRule {
  tableSourceKey: string;
  definition: ReadSelection;
  label: string;
}
export interface SyncableFlatAdoptionResult {
  aliases: FlatIdentityAlias[];
  blocks: FlatMigrationBlock[];
  warnings: string[];
  rules: SyncableFlatAdoptionRule[];
}
export interface SyncableFlatAdoptionOptions {
  drive: string;
  app: string;
  proxyOrigin: string;
  platform: string;
  document: OpenApiDocument;
  querySelection?: QuerySelection;
  properties: Record<string, string>;
  referenceClass?: string;
  maxResources?: number;
  assertCurrent: () => void;
}
type Saved = {
  subject: string;
  parent: unknown;
  raw: string;
  localId: string;
  fingerprint: string;
  key: SyncableSourceKey;
  config: SyncableSourceConfig;
};
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const groupKey = (principal: SyncablePrincipal, resource: string) =>
  sourceConfigFingerprint([principal, resource]);

export async function collectSyncableFlatAdoption(
  store: Store,
  options: SyncableFlatAdoptionOptions,
): Promise<SyncableFlatAdoptionResult> {
  const { drive, app, properties: p, assertCurrent } = options;
  const aliases: FlatIdentityAlias[] = [],
    warnings = new Set<string>();
  const rules: SyncableFlatAdoptionRule[] = [];
  const blocked = new Map<string, FlatMigrationBlock>();
  const maximum = options.maxResources ?? 10_000;
  const sourceProperty = p['syncable-source-key'],
    configProperty = p['syncable-source-config'];
  if (!sourceProperty || !configProperty)
    return { aliases, blocks: [], warnings: [], rules };

  const safe = (subject: string) => {
    try {
      assertSyncableLocalSubject(store, subject);

      return true;
    } catch {
      return false;
    }
  };

  const cache = new Map<string, Awaited<ReturnType<Store['getResource']>>>();

  const load = async (subject: string) => {
    if (!safe(subject))
      throw new Error('A saved Sync source belongs to another server');
    const known = cache.get(subject);
    if (known) return known;
    if (cache.size >= maximum)
      throw new Error('Flat source adoption exceeds its resource limit');
    const row = await store.getResource(subject);
    assertCurrent();
    if (row.error) throw row.error;
    cache.set(subject, row);

    return row;
  };

  const beneath = async (subject: string, root: string) => {
    let current: string | undefined = subject;
    const seen = new Set<string>();

    while (current && seen.size < 64 && !seen.has(current)) {
      if (subjectsReferToSameResource(current, root)) return true;
      seen.add(current);
      const row = await load(current);
      const stampedDrive = row.get('https://atomicdata.dev/properties/drive');
      if (
        stampedDrive !== undefined &&
        (typeof stampedDrive !== 'string' ||
          !subjectsReferToSameResource(stampedDrive, drive))
      )
        return false;
      const parent = row.get(core.properties.parent);
      current = typeof parent === 'string' ? parent : undefined;
    }

    return false;
  };

  const installation = await load(app);
  if (
    !(await beneath(app, drive)) ||
    installation.get(p['syncable-platform-id']) !== options.platform ||
    installation.get(p['syncable-proxy-origin']) !== options.proxyOrigin
  )
    throw new Error('The flat source installation does not match this App');

  const page = async (number: number) => {
    const url = new URL('/query', store.getServerUrl());
    for (const [name, value] of Object.entries({
      drive,
      property: sourceProperty,
      page_size: '100',
      current_page: String(number),
      include_nested: 'false',
    }))
      url.searchParams.set(name, value);
    const result = await store.fetchResourceFromServer<Collections.Collection>(
      url.href,
      // Query snapshots are regenerated independently. CRDT-merging them can
      // select an old members container alongside a newer total count.
      { noWebSocket: true, forceOverride: true },
    );
    assertCurrent();
    if (result.error) throw result.error;
    result.getLoroDoc();
    const total = result.get(collections.properties.totalMembers);
    if (
      typeof total !== 'number' ||
      !Number.isSafeInteger(total) ||
      total < 0 ||
      total > maximum
    )
      throw new Error(
        'Flat source discovery returned an invalid or excessive count',
      );

    return {
      total,
      members: result.getSubjects(collections.properties.members),
    };
  };

  const first = await page(0);
  const rawMembers = new Set<string>();
  const saved: Saved[] = [];
  const descriptions = describeCollections(options.document);

  const block = (
    principal: SyncablePrincipal,
    resource: string,
    message: string,
  ) => {
    blocked.set(groupKey(principal, resource), {
      principal,
      resource,
      message,
    });
    warnings.add(message);
  };

  for (
    let index = 0;
    index < Math.max(1, Math.ceil(first.total / 100));
    index++
  ) {
    const result = index === 0 ? first : await page(index);
    if (
      result.total !== first.total ||
      result.members.length !== Math.min(100, first.total - index * 100)
    )
      throw new Error(
        'Flat source discovery is incomplete or changed; retry after synchronization',
      );

    const members: string[] = [];

    for (const subject of result.members) {
      const normalized = store.normalizeSubject(subject);
      if (rawMembers.has(normalized))
        throw new Error('Flat source discovery returned duplicate members');
      rawMembers.add(normalized);
      if (isCommitSubject(subject) || !safe(subject)) continue;
      members.push(subject);
    }

    // Hydrate each proven query page together through the existing Store path.
    // Sequential cold reads otherwise require one local database round trip
    // per imported record before the Sync frame can open.
    const missing = members.filter(subject => !cache.has(subject));
    if (cache.size + missing.length > maximum)
      throw new Error('Flat source adoption exceeds its resource limit');

    if (missing.length) {
      const resources = await store.getResources(missing);
      assertCurrent();

      for (const [offset, row] of resources.entries()) {
        if (row.error) throw row.error;
        cache.set(missing[offset], row);
      }
    }

    for (const subject of members) {
      const row = await load(subject);
      if (!(await beneath(subject, drive))) continue;
      const raw = row.get(sourceProperty),
        candidate = row.get(configProperty);
      if (typeof raw !== 'string') continue;

      if (
        object(candidate) &&
        candidate.version === 3 &&
        candidate.kind === 'rule'
      ) {
        parseSyncableRuleConfig(candidate);
        continue;
      }

      let key: ReturnType<typeof parseSyncableSourceKey>;

      try {
        key = parseSyncableSourceKey(raw);
      } catch {
        continue;
      }

      if (
        key.proxyOrigin !== options.proxyOrigin ||
        key.platform !== options.platform
      )
        continue;
      if (key.version === 1)
        throw new Error(
          'This integration has saved sources in an older format. Their data was retained.',
        );
      const resource =
        key.version === 3 ? key.resource : key.collection?.resource;

      try {
        const config = parseSyncableSourceConfig(candidate);
        const localId = row.get(core.properties.localId);
        if (
          !sourceConfigMatchesKey(config, key, raw) ||
          typeof localId !== 'string' ||
          !localId.length ||
          localId.length > 65_536 ||
          row.get(p['syncable-node-kind']) !== key.kind
        )
          throw new Error('The stored source binding changed');

        if (config.version === 3 && config.kind === 'record') {
          let proven = false;

          try {
            proven =
              !!config.entityIdentity &&
              sourceConfigFingerprint(
                resolveEntityIdentity(options.document, {
                  resource: config.resource,
                  record: config.record!,
                  context: config.context,
                }),
              ) === sourceConfigFingerprint(config.entityIdentity);
          } catch {
            /* Identity-only summaries retain their declaring source evidence. */
          }

          if (
            !proven &&
            options.referenceClass &&
            config.entityIdentity &&
            row
              .getSubjects(core.properties.isA)
              .includes(options.referenceClass)
          )
            proven = validateSyncableReferenceEvidence(
              options.document,
              row.get(p['syncable-reference-evidence']),
              config.entityIdentity,
            );
          if (!proven)
            throw new Error(
              'The saved entity identity does not match its typed record',
            );
        }

        saved.push({
          subject,
          parent: row.get(core.properties.parent),
          raw,
          key,
          config,
          fingerprint: sourceConfigFingerprint(candidate),
          localId,
        });
      } catch {
        if (typeof resource === 'string')
          block(
            key.principal,
            resource,
            'A saved collection binding is invalid; review its migration before creating another destination.',
          );
      }
    }
  }

  const historicalTables = saved.filter(
    row => row.key.version === 2 && row.key.kind === 'collection',
  );
  const historicalRecords = saved.filter(
    row => row.key.version === 2 && row.key.kind === 'record',
  );
  const tablesByKey = new Map(
    saved
      .filter(row => row.key.kind === 'collection')
      .map(row => [row.raw, row]),
  );

  const originalChain = (
    row: Saved,
    principal: Saved,
    seen = new Set<string>(),
  ): boolean => {
    if (row.subject === principal.subject) return true;
    if (seen.has(row.subject) || seen.size >= 64 || row.config.version !== 2)
      return false;
    seen.add(row.subject);
    if (!row.config.parentSourceKey)
      return (
        row.key.kind === 'collection' &&
        typeof row.parent === 'string' &&
        subjectsReferToSameResource(row.parent, principal.subject)
      );
    const parents = saved.filter(
      candidate =>
        candidate.raw === row.config.parentSourceKey &&
        sourceConfigFingerprint(candidate.key.principal) ===
          sourceConfigFingerprint(row.key.principal),
    );

    return (
      parents.length === 1 &&
      typeof row.parent === 'string' &&
      subjectsReferToSameResource(row.parent, parents[0].subject) &&
      originalChain(parents[0], principal, seen)
    );
  };

  const oldRule = (table: Saved, resource: string): ReadSelection => {
    if (table.config.version !== 2)
      throw new Error('Expected historical table');
    if (table.config.collection)
      return {
        version: 1,
        resource,
        source: {
          kind: 'bound',
          bound: bindCollection(options.document, {
            collection: table.config.collection.collection,
            context: table.config.collection.pathParams,
            selection: options.querySelection,
          }),
        },
      };
    const navigation = table.config.navigation;
    const parents = saved.filter(
      candidate => candidate.raw === table.config.parentSourceKey,
    );
    const parent = parents.length === 1 ? parents[0] : undefined;
    if (
      !navigation ||
      !parent ||
      parent.config.version !== 2 ||
      !parent.config.record ||
      !parent.config.resource ||
      typeof parent.key.collection?.name !== 'string'
    )
      throw new Error('The original navigation source is unavailable');
    const matching = relatedCollectionReads(options.document, {
      resource: parent.config.resource,
      record: parent.config.record,
      context: parent.config.context,
    }).filter(
      candidate =>
        sourceConfigFingerprint(collectionIdentity(undefined, candidate)) ===
        sourceConfigFingerprint(collectionIdentity(undefined, navigation)),
    );
    if (matching.length !== 1)
      throw new Error('The original relationship is unavailable');

    return {
      version: 1,
      resource,
      source: {
        kind: 'related',
        origin: {
          entity: resolveEntityIdentity(options.document, {
            resource: parent.config.resource,
            record: parent.config.record,
            context: parent.config.context,
          }),
          record: parent.config.record,
          context: parent.config.context ?? {},
          read: bindCollection(options.document, {
            collection: parent.key.collection.name,
            context: parent.config.context ?? {},
            selection: options.querySelection,
          }),
        },
        via: {
          collection: matching[0].collection,
          kind: matching[0].kind === 'direct' ? 'identity' : 'responseLink',
          ...('reference' in matching[0] && matching[0].reference
            ? { reference: matching[0].reference }
            : {}),
          ...('link' in matching[0] && matching[0].link
            ? { link: matching[0].link }
            : {}),
        },
      },
    };
  };

  const roots = new Map<string, Saved[]>();
  const canonical = new Map<string, Saved[]>();

  for (const table of historicalTables) {
    const resource = table.key.collection?.resource;
    if (typeof resource !== 'string') continue;
    const group = groupKey(table.key.principal, resource);
    if (!roots.has(group)) roots.set(group, []);
    if (
      table.config.version === 2 &&
      table.config.collection &&
      !table.config.navigation &&
      !table.config.parentSourceKey
    )
      roots.get(group)!.push(table);
  }

  for (const table of saved.filter(
    row => row.key.version === 3 && row.key.kind === 'collection',
  )) {
    const group = groupKey(table.key.principal, table.key.resource!);
    const list = canonical.get(group) ?? [];
    list.push(table);
    canonical.set(group, list);
  }

  const alias = (
    row: Saved,
    key: string,
    reparent = false,
  ): FlatIdentityAlias => ({
    canonicalSourceKey: key,
    subject: row.subject,
    previousSourceKey: row.raw,
    localId: row.localId,
    sourceConfigFingerprint: row.fingerprint,
    ...(typeof row.parent === 'string' ? { previousParent: row.parent } : {}),
    ...(reparent ? { reparentToLogicalParent: true } : {}),
  });
  const destinations = new Map<string, Saved>();

  for (const table of historicalTables) {
    const resource = table.key.collection?.resource;
    if (typeof resource !== 'string') continue;
    const group = groupKey(table.key.principal, resource);
    if (destinations.has(group)) continue;
    const candidates = roots.get(group) ?? [],
      current = canonical.get(group) ?? [];
    const principals = saved.filter(
      row =>
        row.key.kind === 'principal' &&
        sourceConfigFingerprint(row.key.principal) ===
          sourceConfigFingerprint(table.key.principal),
    );
    const groupTables = historicalTables.filter(
      candidate =>
        candidate.key.collection?.resource === resource &&
        sourceConfigFingerprint(candidate.key.principal) ===
          sourceConfigFingerprint(table.key.principal),
    );
    const winner =
      candidates.length === 1
        ? candidates[0]
        : candidates.length === 0 && groupTables.length === 1
          ? groupTables[0]
          : undefined;
    const parent =
      principals.length === 1 && winner && originalChain(winner, principals[0])
        ? principals[0]
        : undefined;
    if (winner && current.length === 0 && parent) {
      try {
        const definition = oldRule(winner, resource);
        const tableSourceKey = entityTableKey({
          ...options,
          principal: winner.key.principal,
          resource,
        });
        destinations.set(group, winner);
        aliases.push(
          alias(winner, tableSourceKey, winner.parent !== parent.subject),
        );
        rules.push({
          tableSourceKey,
          definition,
          label: 'Previously synced collection',
        });
      } catch {
        block(
          table.key.principal,
          resource,
          'The original collection read plan cannot be preserved safely; review migration before syncing.',
        );
      }
    } else if (current.length === 1 && candidates.length === 0)
      destinations.set(group, current[0]);
    else
      block(
        table.key.principal,
        resource,
        'Nested, moved or competing saved tables require migration review; all original tables and rows were retained.',
      );
  }

  const entityGroups = new Map<
    string,
    { row: Saved; alias: FlatIdentityAlias }[]
  >();

  for (const row of historicalRecords) {
    if (
      row.config.version !== 2 ||
      !row.config.record ||
      !row.config.resource ||
      !row.config.parentSourceKey
    )
      continue;
    const resource = row.config.resource;
    const parent = tablesByKey.get(row.config.parentSourceKey);
    const description = descriptions.filter(
      item =>
        item.name === row.key.collection?.name && item.resource === resource,
    );

    try {
      if (
        !parent ||
        description.length !== 1 ||
        row.config.record[description[0].idField] !== row.key.remoteId
      )
        throw new Error('The original record identity is invalid');
      const entity = resolveEntityIdentity(options.document, {
        resource,
        record: row.config.record,
        context: row.config.context,
      });
      const key = entitySourceKey({
        ...options,
        principal: row.key.principal,
        entityIdentity: entity,
      });
      const destination = destinations.get(
        groupKey(row.key.principal, resource),
      );
      const principals = saved.filter(
        candidate =>
          candidate.key.kind === 'principal' &&
          sourceConfigFingerprint(candidate.key.principal) ===
            sourceConfigFingerprint(row.key.principal),
      );
      const untouched =
        typeof row.parent === 'string' &&
        subjectsReferToSameResource(row.parent, parent.subject);
      const within = destination
        ? await beneath(row.subject, destination.subject)
        : false;
      const reparent =
        destination &&
        principals.length === 1 &&
        originalChain(row, principals[0]) &&
        destination.subject !== row.parent;
      const read = bindCollection(options.document, {
        collection: description[0].name,
        context: row.config.context ?? {},
        selection: options.querySelection,
      });
      const canonicalConfig = parseSyncableSourceConfig({
        version: 3,
        kind: 'record',
        proxyOrigin: options.proxyOrigin,
        platform: options.platform,
        principal: row.key.principal,
        resource,
        entityIdentity: entity,
        record: row.config.record,
        context: row.config.context ?? {},
        read,
        ...(row.config.connectionId
          ? { connectionId: row.config.connectionId }
          : {}),
        ...(row.config.managedProperties
          ? { managedProperties: row.config.managedProperties }
          : {}),
      });
      const proposed = {
        ...alias(row, key, !!reparent),
        canonicalConfig: { ...canonicalConfig },
        entityTableSourceKey: entityTableKey({
          ...options,
          principal: row.key.principal,
          resource,
        }),
      };
      const list = entityGroups.get(key) ?? [];
      list.push({ row, alias: proposed });
      entityGroups.set(key, list);
      if ((!untouched || !within) && !reparent)
        warnings.add(
          'Some saved rows were moved outside their canonical collection. Their subjects and values were retained and updates remain protected.',
        );
    } catch {
      block(
        row.key.principal,
        resource,
        'A saved entity identity or read context cannot be validated; review migration before syncing this item type.',
      );
    }
  }

  for (const list of entityGroups.values()) {
    if (list.length > 1)
      block(
        list[0].row.key.principal,
        list[0].row.config.resource!,
        'Multiple saved rows have the same canonical entity identity. Review them before syncing; no copies were merged.',
      );
    aliases.push(...list.map(item => item.alias));
  }

  assertCurrent();

  return {
    aliases,
    blocks: [...blocked.values()],
    warnings: [...warnings],
    rules,
  };
}

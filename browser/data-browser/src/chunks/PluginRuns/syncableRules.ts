// @wc-ignore-file
import {
  CollectionBuilder,
  core,
  dataBrowser,
  isAtomicIdentifier,
  subjectsReferToSameResource,
  type Resource,
  type Store,
} from '@tomic/lib';
import {
  parseReadSelection,
  readSelectionKey,
  type OriginRecord,
  type ReadSelection,
} from 'syncables/browser';
import {
  entitySourceKey,
  ruleSourceKey,
  sourceConfigFingerprint,
  type SyncablePrincipal,
} from './builtinSyncIdentity.js';
import {
  parseSyncableSourceConfig,
  parseSyncableSourceKey,
  sourceConfigMatchesKey,
} from './syncableSource';
import { isSyncableResourceInDrive } from './syncablePlatform';

export interface SyncableRuleConfig {
  version: 3;
  kind: 'rule';
  resource: string;
  definition: ReadSelection;
  ruleKey: string;
}
export type SyncableRuleRun = {
  generation: string;
  runId: string;
  startOrder: number;
};
export interface SyncableRuleContext {
  subject: string;
  key: string;
  resource: string;
  definition: ReadSelection;
  run?: SyncableRuleRun;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 65_536;

export function parseSyncableRuleConfig(raw: unknown): SyncableRuleConfig {
  if (
    !object(raw) ||
    raw.version !== 3 ||
    raw.kind !== 'rule' ||
    !text(raw.resource) ||
    !text(raw.ruleKey) ||
    Object.keys(raw).some(
      key =>
        !['version', 'kind', 'resource', 'definition', 'ruleKey'].includes(key),
    )
  )
    throw new Error('Invalid saved Sync filter definition');
  const definition = parseReadSelection(raw.definition);
  if (definition.resource !== raw.resource)
    throw new Error('The saved filter has a different resource type');
  if (readSelectionKey(definition) !== raw.ruleKey)
    throw new Error('The saved filter key does not match its definition');

  return {
    version: 3,
    kind: 'rule',
    resource: raw.resource,
    ruleKey: raw.ruleKey,
    definition,
  };
}

/** Only immutable provider selection belongs in this stamp; presentation and status are independent. */
export function syncableRuleDefinitionStamp(
  config: SyncableRuleConfig,
): string {
  return sourceConfigFingerprint(config);
}

export function parseSyncableRuleRun(
  raw: unknown,
): SyncableRuleRun | undefined {
  if (raw === undefined) return;
  if (
    !object(raw) ||
    !text(raw.generation) ||
    !text(raw.runId) ||
    typeof raw.startOrder !== 'number' ||
    !Number.isSafeInteger(raw.startOrder) ||
    raw.startOrder < 0 ||
    Object.keys(raw).some(
      key => !['generation', 'runId', 'startOrder'].includes(key),
    )
  )
    throw new Error('Invalid Sync filter run generation');

  return {
    generation: raw.generation,
    runId: raw.runId,
    startOrder: raw.startOrder,
  };
}

export function readSyncableRuleStatus(raw: unknown): Record<
  string,
  unknown
> & {
  paused?: boolean;
  enabled?: boolean;
  run?: SyncableRuleRun;
} {
  if (raw === undefined) return {};
  if (
    !object(raw) ||
    (raw.paused !== undefined && typeof raw.paused !== 'boolean') ||
    (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')
  )
    throw new Error('Invalid Sync filter status');

  return {
    ...raw,
    ...(raw.run === undefined ? {} : { run: parseSyncableRuleRun(raw.run) }),
  };
}

export function needsInitialSync(raw: unknown): boolean {
  try {
    const status = readSyncableRuleStatus(raw);

    return (
      !status.paused &&
      status.enabled !== false &&
      !status.lastSuccess &&
      !status.run &&
      !status.error
    );
  } catch {
    return false;
  }
}

export interface ResolveSyncableRuleOptions {
  drive: string;
  table: string;
  subject: string;
  proxyOrigin: string;
  platform: string;
  principal: SyncablePrincipal;
  resource: string;
  properties: Record<string, string>;
  assertCurrent: () => void;
  assertDrive: (subject: string) => void;
}
export interface ResolvedSyncableRule extends SyncableRuleContext {
  view: Resource;
  origins: OriginRecord[];
  definitionStamp: string;
  assertCurrent: () => void;
  subscribe: (onInvalidated: () => void) => () => void;
}

/** Resolve origins from stored typed source identities, never the iframe's saved raw snapshots. */
export async function resolveSyncableRule(
  store: Store,
  options: ResolveSyncableRuleOptions,
): Promise<ResolvedSyncableRule> {
  const { drive, table, subject, properties: p } = options;

  const safe = (value: string) => {
    if (isAtomicIdentifier(value)) return true;

    try {
      const url = new URL(value);

      return (
        url.origin === new URL(store.getServerUrl()).origin &&
        !url.username &&
        !url.password &&
        !url.hash
      );
    } catch {
      return false;
    }
  };

  if (!safe(subject))
    throw new Error('The Sync filter belongs to another server');
  const view = await store.getResource(subject);
  options.assertCurrent();
  if (view.error) throw view.error;
  const tableResource = await store.getResource(table);
  options.assertCurrent();
  if (
    !subjectsReferToSameResource(view.get(core.properties.parent), table) ||
    !view.getSubjects(core.properties.isA).includes(dataBrowser.classes.view) ||
    !tableResource
      .getSubjects(dataBrowser.properties.tableViews)
      .some(value => subjectsReferToSameResource(value, subject))
  )
    throw new Error('Select a saved Sync filter from this collection');
  const configProperty = p['syncable-source-config'];
  const sourceProperty = p['syncable-source-key'];
  if (!configProperty || !sourceProperty)
    throw new Error('The Sync vocabulary is unavailable');
  const config = parseSyncableRuleConfig(view.get(configProperty));
  if (config.resource !== options.resource)
    throw new Error('The filter belongs to another entity collection');
  const definitionStamp = syncableRuleDefinitionStamp(config);
  const tableKey = tableResource.get(sourceProperty);
  if (typeof tableKey !== 'string')
    throw new Error('The entity table source identity is unavailable');
  const viewKey = ruleSourceKey(tableKey, config.ruleKey);

  const assertViewIdentity = () => {
    if (
      view.get(sourceProperty) !== viewKey ||
      view.get(core.properties.localId) !==
        'syncables:node:' + encodeURIComponent(viewKey)
    )
      throw new Error('The saved Sync filter source identity changed');
  };

  assertViewIdentity();
  const dependencies: { row: Resource; stamp: string }[] = [];
  const origins: OriginRecord[] = [];
  const originKeys = new Set<string>();

  const walk = async (selection: ReadSelection): Promise<void> => {
    if (selection.source.kind === 'fanout') return walk(selection.source.from);
    if (selection.source.kind !== 'related') return;
    const saved = selection.source.origin;
    if (originKeys.has(saved.entity.key)) return;
    originKeys.add(saved.entity.key);
    const key = entitySourceKey({
      proxyOrigin: options.proxyOrigin,
      platform: options.platform,
      principal: options.principal,
      entityIdentity: saved.entity,
    });
    const query = new CollectionBuilder(store)
      .setDrive(drive)
      .setPreferServer(true)
      .setProperty(sourceProperty)
      .setValue(key)
      .setPageSize(2)
      .build();
    await query.waitForReady();
    options.assertCurrent();
    if (query.totalMembers !== 1)
      throw new Error('The filter source entity is unknown or ambiguous');
    const source = await query.getMemberWithIndex(0);
    options.assertCurrent();
    if (
      !source ||
      !safe(source) ||
      !(await isSyncableResourceInDrive(store, drive, source))
    )
      throw new Error('The filter source entity is outside this drive');
    options.assertCurrent();
    const row = await store.getResource(source);
    options.assertCurrent();
    if (row.error) throw row.error;
    const parsedKey = parseSyncableSourceKey(row.get(sourceProperty));
    const parsed = parseSyncableSourceConfig(row.get(configProperty));
    if (
      parsedKey.version !== 3 ||
      parsedKey.kind !== 'record' ||
      parsed.version !== 3 ||
      parsed.kind !== 'record' ||
      row.get(sourceProperty) !== key ||
      !sourceConfigMatchesKey(parsed, parsedKey, key) ||
      !parsed.entityIdentity ||
      !parsed.record ||
      !parsed.read ||
      parsed.resource !== saved.entity.resource ||
      parsed.entityIdentity.key !== saved.entity.key
    )
      throw new Error('The filter source entity identity changed');
    dependencies.push({
      row,
      stamp: sourceConfigFingerprint([row.get(sourceProperty), parsed]),
    });
    origins.push({
      entity: parsed.entityIdentity,
      record: parsed.record,
      context: parsed.context ?? {},
      read: parsed.read,
    });
  };

  await walk(config.definition);
  options.assertCurrent();

  const assertCurrent = () => {
    options.assertCurrent();
    options.assertDrive(subject);
    assertViewIdentity();
    if (
      !subjectsReferToSameResource(view.get(core.properties.parent), table) ||
      !view
        .getSubjects(core.properties.isA)
        .includes(dataBrowser.classes.view) ||
      !tableResource
        .getSubjects(dataBrowser.properties.tableViews)
        .some(value => subjectsReferToSameResource(value, subject)) ||
      syncableRuleDefinitionStamp(
        parseSyncableRuleConfig(view.get(configProperty)),
      ) !== definitionStamp
    )
      throw new Error('The saved Sync filter definition changed');

    for (const dependency of dependencies) {
      options.assertDrive(dependency.row.subject);
      const current = parseSyncableSourceConfig(
        dependency.row.get(configProperty),
      );
      if (
        sourceConfigFingerprint([
          dependency.row.get(sourceProperty),
          current,
        ]) !== dependency.stamp
      )
        throw new Error('The Sync filter source entity changed');
    }
  };

  assertCurrent();

  const subscribe = (onInvalidated: () => void) => {
    const removes = new Map<string, () => void>();
    let stopped = false;
    let checking = false;

    // Inventory only: the existing guard proves scope. No resource fetches or
    // query scans are needed to watch the ancestry it already validated.
    const subjects = () => {
      const watched = new Set([store.normalizeSubject(drive)]);

      for (const dependency of dependencies) {
        const seen = new Set<string>();
        let current = dependency.row.subject;

        while (seen.size < 64) {
          const normalized = store.normalizeSubject(current);
          if (seen.has(normalized)) break;
          seen.add(normalized);
          watched.add(normalized);
          if (subjectsReferToSameResource(current, drive)) break;
          const parent = store.resources
            .get(normalized)
            ?.get(core.properties.parent);
          if (typeof parent !== 'string' || !parent) break;
          current = parent;
        }
      }

      return watched;
    };

    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const remove of removes.values()) remove();
      removes.clear();
    };

    const check = () => {
      if (stopped || checking) return;
      checking = true;

      try {
        assertCurrent();
        const currentSubjects = subjects();

        for (const [watched, remove] of removes)
          if (!currentSubjects.has(watched)) {
            remove();
            removes.delete(watched);
          }

        for (const watched of currentSubjects) {
          if (stopped) break;
          if (removes.has(watched)) continue;
          const remove = store.subscribe(watched, check);
          if (stopped) remove();
          else removes.set(watched, remove);
        }

        // Recheck after registration, including changes during subscribe.
        assertCurrent();
      } catch {
        stop();
        onInvalidated();
      } finally {
        checking = false;
      }
    };

    check();

    return stop;
  };

  return {
    subject,
    key: config.ruleKey,
    resource: config.resource,
    definition: config.definition,
    definitionStamp,
    view,
    origins,
    assertCurrent,
    subscribe,
  };
}

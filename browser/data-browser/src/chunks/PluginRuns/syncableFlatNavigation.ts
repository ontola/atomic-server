// @wc-ignore-file
import {
  CollectionBuilder,
  Datatype,
  core,
  dataBrowser,
  findSchema,
  subjectsReferToSameResource,
  type JSONValue,
  type Collection,
  type Resource,
  type Store,
} from '@tomic/lib';
import {
  parseReadSelection,
  readSelectionKey,
  type ReadSelection,
} from 'syncables/browser';
import {
  canonicalValue,
  entityTableKey,
  ruleSourceKey,
  sourceConfigFingerprint,
} from './builtinSyncIdentity.js';
import {
  parseSyncableSourceConfig,
  parseSyncableSourceKey,
  sourceConfigMatchesKey,
} from './syncableSource';
import { parseSyncableRuleConfig } from './syncableRules';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  isSyncableResourceInDrive,
  classifySyncableResourceDrive,
} from './syncablePlatform';
import { assertSyncAppDrive } from './builtinSyncablesProfile';

const object = (raw: unknown): raw is Record<string, unknown> =>
  !!raw && typeof raw === 'object' && !Array.isArray(raw);

function captureSession(store: Store) {
  const actor = store.getAgent()?.subject;
  const server = store.getServerUrl();

  return () => {
    if (store.getAgent()?.subject !== actor || store.getServerUrl() !== server)
      throw new Error(
        'The active account or server changed; reopen this collection',
      );
  };
}

/** Keep cached/offline Open, but classify every match before identity counts. */
async function storedSubjectsInDrive(
  store: Store,
  drive: string,
  query: Collection,
  assertCurrent: () => void,
) {
  await query.waitForReady();
  assertCurrent();
  if (query.totalMembers > 10_000)
    throw new Error('The saved identity lookup exceeds its limit');
  const subjects = await query.getAllMembers();
  assertCurrent();
  if (subjects.length !== query.totalMembers)
    throw new Error('The saved identity lookup is incomplete; reopen it');
  const scoped: string[] = [];

  for (const subject of subjects) {
    const included = await classifySyncableResourceDrive(store, drive, subject);
    assertCurrent();
    if (included) scoped.push(subject);
  }

  return scoped;
}

/** Explicit native Open saves a scope under an existing sibling table; no provider reads. */
export async function openFlatSyncableRow(
  store: Store,
  drive: string,
  table: Resource,
  row: Resource,
  activeRule?: string,
) {
  const assertSession = captureSession(store);
  const { properties } = await findSchema(
    store,
    drive,
    syncableHierarchySchema(),
  );
  assertSession();
  const p = properties ?? {};
  const configProperty = p['syncable-source-config'];
  const keyProperty = p['syncable-source-key'];
  const raw = table.get(configProperty);
  if (!object(raw) || raw.version !== 3) return undefined;
  const source = parseSyncableSourceConfig(raw);
  const record = parseSyncableSourceConfig(row.get(configProperty));
  const key = parseSyncableSourceKey(row.get(keyProperty));
  let assertRule = () => {};
  const tableStamp = sourceConfigFingerprint([
    table.get(configProperty),
    table.get(keyProperty),
    table.get(core.properties.parent),
    table.get(core.properties.classtype),
  ]);
  const rowStamp = sourceConfigFingerprint([
    row.get(configProperty),
    row.get(keyProperty),
    row.get(core.properties.parent),
    row.get(p['syncable-entity-table']),
    row.get(p['syncable-navigation-intents']),
    row.get(p['syncable-rule-memberships']),
  ]);

  const assertOpen = () => {
    assertSession();
    assertRule();
    if (
      sourceConfigFingerprint([
        table.get(configProperty),
        table.get(keyProperty),
        table.get(core.properties.parent),
        table.get(core.properties.classtype),
      ]) !== tableStamp
    )
      throw new Error('The source collection changed; reopen it');
    assertSyncAppDrive(store, drive, row.subject);
    if (
      sourceConfigFingerprint([
        row.get(configProperty),
        row.get(keyProperty),
        row.get(core.properties.parent),
        row.get(p['syncable-entity-table']),
        row.get(p['syncable-navigation-intents']),
        row.get(p['syncable-rule-memberships']),
      ]) !== rowStamp
    )
      throw new Error('The selected row changed; reopen it');
  };

  if (
    source.version !== 3 ||
    source.kind !== 'collection' ||
    record.version !== 3 ||
    record.kind !== 'record' ||
    key.version !== 3 ||
    !sourceConfigMatchesKey(record, key, row.get(keyProperty) as string) ||
    !row.hasClasses(table.get(core.properties.classtype) as string) ||
    source.resource !== record.resource ||
    !record.entityIdentity ||
    !record.record ||
    source.proxyOrigin !== record.proxyOrigin ||
    source.platform !== record.platform ||
    JSON.stringify(canonicalValue(source.principal)) !==
      JSON.stringify(canonicalValue(record.principal)) ||
    !subjectsReferToSameResource(
      row.get(p['syncable-entity-table']),
      table.subject,
    ) ||
    !(await isSyncableResourceInDrive(store, drive, row.subject))
  )
    throw new Error('This row no longer belongs to this entity collection');
  assertOpen();
  const intents = row.get(p['syncable-navigation-intents']);
  if (
    !Array.isArray(intents) ||
    !intents.length ||
    !record.read ||
    record.read.resource !== record.resource
  )
    return { subject: row.subject };
  const intent = intents[0];
  if (
    !object(intent) ||
    intent.version !== 1 ||
    intent.sourceEntityKey !== row.get(keyProperty) ||
    typeof intent.label !== 'string'
  )
    throw new Error('The stored collection navigation is invalid');
  let definition = parseReadSelection(intent.definition);
  if (
    definition.source.kind !== 'related' ||
    definition.source.origin.entity.key !== record.entityIdentity.key ||
    intent.resource !== definition.resource
  )
    throw new Error('The stored relationship has a different source identity');
  definition = {
    ...definition,
    source: {
      ...definition.source,
      origin: {
        entity: record.entityIdentity,
        record: record.record,
        context: record.context ?? {},
        read: record.read,
      },
    },
  };
  let name = `${String(row.get(core.properties.name) ?? record.entityIdentity.path)} · ${intent.label}`;

  if (activeRule) {
    const rule = await store.getResource(activeRule);
    if (
      rule.error ||
      !rule.hasClasses(dataBrowser.classes.view) ||
      !subjectsReferToSameResource(
        rule.get(core.properties.parent),
        table.subject,
      ) ||
      !table
        .getSubjects(dataBrowser.properties.tableViews)
        .some(value => subjectsReferToSameResource(value, activeRule)) ||
      !row
        .getSubjects(p['syncable-rule-memberships'])
        .some(value => subjectsReferToSameResource(value, activeRule))
    )
      throw new Error('This row no longer belongs to the selected filter');
    const ruleStamp = sourceConfigFingerprint([
      rule.get(configProperty),
      rule.get(core.properties.parent),
      rule.get(core.properties.isA),
    ]);

    assertRule = () => {
      if (
        sourceConfigFingerprint([
          rule.get(configProperty),
          rule.get(core.properties.parent),
          rule.get(core.properties.isA),
        ]) !== ruleStamp ||
        !table
          .getSubjects(dataBrowser.properties.tableViews)
          .some(value => subjectsReferToSameResource(value, activeRule))
      )
        throw new Error('The selected saved filter changed; reopen it');
    };

    assertOpen();
    const selected = parseSyncableRuleConfig(rule.get(configProperty));
    if (
      selected.resource !== record.resource ||
      definition.source.kind !== 'related'
    )
      throw new Error('Invalid source filter');
    definition = {
      version: 1,
      resource: definition.resource,
      source: {
        kind: 'fanout',
        from: selected.definition,
        via: definition.source.via,
        entities: [record.entityIdentity],
      },
    } as ReadSelection;
    name = `${String(rule.get(core.properties.name) ?? 'Saved filter')} · ${name}`;
  }

  definition = parseReadSelection(definition);

  return saveFlatSyncableSelection(
    store,
    drive,
    table,
    definition,
    name,
    assertOpen,
  );
}

/** Save an explicitly chosen catalog scope using the same identity as the Sync app. */
export async function saveFlatSyncableSelection(
  store: Store,
  drive: string,
  table: Resource,
  definition: ReadSelection,
  name: string,
  assertCaller: () => void = () => {},
) {
  const assertSession = captureSession(store);

  const assertActive = () => {
    assertCaller();
    assertSession();
  };

  assertActive();
  if (!(await isSyncableResourceInDrive(store, drive, table.subject)))
    throw new Error('The source collection is outside this drive');
  const { properties } = await findSchema(
    store,
    drive,
    syncableHierarchySchema(),
  );
  const p = properties ?? {};
  const configProperty = p['syncable-source-config'];
  const keyProperty = p['syncable-source-key'];
  assertActive();
  const source = parseSyncableSourceConfig(table.get(configProperty));
  const sourceStamp = sourceConfigFingerprint([
    table.get(configProperty),
    table.get(keyProperty),
    table.get(core.properties.parent),
  ]);

  const assertSource = () => {
    assertActive();
    if (
      sourceConfigFingerprint([
        table.get(configProperty),
        table.get(keyProperty),
        table.get(core.properties.parent),
      ]) !== sourceStamp
    )
      throw new Error('The source collection changed; reopen it');
  };

  const sourceKey = parseSyncableSourceKey(table.get(keyProperty));
  if (
    sourceKey.version !== 3 ||
    !sourceConfigMatchesKey(source, sourceKey, String(table.get(keyProperty)))
  )
    throw new Error('The source collection identity changed');
  if (source.version !== 3 || source.kind !== 'collection')
    throw new Error('This is not a flat entity collection');
  definition = parseReadSelection(definition);
  const targetKey = entityTableKey({
    ...source,
    resource: definition.resource,
  });
  const query = new CollectionBuilder(store)
    .setDrive(drive)
    .setProperty(keyProperty)
    .setValue(targetKey)
    .setPageSize(2)
    .build();
  const targets = await storedSubjectsInDrive(
    store,
    drive,
    query,
    assertSource,
  );
  if (targets.length !== 1)
    throw new Error(
      'The target entity collection is missing or ambiguous. Open the app Sync view to prepare its collections.',
    );
  const subject = targets[0];
  if (!subject || !(await isSyncableResourceInDrive(store, drive, subject)))
    throw new Error('The target collection is outside this drive');
  const target = await store.getResource(subject);
  const targetConfig = parseSyncableSourceConfig(target.get(configProperty));
  if (
    target.error ||
    !target.hasClasses(dataBrowser.classes.table) ||
    targetConfig.version !== 3 ||
    targetConfig.kind !== 'collection' ||
    target.get(keyProperty) !== targetKey ||
    entityTableKey(targetConfig) !== targetKey
  )
    throw new Error('The target entity collection changed');
  const targetStamp = sourceConfigFingerprint([
    target.get(configProperty),
    target.get(keyProperty),
    target.get(core.properties.parent),
  ]);

  const assertMutation = () => {
    assertSource();
    assertSyncAppDrive(store, drive, table.subject);
    assertSyncAppDrive(store, drive, target.subject);
    if (
      sourceConfigFingerprint([
        target.get(configProperty),
        target.get(keyProperty),
        target.get(core.properties.parent),
      ]) !== targetStamp
    )
      throw new Error('The target collection changed; reopen it');
  };

  const assertCurrent = async () => {
    assertMutation();

    for (const scopedSubject of [table.subject, target.subject]) {
      if (!(await isSyncableResourceInDrive(store, drive, scopedSubject)))
        throw new Error('The selected collection moved outside this drive');
      assertMutation();
    }
  };

  const assertWritable = async () => {
    await assertCurrent();
    const actor = store.getAgent()?.subject;
    if (!actor) throw new Error('Sign in before saving this filter');
    const [allowed] = await target.canWrite(actor);
    await assertCurrent();
    if (!allowed)
      throw new Error(
        'Write access to the target collection is required to save a filter',
      );
  };

  const ruleKey = readSelectionKey(definition);
  const stableKey = ruleSourceKey(targetKey, ruleKey);
  const ruleQuery = new CollectionBuilder(store)
    .setDrive(drive)
    .setProperty(keyProperty)
    .setValue(stableKey)
    .setPageSize(2)
    .build();
  const rules = await storedSubjectsInDrive(
    store,
    drive,
    ruleQuery,
    assertSource,
  );
  if (rules.length > 1)
    throw new Error('This saved filter has conflicting identities');
  const existing = rules[0];
  let rule: Resource;
  await assertCurrent();

  if (existing) {
    rule = await store.getResource(existing);
    if (
      rule.error ||
      !rule.hasClasses(dataBrowser.classes.view) ||
      !subjectsReferToSameResource(rule.get(core.properties.parent), subject) ||
      parseSyncableRuleConfig(rule.get(configProperty)).ruleKey !== ruleKey
    )
      throw new Error('The saved filter identity has changed');
  } else {
    await assertWritable();
    rule = await store.newResource({
      parent: subject,
      deferGenesis: true,
      isA: dataBrowser.classes.view,
      propVals: {
        [core.properties.name]: name.slice(0, 200),
        [core.properties.localId]:
          'syncables:node:' + encodeURIComponent(stableKey),
        [keyProperty]: stableKey,
        [p['syncable-node-kind']]: 'rule',
        [dataBrowser.properties.viewKind]: 'syncable-collection',
        [configProperty]: {
          version: 3,
          kind: 'rule',
          resource: definition.resource,
          definition,
          ruleKey,
        } as unknown as JSONValue,
      },
    });
    await assertWritable();
    await rule.save();
    await assertCurrent();
  }

  if (
    !target
      .getSubjects(dataBrowser.properties.tableViews)
      .includes(rule.subject)
  ) {
    await assertWritable();
    await target.set(
      dataBrowser.properties.tableViews,
      [...target.getSubjects(dataBrowser.properties.tableViews), rule.subject],
      false,
      Datatype.RESOURCEARRAY,
      assertMutation,
    );
    await assertWritable();
    await target.save();
    await assertCurrent();
  }

  await assertCurrent();

  return { subject, view: rule.subject, syncFilter: rule.subject };
}

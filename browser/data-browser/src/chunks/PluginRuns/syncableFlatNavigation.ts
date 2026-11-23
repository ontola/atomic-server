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
import { parseSyncableCollectionView } from './syncableCollection';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  isSyncableResourceInDrive,
  classifySyncableResourceDrive,
  assertSyncableLocalSubject,
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

/** A catalog-declared action reconstructed from stored Atomic evidence only. */
export interface FlatSyncableRowAction {
  id: string;
  label: string;
  targetResource: string;
  definition: ReadSelection;
}

/** Resource pages use logical collection ownership, never the current parent path. */
export async function resolveFlatSyncableRecordActions(
  store: Store,
  drive: string,
  row: Resource,
): Promise<{ table: Resource; actions: FlatSyncableRowAction[] } | undefined> {
  const assertSession = captureSession(store);
  assertSyncableLocalSubject(store, drive);
  const { properties } = await findSchema(
    store,
    drive,
    syncableHierarchySchema(),
  );
  assertSession();
  const property = properties?.['syncable-entity-table'];
  const subject = property && row.get(property);
  if (typeof subject !== 'string') return undefined;
  assertSyncableLocalSubject(store, subject);
  const table = await store.getResource(subject);
  assertSession();
  const actions = await resolveFlatSyncableRowActions(store, drive, table, row);
  assertSession();

  return { table, actions };
}

/** Listing actions never writes a View, runs an app or reads a provider/catalog. */
export async function resolveFlatSyncableRowActions(
  store: Store,
  drive: string,
  table: Resource,
  row: Resource,
  activeRule?: string,
): Promise<FlatSyncableRowAction[]> {
  return (
    (await rowNavigation(store, drive, table, row, activeRule))?.actions ?? []
  );
}

/** Explicit Open re-proves a chosen action before saving/reusing its sibling filter. */
export async function openFlatSyncableRow(
  store: Store,
  drive: string,
  table: Resource,
  row: Resource,
  activeRule?: string,
  actionId?: string,
) {
  const navigation = await rowNavigation(store, drive, table, row, activeRule);
  if (!navigation) return undefined;
  const action = actionId
    ? navigation.actions.find(candidate => candidate.id === actionId)
    : navigation.actions[0];

  if (!action) {
    if (actionId)
      throw new Error('This stored relationship is no longer available');

    return { subject: row.subject };
  }

  navigation.assertCurrent();

  const destination = await saveFlatSyncableSelection(
    store,
    drive,
    table,
    action.definition,
    `${navigation.name} · ${action.label}`,
    navigation.assertCurrent,
  );
  navigation.assertCurrent();
  const target = await store.getResource(destination.subject);
  navigation.assertCurrent();

  // Select presentation within the same proof window as saving the filter.
  // A stored View pointer is data, never permission to fetch another origin.
  for (const viewSubject of target
    .getSubjects(dataBrowser.properties.tableViews)
    .slice(0, 100)) {
    try {
      assertSyncableLocalSubject(store, viewSubject);
    } catch {
      continue;
    }

    let view: Resource;

    try {
      view = await store.getResource(viewSubject);
    } catch {
      navigation.assertCurrent();
      continue;
    }

    navigation.assertCurrent();

    try {
      assertSyncableLocalSubject(store, view.subject);
    } catch {
      continue;
    }

    const assignedDrive = view.get('https://atomicdata.dev/properties/drive');

    if (
      !view.error &&
      view.hasClasses(dataBrowser.classes.view) &&
      subjectsReferToSameResource(view.subject, viewSubject) &&
      subjectsReferToSameResource(
        view.get(core.properties.parent),
        target.subject,
      ) &&
      target
        .getSubjects(dataBrowser.properties.tableViews)
        .some(subject => subjectsReferToSameResource(subject, view.subject)) &&
      (assignedDrive === undefined ||
        (typeof assignedDrive === 'string' &&
          subjectsReferToSameResource(assignedDrive, drive))) &&
      view.get(dataBrowser.properties.viewKind) === 'table' &&
      view.get(navigation.configProperty) === undefined
    ) {
      navigation.assertCurrent();

      return { ...destination, view: view.subject };
    }
  }

  navigation.assertCurrent();

  return destination;
}

async function rowNavigation(
  store: Store,
  drive: string,
  table: Resource,
  row: Resource,
  activeRule?: string,
) {
  const assertSession = captureSession(store);
  const { properties, classes } = await findSchema(
    store,
    drive,
    syncableHierarchySchema(),
  );
  assertSession();
  const p = properties ?? {};
  const configProperty = p['syncable-source-config'];
  const keyProperty = p['syncable-source-key'];
  const descriptorProperty = p['syncable-collection-view'];
  const raw = table.get(configProperty);
  if (!object(raw) || raw.version !== 3) return undefined;
  assertSyncableLocalSubject(store, drive);
  const source = parseSyncableSourceConfig(raw);
  const record = parseSyncableSourceConfig(row.get(configProperty));
  const key = parseSyncableSourceKey(row.get(keyProperty));
  const descriptor = parseSyncableCollectionView(
    table.get(descriptorProperty),
    table.get(core.properties.classtype),
  );
  const tableValues = () => [
    table.get(configProperty),
    table.get(keyProperty),
    table.get(core.properties.parent),
    table.get(core.properties.classtype),
    table.get(core.properties.isA),
    table.get(descriptorProperty),
    table.get('https://atomicdata.dev/properties/drive'),
  ];
  const rowValues = () => [
    row.get(configProperty),
    row.get(keyProperty),
    row.get(core.properties.parent),
    row.get(core.properties.isA),
    row.get(p['syncable-entity-table']),
    row.get(p['syncable-navigation-intents']),
    row.get(p['syncable-rule-memberships']),
    row.get('https://atomicdata.dev/properties/drive'),
  ];
  const tableStamp = sourceConfigFingerprint(tableValues());
  const rowStamp = sourceConfigFingerprint(rowValues());
  const guards: (() => void)[] = [];

  const assertCurrent = () => {
    assertSession();
    if (table.error || row.error)
      throw new Error('The selected stored resources are no longer readable');
    if (sourceConfigFingerprint(tableValues()) !== tableStamp)
      throw new Error('The source collection changed; reopen it');
    if (sourceConfigFingerprint(rowValues()) !== rowStamp)
      throw new Error('The selected row changed; reopen it');
    assertSyncAppDrive(store, drive, table.subject);
    assertSyncAppDrive(store, drive, row.subject);
    for (const guard of guards) guard();
  };

  const tableKey = parseSyncableSourceKey(table.get(keyProperty));
  if (
    table.error ||
    row.error ||
    source.version !== 3 ||
    source.kind !== 'collection' ||
    tableKey.version !== 3 ||
    !sourceConfigMatchesKey(source, tableKey, String(table.get(keyProperty))) ||
    !table.hasClasses(dataBrowser.classes.table) ||
    record.version !== 3 ||
    record.kind !== 'record' ||
    key.version !== 3 ||
    !sourceConfigMatchesKey(record, key, String(row.get(keyProperty))) ||
    source.resource !== record.resource ||
    !record.entityIdentity ||
    source.proxyOrigin !== record.proxyOrigin ||
    source.platform !== record.platform ||
    JSON.stringify(canonicalValue(source.principal)) !==
      JSON.stringify(canonicalValue(record.principal)) ||
    !subjectsReferToSameResource(
      row.get(p['syncable-entity-table']),
      table.subject,
    ) ||
    !(await isSyncableResourceInDrive(store, drive, table.subject)) ||
    !(await isSyncableResourceInDrive(store, drive, row.subject))
  )
    throw new Error('This row no longer belongs to this entity collection');
  assertCurrent();
  let name = String(
    row.get(core.properties.name) ?? record.entityIdentity.path,
  );
  const referenceClass = classes?.['syncable-reference'];
  if (
    !row.hasClasses(table.get(core.properties.classtype) as string) &&
    !(referenceClass && row.hasClasses(referenceClass))
  )
    throw new Error('This row no longer belongs to this entity collection');
  // Embedded/scalar summaries retain canonical identity without claiming a
  // complete API row or collection-read provenance. They supply no actions.
  if (
    !row.hasClasses(table.get(core.properties.classtype) as string) ||
    !record.record ||
    !record.read ||
    record.read.resource !== record.resource
  )
    return { actions: [], name, assertCurrent, configProperty };
  let selected: ReturnType<typeof parseSyncableRuleConfig> | undefined;

  if (activeRule) {
    const rule = await store.getResource(activeRule);
    assertCurrent();
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
    const ruleValues = () => [
      rule.get(configProperty),
      rule.get(keyProperty),
      rule.get(core.properties.parent),
      rule.get(core.properties.isA),
    ];
    const ruleStamp = sourceConfigFingerprint(ruleValues());
    guards.push(() => {
      if (
        sourceConfigFingerprint(ruleValues()) !== ruleStamp ||
        !table
          .getSubjects(dataBrowser.properties.tableViews)
          .some(value => subjectsReferToSameResource(value, activeRule))
      )
        throw new Error('The selected saved filter changed; reopen it');
    });
    selected = parseSyncableRuleConfig(rule.get(configProperty));
    if (
      selected.resource !== record.resource ||
      rule.get(keyProperty) !==
        ruleSourceKey(String(table.get(keyProperty)), selected.ruleKey)
    )
      throw new Error('Invalid source filter');
    name = `${String(rule.get(core.properties.name) ?? 'Saved filter')} · ${name}`;
  }

  const actions: FlatSyncableRowAction[] = [];
  const intents = row.get(p['syncable-navigation-intents']);
  if (
    !descriptor ||
    !Array.isArray(intents) ||
    intents.length > 100 ||
    !record.read ||
    record.read.resource !== record.resource
  )
    return { actions, name, assertCurrent, configProperty };

  // One complete canonical lookup per resource, shared by direct and depth-two actions.
  const targets = new Map<string, Promise<Resource | undefined>>();

  const targetFor = (resource: string) => {
    let pending = targets.get(resource);

    if (!pending) {
      pending = (async () => {
        const expectedKey = entityTableKey({ ...source, resource });
        const query = new CollectionBuilder(store)
          .setDrive(drive)
          .setProperty(keyProperty)
          .setValue(expectedKey)
          .setPageSize(2)
          .build();
        let subjects: string[];

        try {
          subjects = await storedSubjectsInDrive(
            store,
            drive,
            query,
            assertCurrent,
          );
        } catch {
          assertCurrent();

          return undefined;
        }

        assertCurrent();
        if (subjects.length !== 1) return undefined;
        const target = await store.getResource(subjects[0]);
        assertCurrent();
        const targetValues = () => [
          target.get(configProperty),
          target.get(keyProperty),
          target.get(core.properties.parent),
          target.get(core.properties.classtype),
          target.get(core.properties.isA),
          target.get(descriptorProperty),
          target.get('https://atomicdata.dev/properties/drive'),
        ];
        const stamp = sourceConfigFingerprint(targetValues());
        const config = parseSyncableSourceConfig(target.get(configProperty));
        if (
          target.error ||
          !target.hasClasses(dataBrowser.classes.table) ||
          config.version !== 3 ||
          config.kind !== 'collection' ||
          target.get(keyProperty) !== expectedKey ||
          entityTableKey(config) !== expectedKey ||
          !(await isSyncableResourceInDrive(store, drive, target.subject))
        )
          return undefined;
        assertCurrent();
        guards.push(() => {
          assertSyncAppDrive(store, drive, target.subject);
          if (target.error)
            throw new Error('The target collection is no longer readable');
          if (sourceConfigFingerprint(targetValues()) !== stamp)
            throw new Error(
              'The target collection or its relationships changed; reopen it',
            );
        });

        return target;
      })().catch(error => {
        assertCurrent();
        // Invalid or unavailable stored targets do not invent a derived relationship.
        if (
          error instanceof Error &&
          /changed|selected drive/.test(error.message)
        )
          throw error;

        return undefined;
      });
      targets.set(resource, pending);
    }

    return pending;
  };

  const add = (label: string, definition: ReadSelection) => {
    definition = parseReadSelection(definition);
    const id = readSelectionKey(definition);
    if (!actions.some(action => action.id === id))
      actions.push({
        id,
        label,
        targetResource: definition.resource,
        definition,
      });
  };

  const directActions: {
    label: string;
    definition: ReadSelection;
    table: Resource;
  }[] = [];

  for (const intent of intents) {
    if (actions.length >= 100) break;
    if (
      !object(intent) ||
      intent.version !== 1 ||
      intent.sourceEntityKey !== row.get(keyProperty) ||
      typeof intent.label !== 'string' ||
      !intent.label ||
      intent.label.length > 200
    )
      continue;
    let direct: ReadSelection;

    try {
      direct = parseReadSelection(intent.definition);
    } catch {
      continue;
    }

    if (
      direct.source.kind !== 'related' ||
      direct.source.origin.entity.key !== record.entityIdentity.key ||
      intent.resource !== direct.resource ||
      !descriptor.relationships?.some(
        relationship =>
          relationship.resource === direct.resource &&
          JSON.stringify(canonicalValue(relationship.via)) ===
            JSON.stringify(
              canonicalValue(
                direct.source.kind === 'related'
                  ? direct.source.via
                  : undefined,
              ),
            ),
      )
    )
      continue;
    const via = direct.source.via;
    direct = selected
      ? ({
          version: 1,
          resource: direct.resource,
          source: {
            kind: 'fanout',
            from: selected.definition,
            via,
            entities: [record.entityIdentity],
          },
        } as ReadSelection)
      : {
          ...direct,
          source: {
            ...direct.source,
            origin: {
              entity: record.entityIdentity,
              record: record.record,
              context: record.context ?? {},
              read: record.read,
            },
          },
        };
    direct = parseReadSelection(direct);
    if (direct.resource === source.resource) continue;
    const intermediate = await targetFor(direct.resource);
    assertCurrent();
    if (!intermediate) continue;
    add(intent.label, direct);
    directActions.push({
      label: intent.label,
      definition: direct,
      table: intermediate,
    });
  }

  // Preserve every direct choice before spending the bounded budget on shortcuts.
  for (const direct of directActions) {
    const intermediateDescriptor = parseSyncableCollectionView(
      direct.table.get(descriptorProperty),
      direct.table.get(core.properties.classtype),
    );

    for (const relationship of intermediateDescriptor?.relationships ?? []) {
      if (actions.length >= 100) break;
      if (
        relationship.resource === source.resource ||
        relationship.resource === direct.definition.resource
      )
        continue;
      const target = await targetFor(relationship.resource);
      assertCurrent();
      if (!target) continue;

      try {
        add(`${relationship.title} (via ${direct.label})`, {
          version: 1,
          resource: relationship.resource,
          source: {
            kind: 'fanout',
            from: direct.definition,
            via: relationship.via,
          },
        } as ReadSelection);
      } catch {
        /* Unsupported stored selectors supply no action. */
      }
    }
  }

  assertCurrent();

  return { actions, name, assertCurrent, configProperty };
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
      rule.get(keyProperty) !== stableKey ||
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
        [dataBrowser.properties.viewKind]: 'table',
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
      .some(viewSubject =>
        subjectsReferToSameResource(viewSubject, rule.subject),
      )
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

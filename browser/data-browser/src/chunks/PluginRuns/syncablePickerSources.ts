// @wc-ignore-file
import {
  core,
  dataBrowser,
  readConnectionSubjects,
  type Store,
} from '@tomic/lib';
import {
  bindCollection,
  compileReadSelection,
  describeEntityTypes,
  ontologyShortname,
  readSelectionKey,
  type OpenApiDocument,
  type QuerySelection,
  type ReadSelection,
} from 'syncables/browser';
import { entityTableKey, ruleSourceKey } from './builtinSyncIdentity.js';
import {
  assertSyncAppDrive,
  type SyncAppContext,
} from './builtinSyncablesProfile';
import type { SyncableApiSchema } from './syncableApiSchema';
import {
  assertSyncableLocalSubject,
  assertSyncableResourceActive,
} from './syncablePlatform';
import { resolveSyncableRule } from './syncableRules';
import {
  parseSyncableSourceConfig,
  parseSyncableSourceKey,
  sourceConfigMatchesKey,
} from './syncableSource';

interface PickerTable {
  resource: string;
  title: string;
  table?: string;
  ruleSubjects: string[];
}

export interface SyncablePickerSource extends PickerTable {
  collections: string[];
  groups?: (PickerTable & { property: string })[];
}

/** Find stored root filters for catalog relations without granting new reads or writes. */
export async function resolveSyncablePickerSources(
  store: Store,
  context: SyncAppContext,
  document: OpenApiDocument,
  apiSchema: SyncableApiSchema,
  assertCurrent: () => void,
  querySelection?: QuerySelection,
): Promise<SyncablePickerSource[]> {
  if (
    context.kind !== 'collection' ||
    !context.resource ||
    context.rule ||
    context.principal?.kind !== 'authenticated'
  )
    return [];

  const { drive, platform, proxyOrigin, principal } = context;
  const types = describeEntityTypes(document);
  const typesByResource = new Map(types.map(type => [type.resource, type]));
  const targetType = typesByResource.get(context.resource);
  if (!targetType) return [];
  const roots = new Map(
    types.map(type => [
      type.resource,
      type.collections.filter(
        collection =>
          !collection.contextParams.length && !collection.relationships.length,
      ),
    ]),
  );
  const sourceCollections = new Map<string, Set<string>>();

  for (const collection of targetType.collections) {
    for (const relation of collection.relationships) {
      if (!roots.get(relation.parentResource)?.length) continue;
      const names = sourceCollections.get(relation.parentResource) ?? new Set();
      names.add(collection.name);
      sourceCollections.set(relation.parentResource, names);
    }
  }

  const properties = context.schema.properties;
  const configProperty = properties['syncable-source-config'];
  const keyProperty = properties['syncable-source-key'];
  const tables = new Map<string, Promise<PickerTable>>();

  const readTable = async (resource: string): Promise<PickerTable> => {
    const type = typesByResource.get(resource)!;
    const plan = { resource, title: type.presentation.title, ruleSubjects: [] };
    const rowClass = apiSchema.classes[ontologyShortname(resource)];
    if (!context.principalApp || !configProperty || !keyProperty || !rowClass)
      return plan;
    const key = entityTableKey({ proxyOrigin, platform, principal, resource });
    const subjects = await readConnectionSubjects(
      store,
      drive,
      keyProperty,
      key,
    );
    assertCurrent();
    const [tableSubject] = subjects;
    if (subjects.length !== 1 || !tableSubject) return plan;
    assertSyncableLocalSubject(store, tableSubject);
    await assertSyncableResourceActive(store, drive, tableSubject);
    assertCurrent();
    const table = await store.getResource(tableSubject);
    assertCurrent();
    if (table.error) throw table.error;
    const saved = parseSyncableSourceConfig(table.get(configProperty));
    const savedKey = parseSyncableSourceKey(table.get(keyProperty));
    if (
      saved.version !== 3 ||
      saved.kind !== 'collection' ||
      savedKey.version !== 3 ||
      table.get(keyProperty) !== key ||
      !sourceConfigMatchesKey(saved, savedKey, key) ||
      !table.hasClasses(dataBrowser.classes.table) ||
      table.get(core.properties.classtype) !== rowClass
    )
      return plan;

    const rootKeys = new Set(
      (roots.get(resource) ?? []).map(collection => {
        const definition: ReadSelection = {
          version: 1,
          resource,
          source: {
            kind: 'bound',
            bound: bindCollection(document, {
              collection: collection.name,
              selection: querySelection,
            }),
          },
        };

        return ruleSourceKey(key, readSelectionKey(definition));
      }),
    );
    const matches = new Map<string, string | undefined>();

    for (const ruleSubject of new Set(
      table.getSubjects(dataBrowser.properties.tableViews),
    )) {
      assertSyncableLocalSubject(store, ruleSubject);
      const view = await store.getResource(ruleSubject);
      assertCurrent();
      const viewKey = view.get(keyProperty);
      if (view.error || typeof viewKey !== 'string' || !rootKeys.has(viewKey))
        continue;
      await assertSyncableResourceActive(store, drive, ruleSubject);
      assertCurrent();
      const rule = await resolveSyncableRule(store, {
        drive,
        table: table.subject,
        subject: ruleSubject,
        proxyOrigin,
        platform,
        principal,
        resource,
        properties,
        assertCurrent,
        assertDrive: subject => assertSyncAppDrive(store, drive, subject),
      });
      compileReadSelection(document, rule.definition, { querySelection });
      matches.set(viewKey, matches.has(viewKey) ? undefined : rule.subject);
    }

    const ruleSubjects = [...matches.values()].filter(
      subject => subject !== undefined,
    );

    return { ...plan, table: table.subject, ruleSubjects };
  };

  const tableFor = (resource: string) => {
    const previous = tables.get(resource);
    if (previous) return previous;
    const pending = readTable(resource);
    tables.set(resource, pending);

    return pending;
  };

  return Promise.all(
    [...sourceCollections].map(async ([resource, collections]) => {
      const source = typesByResource.get(resource)!;
      const parentResources = new Set(
        source.collections.flatMap(collection =>
          collection.relationships.map(relation => relation.parentResource),
        ),
      );
      const groups = Promise.all(
        [...parentResources].flatMap(parent => {
          if (parent === resource || !roots.get(parent)?.length) return [];
          const fields = (source.resourceFields ?? []).filter(
            field =>
              field.cardinality === 'one' &&
              field.targets.some(candidate => candidate.resource === parent),
          );
          if (fields.length !== 1) return [];
          const property =
            apiSchema.resourceProperties?.[resource]?.[fields[0].property];
          if (!property) return [];

          return [tableFor(parent).then(table => ({ ...table, property }))];
        }),
      );
      const [table, populatedGroups] = await Promise.all([
        tableFor(resource),
        groups,
      ]);
      assertCurrent();

      return {
        ...table,
        collections: [...collections],
        ...(populatedGroups.length ? { groups: populatedGroups } : {}),
      };
    }),
  );
}

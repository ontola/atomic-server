// @wc-ignore-file
import {
  core,
  dataBrowser,
  findSchema,
  readConnectionSubjects,
  subjectsReferToSameResource,
  type JSONValue,
  type Store,
} from '@tomic/lib';
import { ontologyShortname } from 'syncables/browser';
import { sourceConfigFingerprint } from './builtinSyncIdentity.js';
import { assertSyncAppDrive } from './builtinSyncablesProfile';
import type { SyncableApiSchema } from './syncableApiSchema';
import { syncableHierarchySchema } from './syncableHierarchy';
import {
  assertSyncableLocalSubject,
  classifySyncableResourceDrive,
} from './syncablePlatform';
import {
  parseSyncableSourceConfig,
  parseSyncableSourceKey,
  sourceConfigMatchesKey,
} from './syncableSource';

/** Replace managed keys in place; retain hidden choices and unrelated virtual keys. */
export function replaceSyncableViewColumns(
  value: JSONValue | undefined,
  replacements: ReadonlyMap<string, string>,
): JSONValue | undefined {
  if (!Array.isArray(value) || value.some(key => typeof key !== 'string'))
    return value;
  const affected = new Set(replacements.values());
  const seen = new Set<string>();
  const mapped = (value as string[]).flatMap(key => {
    const next = replacements.get(key) ?? key;
    if (affected.has(next) && seen.has(next)) return [];
    seen.add(next);

    return [next];
  });

  return sourceConfigFingerprint(mapped) === sourceConfigFingerprint(value)
    ? value
    : mapped;
}

/** Native setup migration only. No row, rule, filter, provider or iframe writes. */
export async function migrateSyncableApiViews(
  store: Store,
  drive: string,
  schema: SyncableApiSchema,
  assertCurrent: () => void,
): Promise<void> {
  const actor = store.getAgent()?.subject;
  const server = store.getServerUrl();

  const current = () => {
    assertCurrent();
    if (actor !== store.getAgent()?.subject || server !== store.getServerUrl())
      throw new Error(
        'The active account or server changed during schema migration',
      );
  };

  current();
  const changes = Object.entries(schema.resourceProperties ?? {})
    .map(([resource, properties]) => ({
      resource,
      rowClass: schema.classes[ontologyShortname(resource)],
      replacements: new Map(
        Object.entries(properties)
          .filter(
            ([key, value]) =>
              schema.properties[key] && schema.properties[key] !== value,
          )
          .map(([key, value]) => [schema.properties[key], value]),
      ),
    }))
    .filter(change => change.replacements.size);
  if (!changes.length) return;
  assertSyncableLocalSubject(store, drive);
  const terms = await findSchema(store, drive, syncableHierarchySchema());
  current();
  const configProperty = terms.properties?.['syncable-source-config'];
  const keyProperty = terms.properties?.['syncable-source-key'];
  if (!configProperty || !keyProperty)
    throw new Error('The Sync schema is unavailable for saved view migration');

  // Strict classification loads full ancestry. Skip only proven Trash; unknown
  // scope, malformed parents and network failures still reject migration.
  const active = async (subject: string) => {
    current();
    const included = await classifySyncableResourceDrive(store, drive, subject);
    current();
    if (!included) return false;
    const trash = store.resources
      .get(store.normalizeSubject(drive))
      ?.get(dataBrowser.properties.trashFolder);
    if (trash !== undefined) assertSyncableLocalSubject(store, trash);
    const seen = new Set<string>();
    let ancestor = subject;

    while (seen.size < 64 && !seen.has(ancestor)) {
      if (
        typeof trash === 'string' &&
        subjectsReferToSameResource(ancestor, trash)
      )
        return false;
      if (subjectsReferToSameResource(ancestor, drive)) return true;
      seen.add(ancestor);
      const parent = store.resources
        .get(store.normalizeSubject(ancestor))
        ?.get(core.properties.parent);
      if (typeof parent !== 'string') break;
      ancestor = parent;
    }

    throw new Error('The saved view Drive ancestry could not be proven');
  };

  for (const { resource, rowClass, replacements } of changes) {
    if (!rowClass) throw new Error('The integration row class is unavailable');
    const subjects = await readConnectionSubjects(
      store,
      drive,
      core.properties.classtype,
      rowClass,
      { includeTrashed: true },
    );
    current();

    for (const subject of subjects) {
      if (!(await active(subject))) continue;
      const table = await store.getResource(subject);
      current();
      if (table.get(configProperty) === undefined) continue;
      const source = parseSyncableSourceConfig(table.get(configProperty));
      // The Sync frame adopts legacy sources after setup. Their views migrate
      // on a later open, once the collection has a canonical V3 identity.
      if (source.version === 2) continue;
      const key = table.get(keyProperty);
      const parsedKey =
        typeof key === 'string' ? parseSyncableSourceKey(key) : undefined;
      if (
        table.error ||
        !table.hasClasses(dataBrowser.classes.table) ||
        !subjectsReferToSameResource(
          table.get(core.properties.classtype),
          rowClass,
        ) ||
        source.version !== 3 ||
        source.kind !== 'collection' ||
        source.resource !== resource ||
        typeof key !== 'string' ||
        !parsedKey ||
        parsedKey.version !== 3 ||
        !sourceConfigMatchesKey(source, parsedKey, key)
      )
        throw new Error(
          'The integration table identity changed during schema migration',
        );
      const tableState = () =>
        sourceConfigFingerprint([
          table.get(core.properties.parent),
          table.get(core.properties.isA),
          table.get(core.properties.classtype),
          table.get(configProperty),
          table.get(keyProperty),
          table.get(dataBrowser.properties.tableViews),
          table.get(dataBrowser.properties.tableDefaultView),
        ]);
      const tableStamp = tableState();
      const viewSubjects = [
        ...table.getSubjects(dataBrowser.properties.tableViews),
      ];
      const defaultView = table.get(dataBrowser.properties.tableDefaultView);

      if (defaultView !== undefined) {
        assertSyncableLocalSubject(store, defaultView);
        if (!viewSubjects.includes(defaultView)) viewSubjects.push(defaultView);
      }

      for (const viewSubject of new Set(viewSubjects)) {
        current();
        assertSyncableLocalSubject(store, viewSubject);
        if (!(await active(viewSubject))) continue;
        const view = await store.getResource(viewSubject);
        current();
        if (
          view.error ||
          !view.hasClasses(dataBrowser.classes.view) ||
          !subjectsReferToSameResource(
            view.get(core.properties.parent),
            table.subject,
          )
        )
          throw new Error('The saved table view identity changed');
        const identity = () =>
          sourceConfigFingerprint([
            view.get(core.properties.parent),
            view.get(core.properties.isA),
            view.get(configProperty),
            view.get(keyProperty),
          ]);
        const identityStamp = identity();
        const settings = [
          dataBrowser.properties.viewColumns,
          dataBrowser.properties.viewColumnOrder,
        ];
        const expected = new Map<string, JSONValue | undefined>(
          settings.map(property => [
            property,
            view.get(property) as JSONValue | undefined,
          ]),
        );

        const assertView = () => {
          current();
          assertSyncAppDrive(store, drive, table.subject);
          assertSyncAppDrive(store, drive, view.subject);
          if (
            tableState() !== tableStamp ||
            identity() !== identityStamp ||
            settings.some(
              property =>
                sourceConfigFingerprint(view.get(property)) !==
                sourceConfigFingerprint(expected.get(property)),
            )
          )
            throw new Error('The saved view changed during schema migration');
        };

        assertView();
        const updates = settings
          .map(
            property =>
              [
                property,
                replaceSyncableViewColumns(
                  expected.get(property),
                  replacements,
                ),
              ] as const,
          )
          .filter(([property, value]) => value !== expected.get(property));
        if (!updates.length) continue;
        const [canWrite] = await view.canWrite(actor);
        assertView();
        if (!canWrite) continue;

        for (const [property, value] of updates) {
          await view.set(
            property,
            value as string[],
            true,
            undefined,
            assertView,
          );
          expected.set(property, value);
          assertView();
        }

        await view.save();
        assertView();
      }
    }
  }
}

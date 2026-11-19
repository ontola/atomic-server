import { core, type JSONValue, type Resource, type Store } from '@tomic/react';
import {
  executeTableRowCreation,
  type TableCreationBackend,
} from '@tomic/table';
import { withTableRowDefaults } from './rowDefaults';

function equalJSON(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;

  return (
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every(
      key => Object.hasOwn(b, key) && equalJSON(a[key], b[key]),
    )
  );
}

/** Atomic retains its existing property validation and persisted/offline/no-op
 * save policy. Confirmation reads its live cache, not independent durability. */
export async function createAtomicTableRow(
  store: Store,
  table: string,
  rowClass: string,
  values: Record<string, JSONValue>,
): Promise<Resource> {
  let created: Resource | undefined;
  const backend: TableCreationBackend<Resource> = {
    schema: {},
    prepare: async command => {
      const propVals = await withTableRowDefaults(
        store,
        table,
        command.values as Record<string, JSONValue>,
      );

      // Explicit undefined suppresses a table default (the board's No status lane).
      for (const [id, value] of Object.entries(command.values)) {
        if (value === undefined) delete propVals[id];
      }

      created = await store.newResource({
        parent: table,
        isA: rowClass,
        propVals,
      });

      return {
        target: {
          subject: created.subject,
          scope: {
            collection: String(created.get(core.properties.parent) ?? ''),
            rowClass: created.hasClasses(rowClass) ? rowClass : '',
          },
        },
        values: propVals,
        handle: created,
      };
    },
    persist: async draft => {
      await draft.handle.save();
    },
    read: async target => {
      const row = await store.getResource(target.subject);

      return {
        target: {
          subject: row.subject,
          scope: {
            collection: String(row.get(core.properties.parent) ?? ''),
            rowClass: row.hasClasses(rowClass) ? rowClass : '',
          },
        },
        values: Object.fromEntries(row.getEntries()),
        handle: row,
      };
    },
    equals: equalJSON,
  };
  await executeTableRowCreation(
    { scope: { collection: table, rowClass }, values },
    backend,
  );
  store.notifyResourceManuallyCreated(created!);

  return created!;
}

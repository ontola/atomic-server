import {
  commits,
  core,
  useStore,
  type JSONValue,
  type Resource,
} from '@tomic/react';
import { useCallback } from 'react';
import { withTableRowDefaults } from '../rowDefaults';

/**
 * Creates a named row of the table's class, as a child of the table.
 * `createdAt` is set because a row without it does not appear in the table.
 * The table's row defaults apply underneath. `extra` presets further
 * properties (a board column's status, say) and wins over a default; a `null`
 * in `extra` leaves that property unset even when the table has a default for
 * it, which is what the board's "No status" lane needs.
 */
export function useCreateRow(
  tableSubject: string,
  tableClass: Resource,
): (name: string, extra?: Record<string, JSONValue>) => Promise<Resource> {
  const store = useStore();

  return useCallback(
    async (name: string, extra: Record<string, JSONValue> = {}) => {
      const propVals = await withTableRowDefaults(store, tableSubject, {
        [core.properties.name]: name,
        [commits.properties.createdAt]: Date.now(),
        ...extra,
      });

      for (const [property, value] of Object.entries(extra)) {
        if (value === null) {
          delete propVals[property];
        }
      }

      const row = await store.newResource({
        parent: tableSubject,
        isA: tableClass.subject,
        propVals,
      });
      await row.save();
      store.notifyResourceManuallyCreated(row);

      return row;
    },
    [store, tableSubject, tableClass],
  );
}

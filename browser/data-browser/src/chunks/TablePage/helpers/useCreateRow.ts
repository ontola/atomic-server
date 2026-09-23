import {
  commits,
  core,
  useStore,
  type JSONValue,
  type Resource,
} from '@tomic/react';
import { useCallback } from 'react';

/**
 * Creates a named row of the table's class, as a child of the table.
 * `createdAt` is set because a row without it does not appear in the table.
 * `extra` presets further properties (a board column's status, say).
 */
export function useCreateRow(
  tableSubject: string,
  tableClass: Resource,
): (name: string, extra?: Record<string, JSONValue>) => Promise<Resource> {
  const store = useStore();

  return useCallback(
    async (name: string, extra: Record<string, JSONValue> = {}) => {
      const row = await store.newResource({
        parent: tableSubject,
        isA: tableClass.subject,
        propVals: {
          [core.properties.name]: name,
          [commits.properties.createdAt]: Date.now(),
          ...extra,
        },
      });
      await row.save();
      store.notifyResourceManuallyCreated(row);

      return row;
    },
    [store, tableSubject, tableClass],
  );
}

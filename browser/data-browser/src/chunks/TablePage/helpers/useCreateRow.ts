import {
  commits,
  core,
  useStore,
  type JSONValue,
  type Resource,
} from '@tomic/react';
import { useCallback } from 'react';
import { createAtomicTableRow } from '../atomicCreateRow';

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
): (
  name: string,
  extra?: Record<string, JSONValue | null>,
) => Promise<Resource> {
  const store = useStore();

  return useCallback(
    async (name: string, extra: Record<string, JSONValue | null> = {}) => {
      const values: Record<string, JSONValue> = {
        [core.properties.name]: name,
        [commits.properties.createdAt]: Date.now(),
      };

      for (const [property, value] of Object.entries(extra)) {
        values[property] = value === null ? undefined : value;
      }

      return createAtomicTableRow(
        store,
        tableSubject,
        tableClass.subject,
        values,
      );
    },
    [store, tableSubject, tableClass],
  );
}

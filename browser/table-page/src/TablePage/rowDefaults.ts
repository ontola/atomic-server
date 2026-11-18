import {
  dataBrowser,
  type JSONObject,
  type JSONValue,
  type Resource,
  type Store,
} from '@tomic/react';

/**
 * The values a new row of a table starts with, keyed by property subject — a
 * Status column's Todo tag, say. Stored on the Table as `table-row-defaults`,
 * so it holds whichever view the row is added from: without it, a task added
 * on the calendar landed in a board's "No status" lane instead of Todo.
 */
export type RowDefaults = Record<string, JSONValue>;

export function readRowDefaults(table: Resource | undefined): RowDefaults {
  const value = table?.get(dataBrowser.properties.tableRowDefaults);

  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {};
  }

  return value as RowDefaults;
}

/**
 * Fills the table's defaults in under `propVals`. Anything the caller sets
 * explicitly wins, so a card added to a board lane keeps that lane's status.
 */
export function withRowDefaults(
  table: Resource | undefined,
  propVals: Record<string, JSONValue>,
): Record<string, JSONValue> {
  const defaults = readRowDefaults(table);
  const merged: Record<string, JSONValue> = {};

  for (const [property, value] of Object.entries(defaults)) {
    if (value !== undefined && value !== null) {
      merged[property] = structuredClone(value);
    }
  }

  for (const [property, value] of Object.entries(propVals)) {
    if (value !== undefined) {
      merged[property] = value;
    }
  }

  return merged;
}

/** {@link withRowDefaults}, for callers that only hold the table's subject. */
export async function withTableRowDefaults(
  store: Store,
  tableSubject: string,
  propVals: Record<string, JSONValue>,
): Promise<Record<string, JSONValue>> {
  try {
    return withRowDefaults(await store.getResource(tableSubject), propVals);
  } catch {
    // A default is a convenience: failing to read it must not stop the row.
    return propVals;
  }
}

/** Sets (or, with `undefined`, clears) one property's default and saves. */
export async function setRowDefault(
  table: Resource,
  property: string,
  value: JSONValue,
): Promise<void> {
  const next: JSONObject = { ...readRowDefaults(table) };

  if (value === undefined) {
    delete next[property];
  } else {
    next[property] = value;
  }

  await table.set(dataBrowser.properties.tableRowDefaults, next);
  await table.save();
}

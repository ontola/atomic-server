import type { JSONValue } from '@tomic/react';
import { reorderArray } from '@chunks/TableEditor';
import type { TableColumn } from './useTableColumns';

/**
 * The unit column order works in. A stored column is identified by its
 * property, so a LocalizedText property split into one column per language
 * moves as one thing; a column the view added has no property and is identified
 * by its own key (`derived:duration`, `timer-action`).
 */
export function orderKey(column: TableColumn): string {
  return column.property?.subject ?? column.key;
}

/** Reads a stored order, ignoring anything that isn't a list of keys. */
export function parseColumnOrder(value: JSONValue | undefined): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return (value as unknown[]).filter(
    (key): key is string => typeof key === 'string',
  );
}

/**
 * Puts columns in the view's configured order.
 *
 * Columns the order doesn't mention follow the ones it does, keeping their
 * relative order — so a column added after the order was saved shows up at the
 * end instead of disappearing (the same rule `view-columns` needed).
 */
export function orderColumns(
  columns: TableColumn[],
  order: string[],
): TableColumn[] {
  if (order.length === 0) {
    return columns;
  }

  const position = new Map(order.map((key, index) => [key, index]));

  return columns
    .map((column, index) => ({ column, index }))
    .sort((a, b) => {
      const aPos = position.get(orderKey(a.column));
      const bPos = position.get(orderKey(b.column));

      if (aPos === undefined && bPos === undefined) {
        return a.index - b.index;
      }

      // Unlisted goes after listed, never before: an unknown column must not
      // jump to the front of a carefully arranged table.
      if (aPos === undefined) {
        return 1;
      }

      if (bPos === undefined) {
        return -1;
      }

      return aPos - bPos;
    })
    .map(entry => entry.column);
}

/**
 * The order after dragging the column at `from` to `to` (both indexes into the
 * rendered list). Returns one key per column group, ready to store.
 */
export function reorderColumnKeys(
  columns: TableColumn[],
  from: number,
  to: number,
): string[] {
  // Deduplicated: a split LocalizedText property renders as several columns but
  // is one entry in the order.
  const keys: string[] = [];

  for (const column of columns) {
    const key = orderKey(column);

    if (!keys.includes(key)) {
      keys.push(key);
    }
  }

  const fromKey = columns[from] && orderKey(columns[from]);
  const toKey = columns[to] && orderKey(columns[to]);

  if (!fromKey || !toKey || fromKey === toKey) {
    return keys;
  }

  // Through the grid's own move semantics (remove, then insert at the target
  // position) so dragging a column behaves the same whichever kind it is.
  return reorderArray(keys, keys.indexOf(fromKey), keys.indexOf(toKey));
}

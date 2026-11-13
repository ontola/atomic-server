import { useMemo, useSyncExternalStore } from 'react';

/** Identity-only selection; hosts resolve authorized row operations themselves. */
export function createTableRowSelection(scope: string) {
  let rows: ReadonlySet<string> = new Set();
  const listeners = new Set<() => void>();

  const publish = (next: ReadonlySet<string>) => {
    rows = next;
    for (const notify of listeners) notify();
  };

  return {
    scope,
    getSnapshot: () => rows,
    subscribe: (notify: () => void) => {
      listeners.add(notify);

      return () => {
        listeners.delete(notify);
      };
    },
    toggle: (subject: string) => {
      const next = new Set(rows);
      if (!next.delete(subject)) next.add(subject);
      publish(next);
    },
    clear: () => {
      if (rows.size) publish(new Set());
    },
  };
}
/** A new scope creates a new service. Stale callbacks retain only their old service. */
export function useTableRowSelection(scope: string) {
  const selection = useMemo(() => createTableRowSelection(scope), [scope]);
  const selectedRows = useSyncExternalStore(
    selection.subscribe,
    selection.getSnapshot,
    selection.getSnapshot,
  );

  return {
    selectedRows,
    toggleRowSelected: selection.toggle,
    clearRowSelection: selection.clear,
  };
}

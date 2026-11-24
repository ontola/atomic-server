import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react';

interface RowSelectionScope {
  table: string;
  rowClass: string;
  queryKey: string;
  quickQuery: string;
  writable: boolean;
}

const EMPTY_ROWS: ReadonlySet<string> = new Set();

export function useTableRowSelection({
  table,
  rowClass,
  queryKey,
  quickQuery,
  writable,
}: RowSelectionScope) {
  const key = JSON.stringify([table, rowClass, queryKey, quickQuery]);
  const scope = useMemo(() => ({ key, writable }), [key, writable]);
  const activeScope = useRef<typeof scope | undefined>(undefined);
  const [selection, setSelection] = useState({ scope, rows: EMPTY_ROWS });

  useLayoutEffect(() => {
    activeScope.current = scope;

    return () => {
      activeScope.current = undefined;
    };
  }, [scope]);

  const canActOnRows = useCallback(
    () => scope.writable && activeScope.current === scope,
    [scope],
  );
  const selectedRows =
    writable && selection.scope === scope ? selection.rows : EMPTY_ROWS;

  const toggleRowSelected = useCallback(
    (subject: string) => {
      if (!canActOnRows()) return;
      setSelection(prev => {
        const next = new Set(prev.scope === scope ? prev.rows : EMPTY_ROWS);

        if (!next.delete(subject)) next.add(subject);

        return { scope, rows: next };
      });
    },
    [canActOnRows, scope],
  );

  const clearRowSelection = useCallback(() => {
    if (canActOnRows()) setSelection({ scope, rows: EMPTY_ROWS });
  }, [canActOnRows, scope]);

  return { selectedRows, toggleRowSelected, clearRowSelection, canActOnRows };
}

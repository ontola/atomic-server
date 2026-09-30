import { Collection } from '@tomic/react';
import { useCallback, useMemo, useRef, useState } from 'react';

export interface RowSelection {
  /** The subjects of the currently selected rows. */
  selected: ReadonlySet<string>;
  selectedList: string[];
  count: number;
  /** Every member matching the current filter is selected. */
  allSelected: boolean;
  /** Some, but not all, members are selected (for an indeterminate look). */
  someSelected: boolean;
  isSelected: (subject: string) => boolean;
  toggle: (subject: string) => void;
  deselect: (subject: string) => void;
  clear: () => void;
  /** Select every member matching the current filter (all pages). */
  selectAll: () => Promise<void>;
}

/**
 * Tracks which rows (by subject) are selected for bulk actions. Selection is
 * keyed by subject rather than grid index so it survives sorting, filtering
 * and deletion. "Select all" pulls every member of the collection — i.e.
 * everything matching the current filter, across all pages — not just the rows
 * currently rendered.
 */
export function useRowSelection(collection: Collection): RowSelection {
  const [selected, setSelected] = useState<Set<string>>(() => new Set());

  // Read the latest count without making callbacks depend on it (which would
  // re-create them, and with them the render slots, on every page load).
  const totalMembers = collection.totalMembers;
  const totalMembersRef = useRef(totalMembers);
  totalMembersRef.current = totalMembers;

  const isSelected = useCallback(
    (subject: string) => selected.has(subject),
    [selected],
  );

  const toggle = useCallback((subject: string) => {
    setSelected(prev => {
      const next = new Set(prev);

      if (next.has(subject)) {
        next.delete(subject);
      } else {
        next.add(subject);
      }

      return next;
    });
  }, []);

  const deselect = useCallback((subject: string) => {
    setSelected(prev => {
      if (!prev.has(subject)) {
        return prev;
      }

      const next = new Set(prev);
      next.delete(subject);

      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelected(prev => (prev.size === 0 ? prev : new Set()));
  }, []);

  const selectAll = useCallback(async () => {
    const members = await collection.getAllMembers();
    setSelected(new Set(members));
  }, [collection]);

  const selectedList = useMemo(() => Array.from(selected), [selected]);
  const count = selected.size;
  const allSelected = totalMembers > 0 && count >= totalMembers;
  const someSelected = count > 0 && !allSelected;

  return {
    selected,
    selectedList,
    count,
    allSelected,
    someSelected,
    isSelected,
    toggle,
    deselect,
    clear,
    selectAll,
  };
}

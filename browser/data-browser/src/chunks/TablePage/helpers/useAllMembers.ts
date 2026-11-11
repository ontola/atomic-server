import { useTableRowSubjects, type IndexedTableRows } from '@tomic/table';

/** Whole-result views require explicit backend enumeration support. */
export function useAllMembers(collection: IndexedTableRows): string[] {
  return useTableRowSubjects(collection).subjects;
}

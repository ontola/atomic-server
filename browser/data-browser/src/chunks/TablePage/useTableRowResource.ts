import { useResource, unknownSubject } from '@tomic/react';
import { useTableRowSubject, type TableRowSource } from '@tomic/table';

/** Atomic resource hydration is separate from shared row identity resolution. */
export function useTableRowResource(source: TableRowSource, index: number) {
  const { subject } = useTableRowSubject(source, index);

  return useResource(subject ?? unknownSubject);
}

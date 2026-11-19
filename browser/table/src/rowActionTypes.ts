import type { ReactNode } from 'react';

/** Existing closed row-action vocabulary, shared without a persistence dependency. */
export type RowActionKind = 'setNow' | 'setValue' | 'toggle' | 'increment';

export interface TableRowActionTarget {
  key: string;
  option: ReactNode;
  values?: readonly { key: string; option: ReactNode }[];
}
export interface TableRowActionKind {
  kind: RowActionKind;
  title: string;
  description: string;
  defaultLabel: string;
  valueField?: { label: string; input: 'number' | 'select' | 'text' };
  targets: readonly TableRowActionTarget[];
}

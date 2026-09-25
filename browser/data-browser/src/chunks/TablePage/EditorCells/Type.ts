import { JSONValue, Resource } from '@tomic/react';

import type { JSX } from 'react';

export interface EditCellProps<T extends JSONValue> {
  value: T;
  onChange: (value: T) => void;
  property: string;
  resource: Resource;
  /** For a split-by-language column: the single language tag this cell edits */
  languageTag?: string;
  /**
   * The character typed on the selected cell that opened this editor, for an
   * editor that takes it as text rather than as a value (see
   * `textSeededDatatypes` in TableCell). The editor starts from it instead of
   * the stored value, and stores nothing until that text is committed.
   */
  seed?: string;
}

export interface DisplayCellProps<T extends JSONValue> {
  value: T;
  onChange: (value: T) => void;
  property: string;
  /** For a split-by-language column: the single language tag this cell shows */
  languageTag?: string;
}

export type CellContainer<T extends JSONValue> = {
  Edit: (props: EditCellProps<T>) => JSX.Element;
  Display: (props: DisplayCellProps<T>) => JSX.Element;
};

export interface ResourceCellProps {
  subject: string;
}

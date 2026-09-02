import { JSONValue, Resource } from '@tomic/react';

import type { JSX } from 'react';

export interface EditCellProps<T extends JSONValue> {
  value: T;
  onChange: (value: T) => void;
  property: string;
  resource: Resource;
  /** For a split-by-language column: the single language tag this cell edits */
  languageTag?: string;
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

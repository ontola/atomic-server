import type { JSONValue } from '../../../value.js';

import { Checkbox } from '../../../components/forms/Checkbox.js';
import type { CellContainer, DisplayCellProps, EditCellProps } from './Type.js';

import type { JSX } from 'react';

function BooleanCellEdit({
  value,
  onChange,
}: EditCellProps<JSONValue>): JSX.Element {
  return <Checkbox autoFocus checked={Boolean(value)} onChange={onChange} />;
}

function BooleanCellDisplay({
  value,
  onChange,
}: DisplayCellProps<JSONValue>): JSX.Element {
  return <Checkbox checked={Boolean(value)} onChange={onChange} />;
}

export const BooleanCell: CellContainer<JSONValue> = {
  Edit: BooleanCellEdit,
  Display: BooleanCellDisplay,
};

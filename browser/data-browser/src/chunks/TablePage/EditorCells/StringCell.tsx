import { JSONValue } from '@tomic/react';

import { InputBase } from './InputBase';
import { CellContainer, DisplayCellProps, EditCellProps } from './Type';

import type { JSX } from 'react';

function StringCellEdit({
  value,
  onChange,
}: EditCellProps<JSONValue>): JSX.Element {
  return (
    <InputBase
      value={value as string}
      autoFocus
      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
        onChange(e.target.value)
      }
    />
  );
}

function StringCellDisplay({
  value,
}: DisplayCellProps<JSONValue>): JSX.Element {
  return <>{value}</>;
}

export const StringCell: CellContainer<JSONValue> = {
  Edit: StringCellEdit,
  Display: StringCellDisplay,
};

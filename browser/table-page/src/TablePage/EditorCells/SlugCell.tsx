import { JSONValue } from '@tomic/react';
import { useCallback, type JSX } from 'react';
import { InputBase } from './InputBase.js';
import { CellContainer, DisplayCellProps, EditCellProps } from './Type.js';

function SlugCellEdit({
  value,
  onChange,
}: EditCellProps<JSONValue>): JSX.Element {
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const v = e.target.value.toLowerCase().replace(/\s/g, '-');

      if (v === '') {
        onChange(undefined);

        return;
      }

      onChange(v);
    },
    [onChange],
  );

  return (
    <InputBase
      value={(value as string | undefined) ?? ''}
      autoFocus
      onChange={handleChange}
    />
  );
}

function SlugCellDisplay({ value }: DisplayCellProps<JSONValue>): JSX.Element {
  return <>{value}</>;
}

export const SlugCell: CellContainer<JSONValue> = {
  Edit: SlugCellEdit,
  Display: SlugCellDisplay,
};

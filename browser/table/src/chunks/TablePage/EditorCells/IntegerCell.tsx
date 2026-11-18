import type { JSONValue } from '../../../value.js';

import { styled } from 'styled-components';
import { InputBase } from './InputBase.js';
import type { CellContainer, DisplayCellProps, EditCellProps } from './Type.js';
import { useCommittedText } from './useCommittedText.js';
import { formatNumberInput, parseInteger } from './numberInput.js';

import type { JSX } from 'react';

function IntegerCellEdit({
  value,
  onChange,
  seed,
  textDraft,
}: EditCellProps<JSONValue>): JSX.Element {
  // Text, not `type='number'`: that one reads a lone `-` or `.` as empty, so
  // a number could not start with one.
  const input = useCommittedText({
    value,
    onChange,
    seed,
    textDraft,
    format: formatNumberInput,
    parse: parseInteger,
  });

  return <InputBase type='text' inputMode='numeric' autoFocus {...input} />;
}

function IntegerCellDisplay({
  value,
}: DisplayCellProps<JSONValue>): JSX.Element {
  return <Aligned>{typeof value === 'number' ? String(value) : ''}</Aligned>;
}

export const IntegerCell: CellContainer<JSONValue> = {
  Edit: IntegerCellEdit,
  Display: IntegerCellDisplay,
};

const Aligned = styled.span`
  text-align: end;
  display: inline-block;
  width: 100%;
`;

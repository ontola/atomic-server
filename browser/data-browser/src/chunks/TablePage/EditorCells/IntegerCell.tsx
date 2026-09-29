import { JSONValue, urls, useResource, useString } from '@tomic/react';

import { styled } from 'styled-components';
import { InputBase } from './InputBase';
import { ProgressBar } from './ProgressBar';
import { CellContainer, DisplayCellProps, EditCellProps } from './Type';
import { useCommittedText } from './useCommittedText';
import { formatNumberInput, parseInteger } from './numberInput';
import { formatNumber } from '../helpers/formatNumber';

import type { JSX } from 'react';

const { numberFormats } = urls.instances;

function IntegerCellEdit({
  value,
  onChange,
  seed,
}: EditCellProps<JSONValue>): JSX.Element {
  // Text, not `type='number'`: that one reads a lone `-` or `.` as empty, so
  // a number could not start with one.
  const input = useCommittedText({
    value,
    onChange,
    seed,
    format: formatNumberInput,
    parse: parseInteger,
  });

  return <InputBase type='text' inputMode='numeric' autoFocus {...input} />;
}

function IntegerCellDisplay({
  value,
  property,
}: DisplayCellProps<JSONValue>): JSX.Element {
  const propertyResource = useResource(property);
  const [numberFormatting] = useString(
    propertyResource,
    urls.properties.constraints.numberFormatting,
  );

  const isPercentage = numberFormatting === numberFormats.percentage;

  return (
    <>
      <Aligned>
        {formatNumber(value as number | undefined, 0, numberFormatting)}
      </Aligned>
      {isPercentage && <ProgressBar percentage={value as number} />}
    </>
  );
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

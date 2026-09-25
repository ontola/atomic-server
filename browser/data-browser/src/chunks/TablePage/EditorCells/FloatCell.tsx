import {
  JSONValue,
  dataBrowser,
  urls,
  useNumber,
  useResource,
  useString,
} from '@tomic/react';

import { styled } from 'styled-components';
import { InputBase } from './InputBase';
import { ProgressBar } from './ProgressBar';
import { CellContainer, DisplayCellProps, EditCellProps } from './Type';
import { useCommittedText } from './useCommittedText';
import { formatNumberInput, parseFloatText } from './numberInput';
import { formatNumber } from '../helpers/formatNumber';

import type { JSX } from 'react';

const { numberFormats } = urls.instances;

function FloatCellEdit({
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
    parse: parseFloatText,
  });

  return <InputBase type='text' inputMode='decimal' autoFocus {...input} />;
}

function FloatCellDisplay({
  value,
  property,
}: DisplayCellProps<JSONValue>): JSX.Element {
  const propertyResource = useResource(property);
  const [numberFormatting] = useString(
    propertyResource,
    urls.properties.constraints.numberFormatting,
  );
  const [decimalPlaces] = useNumber(
    propertyResource,
    urls.properties.constraints.decimalPlaces,
  );

  const [currency] = useString(
    propertyResource,
    dataBrowser.properties.currency,
  );

  const isPercentage = numberFormatting === numberFormats.percentage;

  const formattedValue = formatNumber(
    value as number | undefined,
    decimalPlaces,
    numberFormatting,
    currency,
  );

  return (
    <>
      <Aligned>{value !== undefined && formattedValue}</Aligned>
      {isPercentage && <ProgressBar percentage={value as number} />}
    </>
  );
}

export const FloatCell: CellContainer<JSONValue> = {
  Edit: FloatCellEdit,
  Display: FloatCellDisplay,
};

const Aligned = styled.span`
  text-align: end;
  display: inline-block;
  width: 100%;
`;

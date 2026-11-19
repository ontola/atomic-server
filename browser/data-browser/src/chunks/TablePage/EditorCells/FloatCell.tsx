import {
  JSONValue,
  dataBrowser,
  urls,
  useNumber,
  useResource,
  useString,
} from '@tomic/react';

import { styled } from 'styled-components';
import { FloatCell as SharedFloatCell } from '@tomic/table';
import { ProgressBar } from './ProgressBar';
import { CellContainer, DisplayCellProps } from './Type';
import { formatNumber } from '../helpers/formatNumber';

import type { JSX } from 'react';

const { numberFormats } = urls.instances;

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
  Edit: SharedFloatCell.Edit,
  Display: FloatCellDisplay,
};

const Aligned = styled.span`
  text-align: end;
  display: inline-block;
  width: 100%;
`;

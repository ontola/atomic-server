import { IntegerCell as SharedCell } from '@tomic/table';
import { JSONValue, urls, useResource, useString } from '@tomic/react';

import { styled } from 'styled-components';
import { ProgressBar } from './ProgressBar';
import { CellContainer, DisplayCellProps } from './Type';
import { formatNumber } from '../helpers/formatNumber';

import type { JSX } from 'react';

const { numberFormats } = urls.instances;

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
  Edit: SharedCell.Edit,
  Display: IntegerCellDisplay,
};

const Aligned = styled.span`
  text-align: end;
  display: inline-block;
  width: 100%;
`;

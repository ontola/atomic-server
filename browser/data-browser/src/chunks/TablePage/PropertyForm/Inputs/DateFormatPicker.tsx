import { urls } from '@tomic/react';
import { PropertyDateFormatField } from '@tomic/table';
import { RadioInput } from '@components/forms/RadioInput';
import { formatDate } from '@helpers/dates/formatDate';
import type { JSX } from 'react';
const {
  instances: { dateFormats },
} = urls;
const EXAMPLE_DATE = new Date(Date.now() - 1000 * 60 * 60 * 15);

/** Atomic format IDs and locale formatter; the choices/previews are shared. */
export function DateFormatPicker({
  value,
  onChange,
  withTime = false,
}: {
  value?: string;
  onChange: (value: string) => void;
  withTime?: boolean;
}): JSX.Element {
  return (
    <PropertyDateFormatField
      value={value}
      onChange={onChange}
      Radio={RadioInput}
      label='Date format'
      options={[
        {
          value: dateFormats.localNumeric,
          label: 'Numeric',
          example: formatDate(dateFormats.localNumeric, EXAMPLE_DATE, withTime),
        },
        {
          value: dateFormats.localLong,
          label: 'Long',
          example: formatDate(dateFormats.localLong, EXAMPLE_DATE, withTime),
        },
        {
          value: dateFormats.localRelative,
          label: 'Relative',
          example: formatDate(
            dateFormats.localRelative,
            EXAMPLE_DATE,
            withTime,
          ),
        },
      ]}
    />
  );
}

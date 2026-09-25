import {
  isString,
  JSONValue,
  urls,
  useResource,
  useString,
} from '@tomic/react';
import type { JSX } from 'react';
import { formatDate } from '@helpers/dates/formatDate';
import {
  dateInputPlaceholder,
  formatDateInput,
  parseDateInput,
} from '@helpers/dates/dateInput';
import { InputBase } from './InputBase';
import { CellContainer, DisplayCellProps, EditCellProps } from './Type';
import { UNPARSED, useCommittedText } from './useCommittedText';

/**
 * A text input rather than `<input type="date">`. The native one needed a
 * zero-padded day ("01": after "1" it waits for a second digit) and emitted a
 * change per segment, so typing the year stored 0002-10-01, 0020-10-01 and so
 * on. This one reads `2/10/2026` (the locale's order) or `2026-10-2`, and
 * stores the date once: on Enter or Tab, or when the cell closes any other way.
 */
function DateCellEdit({
  value,
  onChange,
  seed,
}: EditCellProps<JSONValue>): JSX.Element {
  // Typing on the selected cell opens it with that character, which is not a
  // date yet: it is only text until Enter, Tab or closing commits it.
  const input = useCommittedText({
    value,
    onChange,
    seed,
    format: formatDateInput,
    parse: parseDate,
  });

  return (
    <InputBase
      type='text'
      inputMode='numeric'
      autoFocus
      placeholder={dateInputPlaceholder()}
      {...input}
    />
  );
}

const parseDate = (text: string) => parseDateInput(text) ?? UNPARSED;

const toDisplayData = (value: JSONValue, format: string) => {
  if (isString(value)) {
    const valueWithTime = `${value}T00:00:00`;
    const date = new Date(valueWithTime);

    return formatDate(format, date, false);
  }
};

function DateCellDisplay({
  value,
  property,
}: DisplayCellProps<JSONValue>): JSX.Element {
  const propertyResource = useResource(property);
  const [format] = useString(
    propertyResource,
    urls.properties.constraints.dateFormat,
  );

  const displayData = toDisplayData(
    value,
    format ?? urls.instances.dateFormats.localNumeric,
  );

  return <>{displayData}</>;
}

export const DateCell: CellContainer<JSONValue> = {
  Edit: DateCellEdit,
  Display: DateCellDisplay,
};

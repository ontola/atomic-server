import type { JSONValue } from '../../../value.js';
import type { JSX } from 'react';
import { calendarDateToLocalDate } from '../../../helpers/dates/calendarDate.js';
import {
  dateInputPlaceholder,
  formatDateInput,
  parseDateInput,
} from '../../../helpers/dates/dateInput.js';
import { InputBase } from './InputBase.js';
import type { CellContainer, DisplayCellProps, EditCellProps } from './Type.js';
import { UNPARSED, useCommittedText } from './useCommittedText.js';

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
  textDraft,
}: EditCellProps<JSONValue>): JSX.Element {
  // Typing on the selected cell opens it with that character, which is not a
  // date yet: it is only text until Enter, Tab or closing commits it.
  const input = useCommittedText({
    value,
    onChange,
    seed,
    textDraft,
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

function DateCellDisplay({ value }: DisplayCellProps<JSONValue>): JSX.Element {
  const date = calendarDateToLocalDate(value);

  return <>{date ? date.toLocaleDateString() : String(value ?? '')}</>;
}

export const DateCell: CellContainer<JSONValue> = {
  Edit: DateCellEdit,
  Display: DateCellDisplay,
};

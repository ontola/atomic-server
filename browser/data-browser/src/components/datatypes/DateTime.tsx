import { toRelativeDateTime } from '@helpers/dates/relativeDate';
import { formatCalendarDate } from '@helpers/dates/calendarDate';
import type { JSX } from 'react';
type Props = {
  date: Date;
};

/** Renders a Date value */
export function DateTime({ date }: Props): JSX.Element {
  return (
    <time dateTime={date.toISOString()}>
      {date.toLocaleDateString()} at {date.toLocaleTimeString()}
    </time>
  );
}

/** Renders a `date` value: a civil date, with no time and no zone. */
export function CalendarDate({ value }: { value: string }): JSX.Element {
  return <time dateTime={value}>{formatCalendarDate(value)}</time>;
}

export function DateTimeRelative({ date }: Props): JSX.Element {
  const relativeDate = toRelativeDateTime(date, true);

  return <time dateTime={date.toISOString()}>{relativeDate}</time>;
}

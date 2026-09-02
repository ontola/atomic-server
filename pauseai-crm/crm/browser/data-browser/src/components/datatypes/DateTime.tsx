import { toRelativeDateTime } from '@helpers/dates/relativeDate';
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

export function DateTimeRelative({ date }: Props): JSX.Element {
  const relativeDate = toRelativeDateTime(date, true);

  return <time dateTime={date.toISOString()}>{relativeDate}</time>;
}

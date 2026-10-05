import type { Resource } from '@tomic/react';
import type { JSX, ReactNode } from 'react';
import { readRowRepeat, type CalendarRowContext } from './CalendarRowFields';
import { describeRepeat } from './repeatSummary';

/** A table cell's view of a row's recurrence: the Repeat field's summary,
 * read-only. Without a day to repeat from, the raw value (`fallback`). */
export function RepeatSummaryCell({
  resource,
  calendar,
  fallback,
}: {
  resource: Resource;
  calendar: CalendarRowContext;
  fallback: ReactNode;
}): JSX.Element {
  if (
    !calendar.recurrenceProp ||
    resource.get(calendar.recurrenceProp.subject) === undefined
  ) {
    return <></>;
  }

  const { anchor, parsed } = readRowRepeat(
    resource.subject,
    prop => resource.get(prop),
    calendar,
  );

  if (!anchor) return <>{fallback}</>;

  return (
    <span data-testid='repeat-cell'>{describeRepeat(parsed, anchor)}</span>
  );
}

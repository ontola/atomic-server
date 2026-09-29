/** Times of day for calendar rows. A timed row keeps its exact start and end
 * as RFC 3339 strings with their UTC offset (`atomic-calendar-start` /
 * `atomic-calendar-end` in the atomic-plugins Event ontology), and is shown
 * on the viewer's local day, in the viewer's local time. */
import { Temporal } from '@js-temporal/polyfill';
import { isCalendarDate } from './calendar-date.js';

const RFC3339 =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/i;

/** An exact instant with its offset, as the Start / End columns hold it. */
export function isCalendarInstant(value: unknown): value is string {
  if (typeof value !== 'string' || !RFC3339.test(value)) return false;

  try {
    Temporal.Instant.from(value);

    return true;
  } catch {
    return false;
  }
}

/** The zone the viewer's calendar is shown in. */
export function viewerTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/** The civil date (YYYY-MM-DD) an instant falls on in `timeZone`. */
export function dayInZone(ms: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(ms)
    .toZonedDateTimeISO(timeZone)
    .toPlainDate()
    .toString();
}

/** "HH:MM" of an instant in `timeZone`, as a time input holds it. */
export function timeInZone(value: string | number, timeZone: string): string {
  const instant =
    typeof value === 'number'
      ? Temporal.Instant.fromEpochMilliseconds(value)
      : Temporal.Instant.from(value);

  return instant
    .toZonedDateTimeISO(timeZone)
    .toPlainTime()
    .toString({ smallestUnit: 'minute' });
}

/** `day` at wall time `time` (HH:MM) in `timeZone`, as RFC 3339 with that
 * moment's offset. A time skipped by a DST change moves forward. */
export function calendarInstant(
  day: string,
  time: string,
  timeZone: string,
): string {
  if (!isCalendarDate(day)) throw new Error('Invalid date');
  const zoned = Temporal.PlainDate.from(day).toZonedDateTime({
    timeZone,
    plainTime: Temporal.PlainTime.from(time),
  });

  return zoned.toString({
    smallestUnit: 'second',
    timeZoneName: 'never',
  });
}

/** The same wall time and offset, `days` later: how a timed row follows its
 * Day when that is moved on its own. */
export function shiftInstantDays(value: string, days: number): string {
  if (!days) return value;
  const offset = /(Z|[+-]\d{2}:\d{2})$/i.exec(value)![1];
  const wall = Temporal.PlainDateTime.from(value.slice(0, -offset.length));

  return `${wall.add({ days }).toString({ smallestUnit: 'second' })}${offset.toUpperCase() === 'Z' ? 'Z' : offset}`;
}

/** Whole days from one civil date to another. */
export function daysBetween(from: string, to: string): number {
  return Temporal.PlainDate.from(from).until(Temporal.PlainDate.from(to)).days;
}

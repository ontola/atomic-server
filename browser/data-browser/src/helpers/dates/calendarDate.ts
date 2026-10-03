import { isCalendarDate } from '@tomic/react';

/**
 * A `date` value (`YYYY-MM-DD`) is a civil date: it has no time and no zone.
 * `new Date('2026-10-02')` reads it as UTC midnight, which shows as 02:00 in
 * Amsterdam and as the day before in New York. Build local midnight of the
 * same day instead, so formatting it in the local zone gives back that day.
 *
 * Returns undefined for anything that is not a valid civil date.
 */
export function calendarDateToLocalDate(value: unknown): Date | undefined {
  if (!isCalendarDate(value)) {
    return undefined;
  }

  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(year, month - 1, day);
  // Two-digit years would otherwise be mapped to 19xx.
  date.setFullYear(year);

  return date;
}

/**
 * Formats a civil date without a time. Falls back to the raw value when it is
 * not a `YYYY-MM-DD` string, rather than guessing at an instant.
 */
export function formatCalendarDate(
  value: unknown,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = calendarDateToLocalDate(value);

  if (!date) {
    return String(value ?? '');
  }

  return date.toLocaleDateString(undefined, options);
}

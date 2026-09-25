import {
  expandCalendar,
  isAllDayOnDate,
  type CalendarRecord,
  type CalendarOccurrence,
} from '@tomic/lib';

export { matchesCalendarField as calendarPropertyMatches } from '@tomic/lib';

/** A row whose recurrence payload could not be expanded, and why. */
export interface InvalidCalendarRecord {
  subject: string;
  message: string;
}

/** Records only affect each other within one series (a master and its
 * exceptions share `calendarId` + master id), so expanding per series keeps
 * one bad payload from taking every other meeting down with it. */
function seriesKey(record: CalendarRecord): string {
  const event = record.event as Partial<CalendarRecord['event']> | undefined;

  return JSON.stringify([
    record.calendarId,
    event?.recurringEventId ?? event?.id ?? record.subject,
  ]);
}

export function calendarOccurrenceBuckets(
  records: CalendarRecord[],
  days: string[],
) {
  const buckets = new Map<string, CalendarOccurrence[]>();
  const invalid: InvalidCalendarRecord[] = [];
  if (!days.length || !records.length) return { buckets, invalid };
  // Per-series expansion must not sidestep expandCalendar's own size guard.
  if (records.length > 5000) throw new Error('Too many calendar records');
  // The view groups by the event's civil day, not the browser's timezone.
  // Include offset margins before assigning actual civil dates to cells.
  const from = Date.parse(`${days[0]}T00:00:00Z`) - 86400000;
  const to = Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 2 * 86400000;

  const series = new Map<string, CalendarRecord[]>();

  for (const record of records) {
    const key = seriesKey(record);
    series.set(key, [...(series.get(key) ?? []), record]);
  }

  const occurrences: CalendarOccurrence[] = [];

  for (const group of series.values()) {
    try {
      occurrences.push(...expandCalendar(group, from, to));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      for (const record of group) {
        invalid.push({ subject: record.subject, message });
      }
    }
  }

  occurrences.sort((a, b) => a.start - b.start || a.key.localeCompare(b.key));

  for (const occurrence of occurrences) {
    for (const day of days) {
      if (
        occurrence.allDay
          ? isAllDayOnDate(occurrence.day, occurrence.endDay, day)
          : occurrence.day === day
      ) {
        buckets.set(day, [...(buckets.get(day) ?? []), occurrence]);
      }
    }
  }

  return { buckets, invalid };
}

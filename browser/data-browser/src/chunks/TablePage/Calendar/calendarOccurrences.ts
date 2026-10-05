import {
  dayInZone,
  expandCalendar,
  viewerTimeZone,
} from '@tomic/lib/calendar-recurrence.js';
import {
  isAllDayOnDate,
  nextCalendarDate,
  type CalendarRecord,
  type CalendarOccurrence,
  type CalendarTime,
} from '@tomic/lib';

export { matchesCalendarField as calendarPropertyMatches } from '@tomic/lib';

/** A row whose recurrence payload could not be expanded, and why. */
export interface InvalidCalendarRecord {
  subject: string;
  message: string;
}

/** An occurrence on one day of the grid. An instance moved to another day
 * (`recurringEventId` + `originalStartTime`) appears twice: as itself on its
 * new day, with `movedFrom`, and as a placeholder on the day it used to be,
 * with `movedTo`. Both share the original instance's `key`. */
export interface CalendarDayOccurrence extends CalendarOccurrence {
  /** Moved here from this day (YYYY-MM-DD). */
  movedFrom?: string;
  /** A placeholder: this instance moved to that day (YYYY-MM-DD). */
  movedTo?: string;
  /** Has a time of day: its chip shows `start` in local time. */
  timed?: boolean;
}

/** The day of a start time on the grid: an all-day event's date, or the
 * viewer's local day of a timed one (#1802), like Google Calendar. */
function civilDay(time: CalendarTime | undefined, viewerZone: string) {
  if (time?.date) return time.date;
  if (!time?.dateTime) return undefined;

  return dayInZone(Date.parse(time.dateTime), viewerZone);
}

/** The moves in one series, keyed like `CalendarOccurrence.key`: the
 * original instance's [calendarId, series id, original start]. */
function seriesMoves(group: CalendarRecord[], viewerZone: string) {
  const moves = new Map<
    string,
    { record: CalendarRecord; from: string; to: string; start: number }
  >();

  for (const record of group) {
    const { event, calendarId } = record;
    if (!event.recurringEventId || event.status === 'cancelled') continue;
    const master = group.find(
      other =>
        !other.event.recurringEventId &&
        other.event.id === event.recurringEventId,
    )?.event;
    if (master?.status === 'cancelled') continue;
    const from = civilDay(event.originalStartTime, viewerZone);
    const to = civilDay(event.start, viewerZone);
    if (!from || !to || from === to) continue;
    const original = event.originalStartTime!;
    const start = Date.parse(
      original.date ? `${original.date}T00:00:00Z` : original.dateTime!,
    );
    moves.set(JSON.stringify([calendarId, event.recurringEventId, start]), {
      record,
      from,
      to,
      start,
    });
  }

  return moves;
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

/** Each grid day's occurrences. All-day events keep their dates and
 * exclusive end; timed ones go on the viewer's local day (`viewerZone`). */
export function calendarOccurrenceBuckets(
  records: CalendarRecord[],
  days: string[],
  viewerZone: string = viewerTimeZone(),
) {
  const buckets = new Map<string, CalendarDayOccurrence[]>();
  const invalid: InvalidCalendarRecord[] = [];
  if (!days.length || !records.length) return { buckets, invalid };
  // Per-series expansion must not sidestep expandCalendar's own size guard.
  if (records.length > 5000) throw new Error('Too many calendar records');
  // Include offset margins before assigning local days to cells.
  const from = Date.parse(`${days[0]}T00:00:00Z`) - 86400000;
  const to = Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 2 * 86400000;

  const series = new Map<string, CalendarRecord[]>();

  for (const record of records) {
    const key = seriesKey(record);
    series.set(key, [...(series.get(key) ?? []), record]);
  }

  const occurrences: CalendarDayOccurrence[] = [];
  const dayKeys = new Set(days);

  for (const group of series.values()) {
    try {
      const expanded = expandCalendar(group, from, to);
      const moves = seriesMoves(group, viewerZone);

      for (const expandedOccurrence of expanded) {
        const occurrence = expandedOccurrence.allDay
          ? expandedOccurrence
          : {
              ...expandedOccurrence,
              day: dayInZone(expandedOccurrence.start, viewerZone),
              endDay: dayInZone(expandedOccurrence.end, viewerZone),
            };
        const move = moves.get(occurrence.key);
        occurrences.push(
          move ? { ...occurrence, movedFrom: move.from } : occurrence,
        );
      }

      // The original day gets a placeholder even when the new day is outside
      // the grid (the expansion already hides the original either way).
      for (const [key, move] of moves) {
        if (!dayKeys.has(move.from)) continue;
        const allDay = !!move.record.event.start?.date;
        occurrences.push({
          key,
          subject: move.record.subject,
          start: move.start,
          end: move.start,
          day: move.from,
          endDay: allDay ? nextCalendarDate(move.from) : move.from,
          allDay,
          recurring: true,
          movedTo: move.to,
        });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      for (const record of group) {
        invalid.push({ subject: record.subject, message });
      }
    }
  }

  occurrences.sort(
    (a, b) =>
      a.start - b.start ||
      a.key.localeCompare(b.key) ||
      Number(!!a.movedTo) - Number(!!b.movedTo),
  );

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

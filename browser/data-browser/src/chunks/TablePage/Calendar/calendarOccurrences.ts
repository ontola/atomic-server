import {
  expandCalendar,
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
}

/** The civil day of a start time: its date, or the date on the wall clock of
 * its own zone, else the series' zone, else as written. Mirrors how the
 * expansion places occurrences (`eventDay` in @tomic/lib). */
function civilDay(time: CalendarTime | undefined, fallbackZone?: string) {
  if (time?.date) return time.date;
  if (!time?.dateTime) return undefined;
  const zone = time.timeZone ?? fallbackZone;
  if (!zone) return time.dateTime.slice(0, 10);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    })
      .formatToParts(new Date(time.dateTime))
      .map(part => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
}

/** The moves in one series, keyed like `CalendarOccurrence.key`: the
 * original instance's [calendarId, series id, original start]. */
function seriesMoves(group: CalendarRecord[]) {
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
    const zone = master?.start?.timeZone;
    const from = civilDay(event.originalStartTime, zone);
    const to = civilDay(event.start, zone);
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

export function calendarOccurrenceBuckets(
  records: CalendarRecord[],
  days: string[],
) {
  const buckets = new Map<string, CalendarDayOccurrence[]>();
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

  const occurrences: CalendarDayOccurrence[] = [];
  const dayKeys = new Set(days);

  for (const group of series.values()) {
    try {
      const expanded = expandCalendar(group, from, to);
      const moves = seriesMoves(group);

      for (const occurrence of expanded) {
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

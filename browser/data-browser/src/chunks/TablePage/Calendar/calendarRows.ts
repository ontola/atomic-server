import {
  Datatype,
  anchorOf,
  buildRecurrence,
  isCalendarDate,
  nativeCalendarId,
  nextCalendarDate,
  parseRecurrence,
  weekdayOf,
  type CalendarRecord,
  type CalendarTime,
} from '@tomic/lib';

/** A recurrence payload as stored on a row, without the row's subject. */
export type RecurrencePayload = Omit<CalendarRecord, 'subject'>;

/** The payload in a row's recurrence value, or undefined when there is none.
 * Also reads a payload that was saved as a JSON-encoded string. */
export function readRecurrencePayload(
  value: unknown,
): RecurrencePayload | undefined {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    'event' in value
  ) {
    return value as RecurrencePayload;
  }

  return undefined;
}

/** A series the Repeat control wrote for this row, not an imported one. */
export function isNativePayload(payload: RecurrencePayload): boolean {
  return payload.calendarId === nativeCalendarId;
}

/** When a row takes place, from its own columns. */
export interface CalendarRowTime {
  start: CalendarTime;
  end: CalendarTime;
}

/** An all-day row: its day, until its exclusive end day when that is a later
 * date, else for that one day. */
export function allDayRowTime(day: string, endDay?: unknown): CalendarRowTime {
  const end =
    isCalendarDate(endDay) && endDay > day ? endDay : nextCalendarDate(day);

  return { start: { date: day }, end: { date: end } };
}

/** The record the calendar expands for a row. An imported payload is the
 * provider's, as stored. A native one follows the row: its id, start and end
 * come from the row's columns, and a rule the Repeat control can show is
 * rewritten for that start, so a moved row takes its series with it. */
export function rowRecord(
  subject: string,
  payload: RecurrencePayload,
  time: CalendarRowTime,
): CalendarRecord {
  if (!isNativePayload(payload)) {
    return { ...payload, subject };
  }

  let recurrence = payload.event.recurrence;

  try {
    const from = anchorOf(payload.event.start ?? time.start);
    const to = anchorOf(time.start);
    const parsed = parseRecurrence(recurrence, from);

    if (parsed.kind === 'rule') {
      const { rule } = parsed;

      // "Every Thursday" because it started on one: a Friday start makes it
      // every Friday. Several chosen days stay as chosen.
      if (
        rule.frequency === 'weekly' &&
        rule.weekdays.length === 1 &&
        rule.weekdays[0] === weekdayOf(from.date)
      ) {
        rule.weekdays = [weekdayOf(to.date)];
      }

      recurrence = buildRecurrence(rule, to);
    }
  } catch {
    // Not a rule the control reads: expand it as written.
  }

  return {
    calendarId: payload.calendarId,
    subject,
    event: {
      ...payload.event,
      id: subject,
      start: time.start,
      end: time.end,
      recurrence,
    },
  };
}

/** Local YYYY-MM-DD key of an instant (not toISOString, which is UTC). */
export function localDayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${date.getFullYear()}-${month}-${day}`;
}

const DATE_PREFIX_REGEX = /^\d{4}-\d{2}-\d{2}/;

/** The (local) day a stored date or timestamp value falls on. */
export function valueToDayKey(
  value: unknown,
  datatype: string | undefined,
): string | undefined {
  if (datatype === Datatype.TIMESTAMP && typeof value === 'number') {
    return localDayKey(new Date(value));
  }

  if (typeof value === 'string' && DATE_PREFIX_REGEX.test(value)) {
    return value.slice(0, 10);
  }

  return undefined;
}

interface Column {
  subject: string;
  datatype?: string;
}

/** The columns a calendar view reads a row's place and series from. */
export interface CalendarColumns {
  dateProp: Column;
  allDayProp?: Column;
  endDayProp?: Column;
  /** The date column is the calendar's own Day, so All day and End day
   * apply. Imported ranges are opt-in: other date columns stay one day. */
  calendarDate: boolean;
  recurrenceProp?: Column;
}

/** When a row takes place, from its columns; undefined without a date. */
export function calendarRowTime(
  get: (property: string) => unknown,
  columns: CalendarColumns,
): CalendarRowTime | undefined {
  const { dateProp, allDayProp, endDayProp, calendarDate } = columns;
  const day = valueToDayKey(get(dateProp.subject), dateProp.datatype);

  if (!day) return undefined;

  const ranged = calendarDate && allDayProp && get(allDayProp.subject) === true;

  return allDayRowTime(
    day,
    ranged && endDayProp ? get(endDayProp.subject) : undefined,
  );
}

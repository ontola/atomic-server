/** The Repeat control's model of a recurrence, and the RFC 5545 lines it
 * reads and writes. Only what the control can show round-trips; anything
 * else (exception dates, set positions, several rules) is "custom", kept
 * as written and never rewritten by the control. */
import { Temporal } from '@js-temporal/polyfill';
import { isCalendarDate } from './calendar-date.js';
import type {
  CalendarEvent,
  CalendarRecord,
  CalendarTime,
} from './calendar-recurrence.js';

/** The calendarId of a row's own series, written by the Repeat control. The
 * calendar view fills its id, start and end from the row's current columns,
 * so moving the row moves the series. Imported payloads keep their own. */
export const nativeCalendarId = 'atomic';

export const calendarWeekdays = [
  'MO',
  'TU',
  'WE',
  'TH',
  'FR',
  'SA',
  'SU',
] as const;
export type CalendarWeekday = (typeof calendarWeekdays)[number];
export type RepeatFrequency = 'daily' | 'weekly' | 'monthly' | 'yearly';
export type RepeatEnd =
  | { type: 'never' }
  /** The last day an occurrence may start on, inclusive. */
  | { type: 'until'; date: string }
  | { type: 'count'; count: number };

export interface RepeatRule {
  frequency: RepeatFrequency;
  /** Every `interval` days / weeks / months / years. */
  interval: number;
  /** Weekly only, Monday first; empty otherwise. */
  weekdays: CalendarWeekday[];
  /** Monthly only: on the start's date, or on its nth weekday. */
  monthlyBy: 'date' | 'weekday';
  /** Monthly by weekday: 1–4, or -1 for "last". Absent means the start's
   * own (see {@link weekdayOrdinal}); set when an imported rule said "last"
   * for a fourth weekday. */
  ordinal?: number;
  end: RepeatEnd;
}

export type RepeatParse =
  | { kind: 'none' }
  | { kind: 'rule'; rule: RepeatRule }
  | { kind: 'custom' };

/** Where a series starts: its first civil date, and for a timed event the
 * zone its wall time repeats in (absent for all-day events). */
export interface RepeatAnchor {
  date: string;
  timeZone?: string;
}

function plainDate(anchor: RepeatAnchor) {
  if (!isCalendarDate(anchor.date)) throw new Error('Invalid start date');

  return Temporal.PlainDate.from(anchor.date);
}

export function weekdayOf(date: string): CalendarWeekday {
  return calendarWeekdays[Temporal.PlainDate.from(date).dayOfWeek - 1];
}

/** "The first..fourth Thursday", or -1 for a fifth one ("the last"). */
export function weekdayOrdinal(date: string): number {
  const ordinal = Math.ceil(Temporal.PlainDate.from(date).day / 7);

  return ordinal > 4 ? -1 : ordinal;
}

/** Whether the date is its month's last such weekday. */
export function isLastWeekday(date: string): boolean {
  const plain = Temporal.PlainDate.from(date);

  return plain.day + 7 > plain.daysInMonth;
}

export function defaultRepeatRule(
  frequency: RepeatFrequency,
  anchor: RepeatAnchor,
): RepeatRule {
  return {
    frequency,
    interval: 1,
    weekdays: frequency === 'weekly' ? [weekdayOf(anchor.date)] : [],
    monthlyBy: 'date',
    end: { type: 'never' },
  };
}

function compact(date: string) {
  return date.replaceAll('-', '');
}

function untilValue(date: string, anchor: RepeatAnchor): string {
  if (!isCalendarDate(date)) throw new Error('Invalid end date');
  if (!anchor.timeZone) return compact(date);
  // A timed series ends after the last moment of its last day, there.
  const instant = Temporal.PlainDate.from(date)
    .toZonedDateTime({
      timeZone: anchor.timeZone,
      plainTime: Temporal.PlainTime.from('23:59:59'),
    })
    .toInstant()
    .toString({ smallestUnit: 'second' });

  return instant.replaceAll('-', '').replaceAll(':', '');
}

function untilDate(value: string, anchor: RepeatAnchor): string | undefined {
  const date = /^(\d{4})(\d{2})(\d{2})$/.exec(value);

  if (date) {
    const iso = `${date[1]}-${date[2]}-${date[3]}`;

    return !anchor.timeZone && isCalendarDate(iso) ? iso : undefined;
  }

  const time = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!time || !anchor.timeZone) return undefined;

  try {
    return Temporal.Instant.from(
      `${time[1]}-${time[2]}-${time[3]}T${time[4]}:${time[5]}:${time[6]}Z`,
    )
      .toZonedDateTimeISO(anchor.timeZone)
      .toPlainDate()
      .toString();
  } catch {
    return undefined;
  }
}

/** The RRULE line(s) for a rule starting at `anchor`. */
export function buildRecurrence(
  rule: RepeatRule,
  anchor: RepeatAnchor,
): string[] {
  const start = plainDate(anchor);
  const parts = [`FREQ=${rule.frequency.toUpperCase()}`];

  if (!Number.isSafeInteger(rule.interval) || rule.interval < 1)
    throw new Error('Invalid repeat interval');
  if (rule.interval > 1) parts.push(`INTERVAL=${rule.interval}`);

  if (rule.frequency === 'weekly') {
    const days = calendarWeekdays.filter(day => rule.weekdays.includes(day));
    parts.push(
      `BYDAY=${(days.length ? days : [weekdayOf(anchor.date)]).join(',')}`,
    );
  }

  if (rule.frequency === 'monthly' && rule.monthlyBy === 'weekday') {
    const ordinal = rule.ordinal ?? weekdayOrdinal(start.toString());
    parts.push(`BYDAY=${ordinal}${weekdayOf(start.toString())}`);
  }

  if (rule.end.type === 'until')
    parts.push(`UNTIL=${untilValue(rule.end.date, anchor)}`);

  if (rule.end.type === 'count') {
    if (!Number.isSafeInteger(rule.end.count) || rule.end.count < 1)
      throw new Error('Invalid repeat count');
    parts.push(`COUNT=${rule.end.count}`);
  }

  return [`RRULE:${parts.join(';')}`];
}

const FREQUENCIES: Record<string, RepeatFrequency> = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly',
  YEARLY: 'yearly',
};

/** Reads a payload's `recurrence` lines as the rule the control can show,
 * "none", or "custom" for anything it cannot represent faithfully. */
export function parseRecurrence(
  lines: unknown,
  anchor: RepeatAnchor,
): RepeatParse {
  if (lines === undefined || lines === null) return { kind: 'none' };
  if (!Array.isArray(lines)) return { kind: 'custom' };
  if (lines.length === 0) return { kind: 'none' };
  const [line] = lines;

  if (
    lines.length !== 1 ||
    typeof line !== 'string' ||
    !line.startsWith('RRULE:')
  )
    return { kind: 'custom' };

  const custom = { kind: 'custom' } as const;
  const parts = new Map<string, string>();

  for (const part of line.slice(6).split(';')) {
    const [key, value, extra] = part.split('=');
    if (!key || !value || extra !== undefined || parts.has(key)) return custom;
    parts.set(key, value);
  }

  const known = [
    'FREQ',
    'INTERVAL',
    'COUNT',
    'UNTIL',
    'BYDAY',
    'BYMONTHDAY',
    'BYMONTH',
    'WKST',
  ];
  if ([...parts.keys()].some(key => !known.includes(key))) return custom;

  const frequency = FREQUENCIES[parts.get('FREQ') ?? ''];
  if (!frequency) return custom;
  const date = plainDate(anchor);
  const rule = defaultRepeatRule(frequency, anchor);

  const interval = parts.get('INTERVAL');

  if (interval !== undefined) {
    if (!/^\d+$/.test(interval)) return custom;
    rule.interval = Number(interval);
    if (rule.interval < 1 || rule.interval > 1000) return custom;
  }

  const count = parts.get('COUNT');
  const until = parts.get('UNTIL');
  if (count !== undefined && until !== undefined) return custom;

  if (count !== undefined) {
    if (!/^\d+$/.test(count) || Number(count) < 1) return custom;
    rule.end = { type: 'count', count: Number(count) };
  }

  if (until !== undefined) {
    const last = untilDate(until, anchor);
    if (!last) return custom;
    rule.end = { type: 'until', date: last };
  }

  // The week start only changes which weeks an every-N-weeks rule skips.
  const wkst = parts.get('WKST');
  if (wkst && wkst !== 'MO' && frequency === 'weekly' && rule.interval > 1)
    return custom;

  const byday = parts.get('BYDAY');
  const bymonthday = parts.get('BYMONTHDAY');
  const bymonth = parts.get('BYMONTH');

  if (frequency === 'daily') {
    if (byday || bymonthday || bymonth) return custom;
  }

  if (frequency === 'weekly') {
    if (bymonthday || bymonth) return custom;

    if (byday) {
      const days = byday.split(',');
      if (
        days.some(day => !calendarWeekdays.includes(day as CalendarWeekday)) ||
        new Set(days).size !== days.length
      )
        return custom;
      rule.weekdays = calendarWeekdays.filter(day => days.includes(day));
    }
  }

  if (frequency === 'monthly') {
    if (bymonth) return custom;
    if (byday && bymonthday) return custom;
    if (bymonthday && bymonthday !== String(date.day)) return custom;

    if (byday) {
      const match = /^(-1|[1-4])(MO|TU|WE|TH|FR|SA|SU)$/.exec(byday);
      if (!match || match[2] !== weekdayOf(anchor.date)) return custom;
      const ordinal = Number(match[1]);
      const own = weekdayOrdinal(anchor.date);
      if (ordinal !== own && !(ordinal === -1 && isLastWeekday(anchor.date)))
        return custom;
      rule.monthlyBy = 'weekday';
      if (ordinal !== own) rule.ordinal = ordinal;
    }
  }

  if (frequency === 'yearly') {
    if (byday) return custom;
    if (bymonth && bymonth !== String(date.month)) return custom;
    if (bymonthday && bymonthday !== String(date.day)) return custom;
  }

  return { kind: 'rule', rule };
}

/** The payload the Repeat control stores on a row: a record the calendar
 * view expands like an imported one (see `calendar-recurrence.ts`). */
export function nativeCalendarPayload(
  subject: string,
  rule: RepeatRule,
  time: { start: CalendarTime; end: CalendarTime },
): Omit<CalendarRecord, 'subject'> {
  const anchor = anchorOf(time.start);
  const event: CalendarEvent = {
    id: subject,
    start: time.start,
    end: time.end,
    recurrence: buildRecurrence(rule, anchor),
  };

  return { calendarId: nativeCalendarId, event };
}

/** The anchor of a series starting at `start`. */
export function anchorOf(start: CalendarTime): RepeatAnchor {
  if (start.date) return { date: start.date };
  if (!start.dateTime || !start.timeZone)
    throw new Error('A timed series needs a start time and a time zone');
  const date = Temporal.Instant.from(start.dateTime)
    .toZonedDateTimeISO(start.timeZone)
    .toPlainDate()
    .toString();

  return { date, timeZone: start.timeZone };
}

import {
  calendarWeekdays,
  weekdayOf,
  weekdayOrdinal,
  type CalendarWeekday,
  type RepeatAnchor,
  type RepeatParse,
  type RepeatRule,
} from '@tomic/lib/calendar-recurrence.js';

/** A civil date at local noon, so no zone can move it to another day. */
function civil(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);

  return new Date(year, month - 1, day, 12);
}

/** "Thursday", in the locale. 2024-01-01 was a Monday. */
export function weekdayName(
  day: CalendarWeekday,
  locale?: string,
  width: 'long' | 'short' = 'long',
): string {
  return new Date(
    2024,
    0,
    1 + calendarWeekdays.indexOf(day),
    12,
  ).toLocaleDateString(locale, { weekday: width });
}

function list(items: string[], locale?: string): string {
  return new Intl.ListFormat(locale, {
    style: 'long',
    type: 'conjunction',
  }).format(items);
}

function weekly(rule: RepeatRule, locale?: string): string {
  const days = rule.weekdays;
  const workweek = ['MO', 'TU', 'WE', 'TH', 'FR'];

  if (
    rule.interval === 1 &&
    days.length === 5 &&
    workweek.every(day => days.includes(day as CalendarWeekday))
  ) {
    return 'Every weekday';
  }

  if (days.length === 7) {
    return rule.interval === 1
      ? 'Every day of the week'
      : `Every ${rule.interval} weeks, every day`;
  }

  const names = list(
    days.map(day => weekdayName(day, locale)),
    locale,
  );

  return rule.interval === 1
    ? `Every ${names}`
    : `Every ${rule.interval} weeks on ${names}`;
}

/** Whole sentences per ordinal, so each translates as one message. */
function monthlyOnWeekday(n: number, ordinal: number, weekday: string) {
  if (n === 1) {
    switch (ordinal) {
      case 1:
        return `Monthly on the first ${weekday}`;
      case 2:
        return `Monthly on the second ${weekday}`;
      case 3:
        return `Monthly on the third ${weekday}`;
      case 4:
        return `Monthly on the fourth ${weekday}`;
      default:
        return `Monthly on the last ${weekday}`;
    }
  }

  switch (ordinal) {
    case 1:
      return `Every ${n} months on the first ${weekday}`;
    case 2:
      return `Every ${n} months on the second ${weekday}`;
    case 3:
      return `Every ${n} months on the third ${weekday}`;
    case 4:
      return `Every ${n} months on the fourth ${weekday}`;
    default:
      return `Every ${n} months on the last ${weekday}`;
  }
}

function monthly(rule: RepeatRule, anchor: RepeatAnchor, locale?: string) {
  if (rule.monthlyBy === 'weekday') {
    return monthlyOnWeekday(
      rule.interval,
      rule.ordinal ?? weekdayOrdinal(anchor.date),
      weekdayName(weekdayOf(anchor.date), locale),
    );
  }

  const day = civil(anchor.date).getDate();

  return rule.interval === 1
    ? `Monthly on day ${day}`
    : `Every ${rule.interval} months on day ${day}`;
}

function yearly(rule: RepeatRule, anchor: RepeatAnchor, locale?: string) {
  const date = civil(anchor.date).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'long',
  });

  return rule.interval === 1
    ? `Every year on ${date}`
    : `Every ${rule.interval} years on ${date}`;
}

function base(rule: RepeatRule, anchor: RepeatAnchor, locale?: string) {
  switch (rule.frequency) {
    case 'daily':
      return rule.interval === 1 ? 'Every day' : `Every ${rule.interval} days`;
    case 'weekly':
      return weekly(rule, locale);
    case 'monthly':
      return monthly(rule, anchor, locale);
    case 'yearly':
      return yearly(rule, anchor, locale);
  }
}

/** "Every Thursday until 31 Dec": what a row's Repeat setting means, in
 * words. The year shows only when the series ends in another year. */
export function describeRepeat(
  parsed: RepeatParse,
  anchor: RepeatAnchor,
  locale?: string,
): string {
  if (parsed.kind === 'none') return 'Does not repeat';
  if (parsed.kind === 'custom') return 'Custom';
  const { rule } = parsed;
  const text = base(rule, anchor, locale);

  if (rule.end.type === 'until') {
    const sameYear = rule.end.date.slice(0, 4) === anchor.date.slice(0, 4);
    const date = civil(rule.end.date).toLocaleDateString(locale, {
      day: 'numeric',
      month: 'short',
      year: sameYear ? undefined : 'numeric',
    });

    return `${text} until ${date}`;
  }

  if (rule.end.type === 'count') {
    return rule.end.count === 1
      ? `${text}, once`
      : `${text}, ${rule.end.count} times`;
  }

  return text;
}

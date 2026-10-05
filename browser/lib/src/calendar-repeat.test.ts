import { describe, expect, it } from 'vitest';
import {
  buildRecurrence,
  defaultRepeatRule,
  nativeCalendarPayload,
  parseRecurrence,
  type RepeatAnchor,
  type RepeatRule,
} from './calendar-repeat';
import { expandCalendar, validateCalendarEvent } from './calendar-recurrence';

// Thursday 1 October 2026: the first Thursday of the month.
const allDay: RepeatAnchor = { date: '2026-10-01' };
const timed: RepeatAnchor = {
  date: '2026-10-01',
  timeZone: 'Europe/Amsterdam',
};

const rule = (overrides: Partial<RepeatRule> = {}): RepeatRule => ({
  ...defaultRepeatRule('weekly', allDay),
  ...overrides,
});

const cases: [string, RepeatRule, string][] = [
  ['daily', rule({ frequency: 'daily', weekdays: [] }), 'RRULE:FREQ=DAILY'],
  [
    'every 3 days',
    rule({ frequency: 'daily', weekdays: [], interval: 3 }),
    'RRULE:FREQ=DAILY;INTERVAL=3',
  ],
  ['weekly on its own day', rule(), 'RRULE:FREQ=WEEKLY;BYDAY=TH'],
  [
    'weekly on chosen days',
    rule({ weekdays: ['MO', 'WE', 'FR'] }),
    'RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR',
  ],
  [
    'every two weeks',
    rule({ interval: 2 }),
    'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TH',
  ],
  [
    'monthly by date',
    rule({ frequency: 'monthly', weekdays: [], monthlyBy: 'date' }),
    'RRULE:FREQ=MONTHLY',
  ],
  [
    'monthly by nth weekday',
    rule({ frequency: 'monthly', weekdays: [], monthlyBy: 'weekday' }),
    'RRULE:FREQ=MONTHLY;BYDAY=1TH',
  ],
  ['yearly', rule({ frequency: 'yearly', weekdays: [] }), 'RRULE:FREQ=YEARLY'],
  [
    'ending on a date',
    rule({ end: { type: 'until', date: '2026-12-31' } }),
    'RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231',
  ],
  [
    'ending after N times',
    rule({ end: { type: 'count', count: 10 } }),
    'RRULE:FREQ=WEEKLY;BYDAY=TH;COUNT=10',
  ],
];

describe('buildRecurrence and parseRecurrence', () => {
  it.each(cases)('round-trips %s', (_, input, line) => {
    expect(buildRecurrence(input, allDay)).toEqual([line]);
    expect(parseRecurrence([line], allDay)).toEqual({
      kind: 'rule',
      rule: input,
    });
    validateCalendarEvent({
      id: 'x',
      start: { date: allDay.date },
      end: { date: '2026-10-02' },
      recurrence: [line],
    });
  });

  it('round-trips every option for a timed event too', () => {
    for (const [, input] of cases) {
      const lines = buildRecurrence(input, timed);
      expect(parseRecurrence(lines, timed)).toEqual({
        kind: 'rule',
        rule: input,
      });
      validateCalendarEvent({
        id: 'x',
        start: {
          dateTime: '2026-10-01T09:30:00+02:00',
          timeZone: timed.timeZone,
        },
        end: { dateTime: '2026-10-01T10:30:00+02:00' },
        recurrence: lines,
      });
    }
  });

  it('ends a timed series at the end of its last day, in its own zone', () => {
    expect(
      buildRecurrence(
        rule({ end: { type: 'until', date: '2026-12-31' } }),
        timed,
      ),
    ).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231T225959Z']);
  });

  it('uses "last" for a fifth weekday, and keeps an imported "last"', () => {
    const fifth: RepeatAnchor = { date: '2026-10-29' };
    const monthly = rule({
      frequency: 'monthly',
      weekdays: [],
      monthlyBy: 'weekday',
    });
    expect(buildRecurrence(monthly, fifth)).toEqual([
      'RRULE:FREQ=MONTHLY;BYDAY=-1TH',
    ]);
    // 22 Oct is both the fourth and (no) last Thursday: 29 Oct follows.
    const fourth: RepeatAnchor = { date: '2026-10-22' };
    expect(buildRecurrence(monthly, fourth)).toEqual([
      'RRULE:FREQ=MONTHLY;BYDAY=4TH',
    ]);
    // 24 Sep 2026 is the fourth and the last Thursday: either reading holds.
    const last = parseRecurrence(['RRULE:FREQ=MONTHLY;BYDAY=-1TH'], {
      date: '2026-09-24',
    });
    expect(last).toEqual({
      kind: 'rule',
      rule: { ...monthly, ordinal: -1 },
    });
    expect(
      buildRecurrence((last as { rule: RepeatRule }).rule, {
        date: '2026-09-24',
      }),
    ).toEqual(['RRULE:FREQ=MONTHLY;BYDAY=-1TH']);
  });

  it('writes chosen weekdays Monday first', () => {
    expect(buildRecurrence(rule({ weekdays: ['FR', 'MO'] }), allDay)).toEqual([
      'RRULE:FREQ=WEEKLY;BYDAY=MO,FR',
    ]);
  });

  it('reads the forms other calendars write for the same rules', () => {
    expect(parseRecurrence(['RRULE:FREQ=WEEKLY'], allDay)).toEqual({
      kind: 'rule',
      rule: rule(),
    });
    expect(
      parseRecurrence(['RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=TH'], allDay),
    ).toEqual({ kind: 'rule', rule: rule() });
    expect(
      parseRecurrence(['RRULE:FREQ=MONTHLY;BYMONTHDAY=1'], allDay),
    ).toEqual({
      kind: 'rule',
      rule: rule({ frequency: 'monthly', weekdays: [], monthlyBy: 'date' }),
    });
    expect(
      parseRecurrence(['RRULE:FREQ=YEARLY;BYMONTH=10;BYMONTHDAY=1'], allDay),
    ).toEqual({
      kind: 'rule',
      rule: rule({ frequency: 'yearly', weekdays: [] }),
    });
    // Google ends a timed series at the start of its last occurrence (UTC).
    expect(
      parseRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=TU;UNTIL=20261222T003000Z'], {
        date: '2026-10-06',
        timeZone: 'America/New_York',
      }),
    ).toEqual({
      kind: 'rule',
      rule: rule({
        weekdays: ['TU'],
        end: { type: 'until', date: '2026-12-21' },
      }),
    });
  });

  it('reads no payload as "does not repeat"', () => {
    expect(parseRecurrence(undefined, allDay)).toEqual({ kind: 'none' });
    expect(parseRecurrence([], allDay)).toEqual({ kind: 'none' });
  });

  it.each([
    ['exception dates', ['RRULE:FREQ=WEEKLY', 'EXDATE;VALUE=DATE:20261008']],
    ['two rules', ['RRULE:FREQ=WEEKLY', 'RRULE:FREQ=DAILY']],
    ['only extra dates', ['RDATE;VALUE=DATE:20261008']],
    ['a set position', ['RRULE:FREQ=MONTHLY;BYDAY=MO,TU;BYSETPOS=-1']],
    ['hourly', ['RRULE:FREQ=HOURLY']],
    ['a weekday ordinal of another day', ['RRULE:FREQ=MONTHLY;BYDAY=2MO']],
    ['a month day that is not the start', ['RRULE:FREQ=MONTHLY;BYMONTHDAY=15']],
    ['several month days', ['RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15']],
    ['a yearly rule on other months', ['RRULE:FREQ=YEARLY;BYMONTH=1,10']],
    ['a daily rule on weekdays', ['RRULE:FREQ=DAILY;BYDAY=MO,TU']],
    [
      'a two-weekly rule starting on Sunday',
      ['RRULE:FREQ=WEEKLY;INTERVAL=2;WKST=SU'],
    ],
    ['a duplicate part', ['RRULE:FREQ=WEEKLY;FREQ=DAILY']],
    ['until and count', ['RRULE:FREQ=DAILY;COUNT=2;UNTIL=20261231']],
    ['a malformed line', ['RRULE:weekly']],
    ['not a list', { weekly: true }],
    ['not strings', [42]],
  ])('reads %s as custom', (_, lines) => {
    expect(parseRecurrence(lines, allDay)).toEqual({ kind: 'custom' });
  });
});

describe('nativeCalendarPayload', () => {
  it('writes a record the view expands on the following weeks', () => {
    const payload = nativeCalendarPayload('did:ad:row', rule(), {
      start: { date: '2026-10-01' },
      end: { date: '2026-10-02' },
    });
    expect(payload).toEqual({
      calendarId: 'atomic',
      event: {
        id: 'did:ad:row',
        start: { date: '2026-10-01' },
        end: { date: '2026-10-02' },
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TH'],
      },
    });
    expect(
      expandCalendar(
        [{ ...payload, subject: 'did:ad:row' }],
        Date.parse('2026-10-01'),
        Date.parse('2026-10-31'),
      ).map(x => x.day),
    ).toEqual([
      '2026-10-01',
      '2026-10-08',
      '2026-10-15',
      '2026-10-22',
      '2026-10-29',
    ]);
  });
});

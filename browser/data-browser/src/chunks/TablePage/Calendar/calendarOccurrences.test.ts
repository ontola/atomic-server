import { expect, it } from 'vitest';
import {
  calendarOccurrenceBuckets,
  calendarPropertyMatches,
} from './calendarOccurrences';
it('matches both projected and native calendar fields, not unrelated dates', () => {
  expect(
    calendarPropertyMatches(
      'lt-google-calendar-property-atomic-calendar-day',
      'atomic-calendar-day',
    ),
  ).toBe(true);
  expect(
    calendarPropertyMatches('atomic-calendar-day', 'atomic-calendar-day'),
  ).toBe(true);
  expect(
    calendarPropertyMatches(
      'custom-atomic-calendar-day',
      'atomic-calendar-day',
    ),
  ).toBe(false);
});
it('buckets civil dates near offset boundaries and clips multi-day occurrences', () => {
  const records = [
    {
      calendarId: 'c',
      subject: 'timed',
      event: {
        id: 'timed',
        start: {
          dateTime: '2026-03-29T00:30:00+14:00',
          timeZone: 'Pacific/Kiritimati',
        },
        end: { dateTime: '2026-03-29T01:30:00+14:00' },
        recurrence: ['RRULE:FREQ=DAILY;COUNT=2'],
      },
    },
    {
      calendarId: 'c',
      subject: 'all-day',
      event: {
        id: 'all-day',
        start: { date: '2026-03-27' },
        end: { date: '2026-03-30' },
        recurrence: ['RRULE:FREQ=WEEKLY;COUNT=1'],
      },
    },
  ];
  const { buckets } = calendarOccurrenceBuckets(records, [
    '2026-03-28',
    '2026-03-29',
    '2026-03-30',
  ]);
  expect(buckets.get('2026-03-28')?.map(x => x.subject)).toEqual(['all-day']);
  expect(buckets.get('2026-03-29')?.map(x => x.subject)).toEqual([
    'all-day',
    'timed',
  ]);
  expect(buckets.get('2026-03-30')?.map(x => x.subject)).toEqual(['timed']);
});
it('skips an invalid recurrence payload and still expands the others (#1797)', () => {
  const weekly = (subject: string) => ({
    calendarId: 'c',
    subject,
    event: {
      id: subject,
      start: {
        dateTime: '2026-09-07T10:00:00+02:00',
        timeZone: 'Europe/Amsterdam',
      },
      end: { dateTime: '2026-09-07T11:00:00+02:00' },
      recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'],
    },
  });
  const records = [
    weekly('standup'),
    {
      calendarId: 'c',
      subject: 'bad-rule',
      event: {
        ...weekly('bad-rule').event,
        recurrence: ['RRULE:FREQ=WEEKLY;BYFOO=1'],
      },
    },
    {
      calendarId: 'c',
      subject: 'no-zone',
      event: {
        id: 'no-zone',
        start: { dateTime: '2026-09-08T10:00:00+02:00' },
        end: { dateTime: '2026-09-08T11:00:00+02:00' },
        recurrence: ['RRULE:FREQ=DAILY;COUNT=2'],
      },
    },
    weekly('retro'),
  ];
  const { buckets, invalid } = calendarOccurrenceBuckets(records, [
    '2026-09-07',
    '2026-09-08',
    '2026-09-14',
  ]);
  expect(buckets.get('2026-09-07')?.map(x => x.subject)).toEqual([
    'retro',
    'standup',
  ]);
  expect(buckets.get('2026-09-14')?.map(x => x.subject)).toEqual([
    'retro',
    'standup',
  ]);
  expect(buckets.get('2026-09-08')).toBeUndefined();
  expect(invalid.map(x => x.subject)).toEqual(['bad-rule', 'no-zone']);
  expect(invalid[0].message).toMatch(/recurrence rule part/);
});
it('drops a series whose exception is invalid, and no other series', () => {
  const records = [
    {
      calendarId: 'c',
      subject: 'series',
      event: {
        id: 'series',
        start: { date: '2026-09-07' },
        end: { date: '2026-09-08' },
        recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
      },
    },
    {
      calendarId: 'c',
      subject: 'series-exception',
      event: {
        id: 'series_x',
        recurringEventId: 'series',
        originalStartTime: { date: '2026-09-08' },
        start: { date: '2026-09-08' },
        end: { date: '2026-09-08' },
      },
    },
    {
      calendarId: 'c',
      subject: 'other',
      event: {
        id: 'other',
        start: { date: '2026-09-07' },
        end: { date: '2026-09-08' },
        recurrence: ['RRULE:FREQ=DAILY;COUNT=2'],
      },
    },
  ];
  const { buckets, invalid } = calendarOccurrenceBuckets(records, [
    '2026-09-07',
    '2026-09-08',
  ]);
  expect(buckets.get('2026-09-07')?.map(x => x.subject)).toEqual(['other']);
  expect(buckets.get('2026-09-08')?.map(x => x.subject)).toEqual(['other']);
  expect(invalid.map(x => x.subject).sort()).toEqual([
    'series',
    'series-exception',
  ]);
});

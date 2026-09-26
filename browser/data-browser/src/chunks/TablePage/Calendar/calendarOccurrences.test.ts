import { describe, expect, it } from 'vitest';
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

describe('moved occurrences (#1804)', () => {
  const AMS = 'Europe/Amsterdam';
  const standup = {
    calendarId: 'c',
    subject: 'standup',
    event: {
      id: 'standup',
      start: { dateTime: '2026-10-12T09:30:00+02:00', timeZone: AMS },
      end: { dateTime: '2026-10-12T09:45:00+02:00', timeZone: AMS },
      recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;COUNT=6'],
    },
  };
  const override = (
    subject: string,
    start: string,
    end: string,
    extra: Record<string, unknown> = {},
  ) => ({
    calendarId: 'c',
    subject,
    event: {
      id: `standup_${subject}`,
      recurringEventId: 'standup',
      originalStartTime: {
        dateTime: '2026-10-14T09:30:00+02:00',
        timeZone: AMS,
      },
      start: { dateTime: start, timeZone: AMS },
      end: { dateTime: end, timeZone: AMS },
      ...extra,
    },
  });
  const week = [
    '2026-10-12',
    '2026-10-13',
    '2026-10-14',
    '2026-10-15',
    '2026-10-16',
  ];

  it('marks the moved instance and leaves a placeholder on its original day', () => {
    const moved = override(
      'moved',
      '2026-10-15T10:00:00+02:00',
      '2026-10-15T10:15:00+02:00',
    );
    const { buckets } = calendarOccurrenceBuckets([standup, moved], week);

    const [onNewDay] = buckets.get('2026-10-15') ?? [];
    expect(onNewDay).toMatchObject({
      subject: 'moved',
      movedFrom: '2026-10-14',
    });
    expect(onNewDay.movedTo).toBeUndefined();

    const onOriginalDay = buckets.get('2026-10-14') ?? [];
    expect(onOriginalDay).toHaveLength(1);
    expect(onOriginalDay[0]).toMatchObject({
      subject: 'moved',
      movedTo: '2026-10-15',
    });
    // Both carry the original instance's identity from the expansion.
    expect(onOriginalDay[0].key).toBe(onNewDay.key);

    // The rest of the series is untouched.
    for (const day of ['2026-10-12', '2026-10-16']) {
      const [occurrence] = buckets.get(day) ?? [];
      expect(occurrence.subject).toBe('standup');
      expect(occurrence.movedFrom).toBeUndefined();
      expect(occurrence.movedTo).toBeUndefined();
    }
  });

  it('keeps the placeholder when the new day is outside the grid', () => {
    const moved = override(
      'moved',
      '2026-11-02T10:00:00+01:00',
      '2026-11-02T10:15:00+01:00',
    );
    const { buckets } = calendarOccurrenceBuckets([standup, moved], week);

    expect(buckets.get('2026-10-14')).toEqual([
      expect.objectContaining({ subject: 'moved', movedTo: '2026-11-02' }),
    ]);
  });

  it('does not mark a time change on the same day, or a cancellation', () => {
    const later = override(
      'later',
      '2026-10-14T11:00:00+02:00',
      '2026-10-14T11:15:00+02:00',
    );
    const sameDay = calendarOccurrenceBuckets([standup, later], week).buckets;
    expect(sameDay.get('2026-10-14')).toEqual([
      expect.objectContaining({ subject: 'later' }),
    ]);
    expect(sameDay.get('2026-10-14')?.[0].movedFrom).toBeUndefined();
    expect(sameDay.get('2026-10-14')?.[0].movedTo).toBeUndefined();

    const cancelled = override('cancelled', '', '', {
      status: 'cancelled',
      start: undefined,
      end: undefined,
    });
    const gone = calendarOccurrenceBuckets([standup, cancelled], week).buckets;
    expect(gone.get('2026-10-14')).toBeUndefined();
  });
});

import { describe, expect, it } from 'vitest';
import { defaultRepeatRule, nativeCalendarPayload } from '@tomic/lib';
import {
  allDayRowTime,
  readRecurrencePayload,
  rowRecord,
} from './calendarRows';
import { calendarOccurrenceBuckets } from './calendarOccurrences';

const weekly = nativeCalendarPayload(
  'row',
  defaultRepeatRule('weekly', { date: '2026-10-01' }),
  allDayRowTime('2026-10-01'),
);

describe('rowRecord', () => {
  it('moves a native series with its row', () => {
    // Moved from Thursday 1 Oct to Friday 2 Oct in the table.
    const record = rowRecord('row', weekly, allDayRowTime('2026-10-02'));
    expect(record.event.recurrence).toEqual(['RRULE:FREQ=WEEKLY;BYDAY=FR']);
    const { buckets } = calendarOccurrenceBuckets(
      [record],
      ['2026-10-01', '2026-10-02', '2026-10-08', '2026-10-09'],
    );
    expect([...buckets.keys()]).toEqual(['2026-10-02', '2026-10-09']);
  });

  it('keeps a multi-day row multi-day', () => {
    const record = rowRecord(
      'row',
      weekly,
      allDayRowTime('2026-10-01', '2026-10-03'),
    );
    expect(record.event.end).toEqual({ date: '2026-10-03' });
  });

  it('leaves an imported payload as the provider wrote it', () => {
    const imported = {
      calendarId: 'work@example.com',
      event: {
        id: 'standup',
        start: { date: '2026-10-01' },
        end: { date: '2026-10-02' },
        recurrence: ['RRULE:FREQ=WEEKLY'],
      },
    };
    expect(rowRecord('row', imported, allDayRowTime('2026-10-05'))).toEqual({
      ...imported,
      subject: 'row',
    });
  });

  it('keeps a custom native rule as written', () => {
    const custom = {
      ...weekly,
      event: {
        ...weekly.event,
        recurrence: ['RRULE:FREQ=WEEKLY', 'EXDATE;VALUE=DATE:20261008'],
      },
    };
    expect(
      rowRecord('row', custom, allDayRowTime('2026-10-01')).event.recurrence,
    ).toEqual(custom.event.recurrence);
  });
});

describe('readRecurrencePayload', () => {
  it('reads objects and JSON-encoded strings, and nothing else', () => {
    expect(readRecurrencePayload(weekly)).toBe(weekly);
    expect(readRecurrencePayload(JSON.stringify(weekly))).toEqual(weekly);
    expect(readRecurrencePayload('{"weekly":true}')).toBeUndefined();
    expect(readRecurrencePayload(undefined)).toBeUndefined();
    expect(readRecurrencePayload(['RRULE:FREQ=DAILY'])).toBeUndefined();
  });
});

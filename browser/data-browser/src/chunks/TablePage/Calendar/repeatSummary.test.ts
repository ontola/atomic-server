import { describe, expect, it } from 'vitest';
import {
  defaultRepeatRule,
  parseRecurrence,
  type RepeatAnchor,
  type RepeatRule,
} from '@tomic/lib';
import { describeRepeat } from './repeatSummary';

// Thursday 1 October 2026.
const anchor: RepeatAnchor = { date: '2026-10-01' };
const say = (rule: Partial<RepeatRule>, frequency = rule.frequency) =>
  describeRepeat(
    {
      kind: 'rule',
      rule: { ...defaultRepeatRule(frequency ?? 'weekly', anchor), ...rule },
    },
    anchor,
    'en-GB',
  );

describe('describeRepeat', () => {
  it('says the issue example in words', () => {
    expect(
      describeRepeat(
        parseRecurrence(['RRULE:FREQ=WEEKLY;BYDAY=TH;UNTIL=20261231'], anchor),
        anchor,
        'en-GB',
      ),
    ).toBe('Every Thursday until 31 Dec');
  });

  it.each<[string, Partial<RepeatRule>, string]>([
    ['daily', { frequency: 'daily' }, 'Every day'],
    ['every 3 days', { frequency: 'daily', interval: 3 }, 'Every 3 days'],
    ['weekly', { frequency: 'weekly' }, 'Every Thursday'],
    [
      'several weekdays',
      { frequency: 'weekly', weekdays: ['MO', 'WE', 'FR'] },
      'Every Monday, Wednesday and Friday',
    ],
    [
      'workdays',
      { frequency: 'weekly', weekdays: ['MO', 'TU', 'WE', 'TH', 'FR'] },
      'Every weekday',
    ],
    [
      'every other week',
      { frequency: 'weekly', interval: 2 },
      'Every 2 weeks on Thursday',
    ],
    ['monthly by date', { frequency: 'monthly' }, 'Monthly on day 1'],
    [
      'monthly by weekday',
      { frequency: 'monthly', monthlyBy: 'weekday' },
      'Monthly on the first Thursday',
    ],
    [
      'the last weekday',
      { frequency: 'monthly', monthlyBy: 'weekday', ordinal: -1 },
      'Monthly on the last Thursday',
    ],
    [
      'every 3 months',
      { frequency: 'monthly', interval: 3 },
      'Every 3 months on day 1',
    ],
    ['yearly', { frequency: 'yearly' }, 'Every year on 1 October'],
    [
      'until next year',
      { frequency: 'daily', end: { type: 'until', date: '2027-01-15' } },
      'Every day until 15 Jan 2027',
    ],
    [
      'a count',
      { frequency: 'weekly', end: { type: 'count', count: 10 } },
      'Every Thursday, 10 times',
    ],
    [
      'once',
      { frequency: 'yearly', end: { type: 'count', count: 1 } },
      'Every year on 1 October, once',
    ],
  ])('%s', (_, rule, text) => {
    expect(say(rule)).toBe(text);
  });

  it('says "Does not repeat" without a rule', () => {
    expect(describeRepeat({ kind: 'none' }, anchor)).toBe('Does not repeat');
  });

  it('falls back to "Custom" for a payload the control cannot show', () => {
    expect(
      describeRepeat(
        parseRecurrence(
          ['RRULE:FREQ=WEEKLY', 'EXDATE;VALUE=DATE:20261008'],
          anchor,
        ),
        anchor,
      ),
    ).toBe('Custom');
  });
});

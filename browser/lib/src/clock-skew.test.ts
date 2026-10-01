import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getTimestampNow,
  learnServerClock,
  resetServerClock,
} from './commit.js';

describe('server clock', () => {
  afterEach(() => {
    resetServerClock();
    vi.useRealTimers();
  });

  it('signs in the server time after a future-timestamp refusal', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_790_772_131_511);

    // The refusal Joep's desktop got: its clock was 10.7 s ahead of node1.
    expect(
      learnServerClock(
        'Unauthorized. Authentication timestamp rejected. Commit CreatedAt timestamp must lie in the past. Check your clock. Timestamp now: 1790772120836 CreatedAt is: 1790772131511',
      ),
    ).toBe(true);
    expect(getTimestampNow()).toBe(1_790_772_120_836);

    vi.advanceTimersByTime(5_000);
    expect(getTimestampNow()).toBe(1_790_772_125_836);
  });

  it('ignores other errors and absurd offsets', () => {
    expect(learnServerClock('Parent of x not found')).toBe(false);
    expect(
      learnServerClock(
        'must lie in the past. Timestamp now: 1 CreatedAt is: 2',
      ),
    ).toBe(false);
    expect(Math.abs(getTimestampNow() - Date.now())).toBeLessThan(1_000);
  });
});

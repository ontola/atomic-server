import { describe, it, expect } from 'vitest';
import { formatClock, formatCompact } from './formatDuration';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('formatClock', () => {
  it('pads minutes and seconds to a stable width', () => {
    expect(formatClock(0)).toBe('0:00:00');
    expect(formatClock(5 * SECOND)).toBe('0:00:05');
    expect(formatClock(65 * SECOND)).toBe('0:01:05');
    expect(formatClock(HOUR + 2 * MINUTE + 3 * SECOND)).toBe('1:02:03');
  });

  it('lets the hour field grow past a day', () => {
    expect(formatClock(30 * HOUR)).toBe('30:00:00');
  });

  it('truncates sub-second remainders rather than rounding up', () => {
    expect(formatClock(1999)).toBe('0:00:01');
  });

  it('clamps a negative span (clock skew) to zero', () => {
    expect(formatClock(-5000)).toBe('0:00:00');
  });
});

describe('formatCompact', () => {
  it('omits the hour part below an hour', () => {
    expect(formatCompact(0)).toBe('0m');
    expect(formatCompact(45 * MINUTE)).toBe('45m');
  });

  it('pads the minute part once hours are shown', () => {
    expect(formatCompact(HOUR + 5 * MINUTE)).toBe('1h 05m');
    expect(formatCompact(2 * HOUR + 15 * MINUTE)).toBe('2h 15m');
  });

  it('rounds to the nearest minute', () => {
    expect(formatCompact(89 * SECOND)).toBe('1m');
    expect(formatCompact(91 * SECOND)).toBe('2m');
  });

  it('clamps a negative span to zero', () => {
    expect(formatCompact(-1 * HOUR)).toBe('0m');
  });
});

import { afterEach, describe, it, vi } from 'vitest';
import {
  getClockOffset,
  noteServerClock,
  noteServerClockFromMessage,
  noteServerDateHeader,
  trustedNow,
} from './clock.js';

describe('clock skew', () => {
  afterEach(() => {
    noteServerClock(Date.now());
    vi.useRealTimers();
  });

  it('pulls a device that runs ahead back to server time', ({ expect }) => {
    noteServerClock(Date.now() - 10_700);
    expect(getClockOffset()).toBeLessThan(-10_000);
    expect(Date.now() - trustedNow()).toBeGreaterThan(10_000);
  });

  it('ignores small differences and devices running behind', ({ expect }) => {
    noteServerClock(Date.now() - 500);
    expect(getClockOffset()).toBe(0);
    noteServerClock(Date.now() + 60_000);
    expect(getClockOffset()).toBe(0);
  });

  it('learns from the server rejection message', ({ expect }) => {
    const now = Date.now();

    noteServerClockFromMessage(
      `Commit CreatedAt timestamp must lie in the past. Check your clock. Timestamp now: ${now - 10_711} CreatedAt is: ${now}`,
    );
    expect(getClockOffset()).toBeLessThan(-10_000);
  });

  it('learns from a Date header', ({ expect }) => {
    noteServerDateHeader(new Date(Date.now() - 30_000).toUTCString());
    expect(getClockOffset()).toBeLessThan(-29_000);
  });
});

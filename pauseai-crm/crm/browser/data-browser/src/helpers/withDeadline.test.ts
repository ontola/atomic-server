import { describe, it, expect, vi, afterEach } from 'vitest';
import { withDeadline } from './withDeadline';

afterEach(() => {
  vi.useRealTimers();
});

describe('withDeadline', () => {
  it('returns the real answer when it arrives in time', async () => {
    expect(await withDeadline(Promise.resolve('drive'), 1000, undefined)).toBe(
      'drive',
    );
  });

  /** The case that hung sign-in: a fetch that simply never settles. */
  it('gives up on a promise that never settles', async () => {
    vi.useFakeTimers();

    const result = withDeadline(
      new Promise<string>(() => {}),
      5000,
      'fallback',
    );

    await vi.advanceTimersByTimeAsync(5000);
    expect(await result).toBe('fallback');
  });

  /**
   * A rejection is the same answer as a timeout here — we could not find out —
   * and must not escape as an unhandled rejection once we have stopped caring.
   */
  it('treats a failure as not finding out, without rethrowing', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);

    try {
      expect(
        await withDeadline(Promise.reject(new Error('offline')), 1000, false),
      ).toBe(false);

      await new Promise(resolve => setTimeout(resolve, 10));
      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  /** A late answer must not resolve a promise that already gave up. */
  it('ignores an answer that arrives after the deadline', async () => {
    vi.useFakeTimers();

    let settle: (value: string) => void = () => undefined;
    const slow = new Promise<string>(resolve => {
      settle = resolve;
    });

    const result = withDeadline(slow, 100, 'fallback');
    await vi.advanceTimersByTimeAsync(100);
    settle('too late');

    expect(await result).toBe('fallback');
  });
});

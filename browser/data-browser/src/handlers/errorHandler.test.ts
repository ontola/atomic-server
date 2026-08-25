import { describe, expect, it, vi, beforeEach } from 'vitest';

const toasted: string[] = [];

vi.mock('react-hot-toast', () => ({
  default: { error: (m: string) => toasted.push(m) },
}));
vi.mock('../helpers/loggingHandlers', () => ({
  handleErrorBugsnag: () => undefined,
}));

const { errorHandler } = await import('./errorHandler');

beforeEach(() => {
  toasted.length = 0;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

/**
 * The error handler is wired to `window.onerror` and
 * `window.onunhandledrejection`, both of which hand over arbitrary values. It
 * used to read `.message` off them directly, so a null arrived, threw a
 * TypeError from inside the handler, and replaced the failure being reported
 * with a louder and less useful one — precisely when someone was trying to
 * find out what had gone wrong.
 */
describe('errorHandler', () => {
  it('shows the message of a real error', () => {
    errorHandler(new Error('Could not reach the server'));

    expect(toasted).toEqual(['Could not reach the server']);
  });

  it('survives a null, and still says something happened', () => {
    expect(() => errorHandler(null)).not.toThrow();

    // Not silence: the user saw a failure, so the absence of a reason is
    // itself worth saying rather than showing nothing at all.
    expect(toasted[0]).toContain('reported no reason');
  });

  it('survives a rejection that was not an Error', () => {
    // `event.reason` is whatever the rejecting code passed.
    expect(() => errorHandler('offline')).not.toThrow();
    expect(toasted[0]).toBe('offline');

    expect(() => errorHandler({ status: 500 })).not.toThrow();
    expect(toasted[1]).toBeTruthy();
  });
});

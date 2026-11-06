import { describe, expect, it, vi } from 'vitest';
import toast from 'react-hot-toast';
import {
  ERROR_TOAST_DURATION,
  reportableErrorForToast,
  toastReportableError,
} from './reportableErrors';

describe('toastReportableError', () => {
  it('shows the message long enough to report it, and remembers the error', () => {
    const spy = vi.spyOn(toast, 'error');
    const error = new Error('This person has no encryption key yet.');

    const id = toastReportableError(error);

    expect(spy).toHaveBeenCalledWith(error.message, {
      duration: ERROR_TOAST_DURATION,
    });
    expect(ERROR_TOAST_DURATION).toBeGreaterThanOrEqual(8000);
    expect(reportableErrorForToast(id)).toBe(error);
    spy.mockRestore();
  });

  it('forgets old errors instead of keeping every toast forever', () => {
    const first = toastReportableError(new Error('first'));

    for (let i = 0; i < 30; i++) toastReportableError(new Error(`n${i}`));

    expect(reportableErrorForToast(first)).toBeUndefined();
  });

  it('has nothing to report for an ordinary toast', () => {
    expect(reportableErrorForToast(toast.error('plain'))).toBeUndefined();
  });
});

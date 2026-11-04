import toast from 'react-hot-toast';

/**
 * How long an error toast stays up. Long enough to read it and press
 * "Report"; hovering pauses it.
 */
export const ERROR_TOAST_DURATION = 10_000;

/** Toasts are dismissed elsewhere, so only the latest few are kept. */
const MAX_KEPT = 20;

const errorsByToast = new Map<string, Error>();

/** Shows `error` as an error toast that offers to report it. */
export function toastReportableError(error: Error): string {
  const id = toast.error(error.message, { duration: ERROR_TOAST_DURATION });
  errorsByToast.set(id, error);

  if (errorsByToast.size > MAX_KEPT) {
    errorsByToast.delete(errorsByToast.keys().next().value!);
  }

  return id;
}

/** The error behind a toast from {@link toastReportableError}, if any. */
export function reportableErrorForToast(toastId: string): Error | undefined {
  return errorsByToast.get(toastId);
}

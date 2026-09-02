import toast from 'react-hot-toast';
import { handleErrorBugsnag } from '../helpers/loggingHandlers';

/**
 * Coerces whatever was thrown into an Error.
 *
 * `window.onunhandledrejection` hands over `event.reason`, which is whatever
 * the rejecting code passed — a string, `undefined`, a DOM event, anything.
 * `window.onerror` can report a null error for a failure that crossed an
 * origin or came out of a worker.
 */
function asError(thrown: unknown): Error {
  if (thrown instanceof Error) {
    return thrown;
  }

  if (typeof thrown === 'string' && thrown.length > 0) {
    return new Error(thrown);
  }

  if (thrown === null || thrown === undefined) {
    return new Error('Something failed, and reported no reason.');
  }

  return new Error(String(thrown));
}

/**
 * Logs the error, reports it, and shows it to the user.
 *
 * Takes `unknown` rather than `Error` because it is wired to the two browser
 * hooks that hand over arbitrary values, and it used to read `.message` off
 * them directly. A null there threw a TypeError from inside the error handler
 * — which replaced the failure being reported with a louder, less useful one,
 * exactly when someone was trying to find out what went wrong.
 */
export const errorHandler = (thrown: unknown) => {
  const e = asError(thrown);

  console.error(e);
  handleErrorBugsnag(e);

  toast.error(e.message);
};

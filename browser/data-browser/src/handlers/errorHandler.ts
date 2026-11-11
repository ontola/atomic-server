import { asError } from '@tomic/react';
import {
  handleErrorBugsnag,
  reportStoreError,
} from '../helpers/loggingHandlers';
import { toastReportableError } from './reportableErrors';

/**
 * Logs the error, reports it, and shows it to the user in a toast that offers
 * to report it through the feedback dialog.
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
  reportStoreError(e);

  toastReportableError(e);
};

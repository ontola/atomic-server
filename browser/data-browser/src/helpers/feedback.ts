// @wc-ignore-file
import * as Sentry from '@sentry/react';
import type { Store } from '@tomic/react';
import { collectFeedbackDiagnostics } from './feedbackDiagnostics';

export async function submitFeedback(
  message: string,
  email: string,
  source = 'sidebar',
  /** Adds the app's setup (server, connection, sync state) as tags. */
  store?: Store,
): Promise<string> {
  if (!message.trim()) throw new Error('Feedback is empty');
  if (!Sentry.isEnabled()) throw new Error('Feedback reporting is unavailable');

  return Sentry.sendFeedback(
    {
      message: message.trim(),
      email: email.trim() || undefined,
      url: '',
      source,
      tags: store ? diagnosticsFor(store) : undefined,
    },
    { includeReplay: false },
  );
}

/** Prefill a report without attaching a stack trace or the current resource URL. */
export function errorFeedbackMessage(error: Error): string {
  return `I encountered this error:\n${error.name}: ${error.message}`.slice(
    0,
    10_000,
  );
}

/** The diagnostics are a courtesy: never let them stop the feedback itself. */
function diagnosticsFor(store: Store) {
  try {
    return collectFeedbackDiagnostics(store);
  } catch {
    return undefined;
  }
}

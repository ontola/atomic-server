// @wc-ignore-file
import * as Sentry from '@sentry/react';

export async function submitFeedback(
  message: string,
  email: string,
  source = 'sidebar',
): Promise<string> {
  if (!message.trim()) throw new Error('Feedback is empty');
  if (!Sentry.isEnabled()) throw new Error('Feedback reporting is unavailable');

  return Sentry.sendFeedback(
    {
      message: message.trim(),
      email: email.trim() || undefined,
      url: '',
      source,
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

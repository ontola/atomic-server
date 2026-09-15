// @wc-ignore-file
import * as Sentry from '@sentry/react';

export async function submitFeedback(
  message: string,
  email: string,
  diagnostics?: string,
): Promise<string> {
  if (!message.trim()) throw new Error('Feedback is empty');
  if (!Sentry.isEnabled()) throw new Error('Feedback reporting is unavailable');

  return Sentry.sendFeedback(
    {
      message: diagnostics
        ? `${message.trim()}\n\nLocal diagnostic report (shared explicitly):\n${diagnostics}`
        : message.trim(),
      email: email.trim() || undefined,
      url: '',
      source: 'sidebar',
    },
    { includeReplay: false },
  );
}

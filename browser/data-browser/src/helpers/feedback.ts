// @wc-ignore-file
import * as Sentry from '@sentry/react';

export const FEEDBACK_MESSAGE_MAX_LENGTH = 4096;

export async function submitFeedback(
  message: string,
  email: string,
  source = 'sidebar',
  diagnostics?: string,
): Promise<string> {
  if (!message.trim()) throw new Error('Feedback is empty');

  if (message.trim().length > FEEDBACK_MESSAGE_MAX_LENGTH) {
    throw new Error('Feedback must be at most 4096 characters');
  }

  if (!Sentry.isEnabled()) throw new Error('Feedback reporting is unavailable');

  return Sentry.sendFeedback(
    {
      message: message.trim(),
      email: email.trim() || undefined,
      url: '',
      source,
    },
    {
      includeReplay: false,
      ...(diagnostics
        ? {
            attachments: [
              {
                filename: 'diagnostics.json',
                contentType: 'application/json',
                data: diagnostics,
              },
            ],
          }
        : {}),
    },
  );
}

/** Prefill a report without attaching a stack trace or the current resource URL. */
export function errorFeedbackMessage(error: Error): string {
  return `I encountered this error:\n${error.name}: ${error.message}`.slice(
    0,
    10_000,
  );
}

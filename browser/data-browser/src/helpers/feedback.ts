// @wc-ignore-file
import * as Sentry from '@sentry/react';

export const FEEDBACK_MESSAGE_MAX_LENGTH = 4096;

export async function submitFeedback(
  message: string,
  email: string,
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
      source: 'sidebar',
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

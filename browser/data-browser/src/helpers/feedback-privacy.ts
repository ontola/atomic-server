// @wc-ignore-file
import type { Event } from '@sentry/react';

/** Feedback must not inherit scope breadcrumbs, private URLs, or user context. */
export function sanitizeFeedbackEvent(event: Event): Event {
  if (event.type !== 'feedback') return event;
  const feedback = event.contexts?.feedback;

  return {
    type: 'feedback',
    event_id: event.event_id,
    timestamp: event.timestamp,
    release: event.release,
    environment: event.environment,
    contexts: {
      feedback: {
        message: typeof feedback?.message === 'string' ? feedback.message : '',
        contact_email:
          typeof feedback?.contact_email === 'string'
            ? feedback.contact_email
            : undefined,
        source: 'sidebar',
        url: '',
      },
    },
  };
}

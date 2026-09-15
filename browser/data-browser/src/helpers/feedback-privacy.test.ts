import { expect, it } from 'vitest';
import { sanitizeFeedbackEvent } from './feedback-privacy';

it('excludes inherited private context from the final feedback event', () => {
  const report = sanitizeFeedbackEvent({
    type: 'feedback',
    event_id: 'event',
    release: 'build',
    request: { url: 'https://private.example/SECRET_URL' },
    breadcrumbs: [{ message: 'SECRET_CONSOLE' }],
    user: { email: 'SECRET_EMAIL' },
    extra: { data: 'SECRET_TEXT' },
    tags: { path: 'SECRET_PATH' },
    contexts: {
      private: { value: 'SECRET_CONTEXT' },
      feedback: {
        message: 'Explicit feedback',
        contact_email: 'reply@example.com',
        url: 'SECRET_URL',
        name: 'SECRET_NAME',
      },
    },
  });
  expect(JSON.stringify(report)).not.toContain('SECRET');
  expect(report.contexts?.feedback).toEqual({
    message: 'Explicit feedback',
    contact_email: 'reply@example.com',
    source: 'sidebar',
    url: '',
  });
});

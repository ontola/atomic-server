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

it('retains browser and OS metadata without unrelated request or context data', () => {
  const report = sanitizeFeedbackEvent({
    type: 'feedback',
    platform: 'javascript',
    level: 'info',
    request: {
      url: 'SECRET_URL',
      headers: {
        'User-Agent': 'Mozilla/5.0 test-browser',
        Cookie: 'SECRET_COOKIE',
        Referer: 'SECRET_REFERER',
      },
      data: 'SECRET_BODY',
    },
    contexts: {
      browser: { name: 'Chrome', version: '153.0', private: 'SECRET_BROWSER' },
      os: { name: 'macOS', version: '15.0', private: 'SECRET_OS' },
      device: { name: 'SECRET_DEVICE' },
      feedback: { message: 'Problem' },
    },
  });
  expect(report.platform).toBe('javascript');
  expect(report.level).toBe('info');
  expect(report.contexts?.browser).toEqual({
    name: 'Chrome',
    version: '153.0',
  });
  expect(report.contexts?.os).toEqual({ name: 'macOS', version: '15.0' });
  expect(report.request).toEqual({
    headers: { 'User-Agent': 'Mozilla/5.0 test-browser' },
  });
  expect(JSON.stringify(report)).not.toContain('SECRET');
});

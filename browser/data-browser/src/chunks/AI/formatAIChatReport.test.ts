import { expect, it } from 'vitest';
import type { AtomicUIMessage } from './types';
import {
  formatAIChatReport,
  MAX_AI_CHAT_REPORT_LENGTH,
} from './formatAIChatReport';

it('includes chat text and errors but excludes attachment data and tool payloads', () => {
  const messages = [
    {
      id: 'user',
      role: 'user',
      parts: [
        { type: 'text', text: 'Please summarize this document' },
        {
          type: 'file',
          mediaType: 'text/plain',
          filename: 'private.txt',
          url: 'data:text/plain,secret-file-content',
        },
      ],
    },
    {
      id: 'assistant',
      role: 'assistant',
      parts: [{ type: 'text', text: 'I could not read it' }],
      metadata: { error: 'Provider timed out' },
    },
  ] as AtomicUIMessage[];

  const { text, omittedMessages } = formatAIChatReport('My chat', messages);
  expect(text).toContain('AI chat: My chat');
  expect(text).toContain('Please summarize this document');
  expect(text).toContain('[Attachment: private.txt]');
  expect(text).toContain('Error: Provider timed out');
  expect(text).not.toContain('secret-file-content');
  expect(omittedMessages).toBe(0);
});

it('keeps the latest messages and states when earlier ones were omitted', () => {
  const messages = Array.from({ length: 5 }, (_, index) => ({
    id: String(index),
    role: 'user' as const,
    parts: [{ type: 'text' as const, text: `${index}: ${'x'.repeat(20_000)}` }],
  }));

  const { text, omittedMessages } = formatAIChatReport('Long chat', messages);
  expect(text.length).toBeLessThanOrEqual(MAX_AI_CHAT_REPORT_LENGTH);
  expect(omittedMessages).toBeGreaterThan(0);
  expect(text).toContain('earlier messages omitted');
  expect(text).toContain('4:');
  expect(text).not.toContain('0:');
});

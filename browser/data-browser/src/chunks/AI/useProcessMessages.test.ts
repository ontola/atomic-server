import { describe, expect, it } from 'vitest';
import {
  appendTransientContextToLastUser,
  buildIndexingWarningContext,
} from './useProcessMessagesHelpers';
import type { AtomicUIMessage } from './types';

const message = (
  id: string,
  role: AtomicUIMessage['role'],
  text: string,
): AtomicUIMessage => ({
  id,
  role,
  parts: [{ type: 'text', text }],
});

describe('appendTransientContextToLastUser', () => {
  it('appends indexing context to the last user message', () => {
    const messages = [
      message('1', 'user', 'First'),
      message('2', 'assistant', 'Reply'),
      message('3', 'user', 'Second'),
    ];

    const result = appendTransientContextToLastUser(
      messages,
      buildIndexingWarningContext(),
    );

    expect(result[0].parts).toHaveLength(1);
    expect(result[2].parts).toHaveLength(2);
    expect(result[2].parts[1]).toMatchObject({
      type: 'text',
      text: expect.stringContaining('semantic_search can return incomplete'),
    });
  });

  it('does not change messages when there is no transient context', () => {
    const messages = [message('1', 'user', 'Hello')];

    expect(appendTransientContextToLastUser(messages, '')).toBe(messages);
  });
});

import { describe, expect, it } from 'vitest';
import { ai } from '@tomic/react';
import type { ToolUIPart } from 'ai';
import {
  modelMessagesWithToolRecovery,
  restoreToolPart,
  toolPartValues,
} from './toolHistory';
import type { AtomicUIMessage } from './types';

const roundTrip = (part: ToolUIPart) => {
  const values = toolPartValues(part);
  return restoreToolPart({
    toolName: values[ai.properties.toolName],
    toolId: values[ai.properties.toolId],
    toolInput: values[ai.properties.toolInput],
    toolOutput: values[ai.properties.toolOutput],
    toolResultIsError: values[ai.properties.toolResultIsError],
  });
};
describe('tool history recovery', () => {
  it.each(['input-streaming', 'input-available'] as const)(
    'continues after %s without inventing a result or replaying a call',
    async state => {
      const messages: AtomicUIMessage[] = [
        {
          id: 'a',
          role: 'assistant',
          parts: [
            { type: 'tool-save', toolCallId: 'call_3517162', state, input: {} },
            {
              type: 'tool-read',
              toolCallId: 'done',
              state: 'output-available',
              input: {},
              output: { price: 3 },
            },
          ],
        },
        { id: 'u', role: 'user', parts: [{ type: 'text', text: 'Continue' }] },
      ];
      const before = structuredClone(messages);
      const result = await modelMessagesWithToolRecovery(messages);
      const serialized = JSON.stringify(result);
      expect(serialized).toContain('outcome is unknown');
      expect(serialized).not.toContain('"toolCallId":"call_3517162"');
      expect(serialized).toContain('"toolCallId":"done"');
      expect(serialized).toContain('"type":"tool-result"');
      expect(serialized).toContain('Continue');
      expect(messages).toEqual(before);
    },
  );
  it.each([false, 0, '', null])(
    'preserves completed output %s through storage',
    output => {
      const part: ToolUIPart = {
        type: 'tool-example',
        toolCallId: 'done',
        state: 'output-available',
        input: {},
        output,
      };
      expect(roundTrip(part)).toEqual(part);
    },
  );
  it('preserves tool failures as model-visible errors after reloading', async () => {
    const part: ToolUIPart = {
      type: 'tool-save',
      toolCallId: 'failed',
      state: 'output-error',
      input: {},
      errorText: 'Write denied',
    };
    expect(roundTrip(part)).toEqual(part);
    const converted = await modelMessagesWithToolRecovery([
      { id: 'a', role: 'assistant', parts: [roundTrip(part)] },
    ]);
    expect(JSON.stringify(converted)).toContain('Write denied');
    expect(JSON.stringify(converted)).toContain('error-text');
  });
});

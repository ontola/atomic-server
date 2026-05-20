// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  formatMessageMetadataContext,
  MAX_CONVERSATION_JSON_CHARS,
  MAX_SERVER_CONTEXT_CHARS,
  MAX_TOOL_OUTPUT_CHARS,
  prepareConversationForSummary,
  serializeForSummary,
  truncateText,
} from './prepareConversationForSummary';
import { type AtomicUIMessage } from './types';

const userMessage = (parts: AtomicUIMessage['parts']): AtomicUIMessage => ({
  id: 'user-1',
  role: 'user',
  parts,
});

const assistantMessage = (
  parts: AtomicUIMessage['parts'],
): AtomicUIMessage => ({
  id: 'assistant-1',
  role: 'assistant',
  parts,
});

describe('prepareConversationForSummary', () => {
  it('keeps text parts and strips reasoning', () => {
    const prepared = prepareConversationForSummary([
      assistantMessage([
        { type: 'text', text: 'Hello' },
        { type: 'reasoning', text: 'hidden chain of thought' },
      ]),
    ]);

    expect(prepared).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', text: 'Hello' }],
      },
    ]);
  });

  it('serializes tool calls with truncated output', () => {
    const largeOutput = { items: 'x'.repeat(MAX_TOOL_OUTPUT_CHARS + 500) };
    const prepared = prepareConversationForSummary([
      assistantMessage([
        {
          type: 'tool-semantic_search',
          toolCallId: 'call-1',
          state: 'output-available',
          input: { query: 'cats', description: 'Find cats' },
          output: largeOutput,
        },
      ]),
    ]);

    const toolText = prepared[0]?.parts[0]?.text ?? '';
    expect(toolText).toContain(
      '[tool-call: semantic_search (output-available)]',
    );
    expect(toolText).toContain('input:');
    expect(toolText).toContain('output:');
    expect(toolText).toContain('...[truncated]');
    expect(toolText.length).toBeLessThan(largeOutput.items.length);
  });

  it('annotates file parts without embedding data URLs', () => {
    const prepared = prepareConversationForSummary([
      userMessage([
        {
          type: 'file',
          url: 'data:image/png;base64,' + 'A'.repeat(10_000),
          mediaType: 'image/png',
          filename: 'photo.png',
        },
      ]),
    ]);

    expect(prepared[0]?.parts[0]?.text).toBe(
      '[attachment: photo.png (image/png)]',
    );
  });

  it('includes message metadata context', () => {
    const prepared = prepareConversationForSummary([
      {
        id: 'user-2',
        role: 'user',
        parts: [{ type: 'text', text: 'What is this?' }],
        metadata: {
          userContext: [
            {
              type: 'atomic-resource',
              id: '1',
              subject: 'https://example.com/resource',
            },
          ],
          serverContext: 'RAG snippet about the drive',
        },
      },
    ]);

    const contextPart = prepared[0]?.parts[0]?.text ?? '';
    expect(contextPart).toContain('<message-context>');
    expect(contextPart).toContain(
      'atomic-resource: https://example.com/resource',
    );
    expect(contextPart).toContain('rag-context:\nRAG snippet about the drive');
    expect(prepared[0]?.parts[1]?.text).toBe('What is this?');
  });

  it('drops oldest messages when JSON exceeds the cap', () => {
    // Two ~70k payloads exceed MAX_CONVERSATION_JSON_CHARS; one fits with keep-me.
    const huge = 'z'.repeat(70_000);
    const prepared = prepareConversationForSummary([
      userMessage([{ type: 'text', text: huge }]),
      userMessage([{ type: 'text', text: huge }]),
      userMessage([{ type: 'text', text: 'keep-me' }]),
    ]);

    expect(prepared).toHaveLength(2);
    expect(prepared.some(m => m.parts.some(p => p.text === 'keep-me'))).toBe(
      true,
    );
    expect(JSON.stringify(prepared).length).toBeLessThanOrEqual(
      MAX_CONVERSATION_JSON_CHARS,
    );
  });
});

describe('formatMessageMetadataContext', () => {
  it('truncates oversized server context', () => {
    const context = formatMessageMetadataContext({
      serverContext: 'a'.repeat(MAX_SERVER_CONTEXT_CHARS + 100),
    });

    expect(context).toContain('[RAG context truncated.]');
    expect(context!.length).toBeLessThan(MAX_SERVER_CONTEXT_CHARS + 200);
  });
});

describe('serializeForSummary', () => {
  it('truncates long strings', () => {
    expect(serializeForSummary('b'.repeat(100), 20)).toContain(
      '...[truncated]',
    );
  });
});

describe('truncateText', () => {
  it('returns short text unchanged', () => {
    expect(truncateText('hi', 10)).toBe('hi');
  });
});

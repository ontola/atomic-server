// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import type { JSONContent } from '@tiptap/core';
import { tiptapJsonToAgentXml } from './tiptapJsonToAgentXml';

describe('tiptapJsonToAgentXml', () => {
  it('serializes a paragraph and bullet list', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'The following points need addressing:' },
          ],
        },
        {
          type: 'bulletList',
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'No more breaks longer than 20 minutes.',
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };

    expect(tiptapJsonToAgentXml(doc)).toBe(
      [
        '<paragraph>The following points need addressing:</paragraph>',
        '<bulletList>',
        '  <listItem>',
        '    <paragraph>No more breaks longer than 20 minutes.</paragraph>',
        '  </listItem>',
        '</bulletList>',
      ].join('\n'),
    );
  });

  it('serializes bold text with mark wrappers', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Important',
              marks: [{ type: 'bold' }],
            },
          ],
        },
      ],
    };

    expect(tiptapJsonToAgentXml(doc)).toBe(
      '<paragraph><bold>Important</bold></paragraph>',
    );
  });

  it('serializes atom resource blocks as self-closing tags', () => {
    const doc: JSONContent = {
      type: 'doc',
      content: [
        {
          type: 'atomic-data-resource',
          attrs: { subject: 'https://example.com/resource' },
        },
      ],
    };

    expect(tiptapJsonToAgentXml(doc)).toBe(
      '<atomic-data-resource subject="https://example.com/resource"/>',
    );
  });

  it('returns an empty string for an empty doc', () => {
    expect(tiptapJsonToAgentXml({ type: 'doc', content: [] })).toBe('');
  });
});

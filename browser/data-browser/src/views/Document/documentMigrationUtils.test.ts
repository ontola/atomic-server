// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import {
  extractYDocBytes,
  isSerializedYDoc,
  isYjsMigrationCandidate,
  resourceEmbedNode,
  tiptapJsonHasVisibleContent,
  wrapTiptapContent,
  yjsXmlFragmentToTiptapJSON,
} from './documentMigrationUtils';

describe('isSerializedYDoc', () => {
  it('accepts the JSON-AD ydoc wrapper', () => {
    expect(isSerializedYDoc({ type: 'ydoc', data: 'AAAA' })).toBe(true);
  });

  it('accepts an Unsupported leftover tagged as ydoc', () => {
    expect(
      isSerializedYDoc({
        value: 'AAAA',
        datatype: 'https://atomicdata.dev/datatypes/ydoc',
      }),
    ).toBe(true);
  });

  it('rejects lorodoc wrappers, strings, and bytes', () => {
    expect(isSerializedYDoc({ type: 'lorodoc', data: 'AAAA' })).toBe(false);
    expect(isSerializedYDoc('not-a-ydoc')).toBe(false);
    expect(isSerializedYDoc(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(isSerializedYDoc(undefined)).toBe(false);
  });
});

describe('isYjsMigrationCandidate', () => {
  it('always treats a typed ydoc wrapper as a candidate', () => {
    expect(isYjsMigrationCandidate({ type: 'ydoc', data: 'AAAA' }, false)).toBe(
      true,
    );
  });

  it('ignores bare strings and bytes once Loro already has a body', () => {
    expect(isYjsMigrationCandidate('a'.repeat(40), false)).toBe(false);
    expect(isYjsMigrationCandidate(new Uint8Array([1, 2, 3]), false)).toBe(
      false,
    );
  });

  it('treats long strings and bytes as candidates only when Loro is empty', () => {
    expect(isYjsMigrationCandidate('a'.repeat(40), true)).toBe(true);
    expect(isYjsMigrationCandidate(new Uint8Array([1, 2, 3]), true)).toBe(true);
    expect(isYjsMigrationCandidate('short', true)).toBe(false);
  });
});

describe('extractYDocBytes', () => {
  it('decodes the JSON-AD wrapper', () => {
    const data = Buffer.from([1, 2, 3, 4]).toString('base64');

    expect(Array.from(extractYDocBytes({ type: 'ydoc', data }) ?? [])).toEqual([
      1, 2, 3, 4,
    ]);
  });
});

describe('v1 element assembly', () => {
  it('wraps paragraph JSON and resource embeds into a doc', () => {
    const doc = wrapTiptapContent([
      {
        type: 'paragraph',
        content: [{ type: 'text', text: 'Hello from v1' }],
      },
      resourceEmbedNode('https://example.com/table'),
    ]);

    expect(doc).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Hello from v1' }],
        },
        {
          type: 'atomic-data-resource',
          attrs: { subject: 'https://example.com/table' },
        },
      ],
    });
    expect(tiptapJsonHasVisibleContent(doc)).toBe(true);
  });

  it('uses an empty paragraph when there is nothing to migrate', () => {
    expect(wrapTiptapContent([])).toEqual({
      type: 'doc',
      content: [{ type: 'paragraph' }],
    });
    expect(tiptapJsonHasVisibleContent(wrapTiptapContent([]))).toBe(false);
  });
});

describe('yjsXmlFragmentToTiptapJSON', () => {
  it('walks paragraphs, marks, headings, and resource embeds', () => {
    const ydoc = new Y.Doc();
    const fragment = ydoc.getXmlFragment('content');

    const paragraph = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'Hello world');
    text.format(0, 5, { bold: true });
    paragraph.insert(0, [text]);

    const heading = new Y.XmlElement('heading');
    heading.setAttribute('level', '1');
    const headingText = new Y.XmlText();
    headingText.insert(0, 'Title');
    heading.insert(0, [headingText]);

    const embed = new Y.XmlElement('atomic-data-resource');
    embed.setAttribute('subject', 'https://example.com/embed');

    fragment.insert(0, [heading, paragraph, embed]);

    expect(yjsXmlFragmentToTiptapJSON(fragment)).toEqual({
      type: 'doc',
      content: [
        {
          type: 'heading',
          attrs: { level: 1 },
          content: [{ type: 'text', text: 'Title' }],
        },
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'Hello',
              marks: [{ type: 'bold' }],
            },
            { type: 'text', text: ' world' },
          ],
        },
        {
          type: 'atomic-data-resource',
          attrs: { subject: 'https://example.com/embed' },
        },
      ],
    });

    ydoc.destroy();
  });
});

import { LoroDoc, type LoroList, type LoroMap, type LoroText } from 'loro-crdt';
import { expect, it } from 'vitest';
import { writeDocumentText } from './document-body.js';
import { documentText } from './document-text.js';

const roundTrip = (text: string) => {
  const doc = new LoroDoc();
  writeDocumentText(doc, text);

  return doc;
};

const json = (doc: LoroDoc) => doc.getMap('doc').toJSON();

it('writes a body that reads back as the same text', () => {
  const text = [
    '# Plan',
    '',
    'Intro paragraph.',
    '',
    '- one',
    '  - nested',
    '- [ ] open task',
    '- [x] done task',
    '',
    '```ts',
    'const a = 1;',
    '```',
    '',
    '---',
  ].join('\n');

  const doc = roundTrip(text);
  const root = json(doc) as { nodeName: string; children: unknown[] };

  expect(root.nodeName).toBe('doc');
  expect(documentText(doc)).toBe(
    [
      '# Plan',
      '',
      'Intro paragraph.',
      '- one',
      '  - nested',
      '- [ ] open task',
      '- [x] done task',
      '```',
      'const a = 1;',
      '```',
      '---',
    ].join('\n'),
  );
});

it('uses the node types the editor schema knows', () => {
  const root = json(roundTrip('1. a\n2. b\n\n> quoted\n\n- [x] t')) as {
    children: { nodeName: string; attributes: Record<string, unknown> }[];
  };

  expect(root.children.map(c => c.nodeName)).toEqual([
    'orderedList',
    'blockquote',
    'taskList',
  ]);
});

it('stores task state and heading level as attributes', () => {
  const root = json(roundTrip('## Two\n\n- [x] done')) as {
    children: {
      attributes: Record<string, unknown>;
      children: { attributes: Record<string, unknown> }[];
    }[];
  };

  expect(root.children[0].attributes).toEqual({ level: 2 });
  expect(root.children[1].children[0].attributes).toEqual({ checked: true });
});

it('keeps inline marks as text attributes', () => {
  const doc = roundTrip(
    'a **bold** and *it* with `code` and [x](https://e.org)',
  );
  const root = doc.getMap('doc').get('children') as LoroList;
  const paragraph = root.get(0) as LoroMap;
  const text = (paragraph.get('children') as LoroList).get(0) as LoroText;
  const delta = text.toDelta() as {
    insert: string;
    attributes?: Record<string, unknown>;
  }[];

  expect(delta.map(d => d.insert).join('')).toBe(
    'a bold and it with code and x',
  );
  expect(delta.find(d => d.insert === 'bold')?.attributes).toEqual({
    bold: {},
  });
  expect(delta.find(d => d.insert === 'x')?.attributes).toEqual({
    link: { href: 'https://e.org' },
  });
});

it('leaves snake_case and unmatched markers alone', () => {
  expect(documentText(roundTrip('use snake_case_name and 2 * 3 here'))).toBe(
    'use snake_case_name and 2 * 3 here',
  );
});

it('replaces an earlier body', () => {
  const doc = roundTrip('first');
  writeDocumentText(doc, 'second');

  expect(documentText(doc)).toBe('second');
});

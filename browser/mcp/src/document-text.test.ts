import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt';
import { expect, it } from 'vitest';
import { documentText } from './document-text.js';

/** Builds a node the way loro-prosemirror stores one. */
function node(
  parent: LoroList,
  nodeName: string,
  children: (string | ((list: LoroList) => void))[],
  attributes: Record<string, unknown> = {},
) {
  const map = parent.pushContainer(new LoroMap());
  map.set('nodeName', nodeName);
  const attrs = map.setContainer('attributes', new LoroMap());

  for (const [key, value] of Object.entries(attributes)) attrs.set(key, value);

  const list = map.setContainer('children', new LoroList());

  for (const child of children) {
    if (typeof child === 'string') {
      list.pushContainer(new LoroText()).insert(0, child);
    } else {
      child(list);
    }
  }
}

it('reads headings, paragraphs and nested list items', () => {
  const doc = new LoroDoc();
  const root = doc.getMap('doc');
  root.set('nodeName', 'doc');
  const children = root.setContainer('children', new LoroList());

  node(children, 'heading', ['Agenda'], { level: 2 });
  node(children, 'paragraph', ['Welcome everyone.']);
  node(children, 'bulletList', [
    list =>
      node(list, 'listItem', [
        l => node(l, 'paragraph', ['Budget']),
        l =>
          node(l, 'bulletList', [
            inner =>
              node(inner, 'listItem', [p => node(p, 'paragraph', ['Q4'])]),
          ]),
      ]),
  ]);
  node(children, 'taskList', [
    list =>
      node(list, 'taskItem', [l => node(l, 'paragraph', ['Send notes'])], {
        checked: true,
      }),
  ]);

  expect(documentText(doc)).toBe(
    '## Agenda\n\nWelcome everyone.\n- Budget\n  - Q4\n- [x] Send notes',
  );
});

it('returns an empty string for a document without a body', () => {
  expect(documentText(new LoroDoc())).toBe('');
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  LoroDoc,
  LoroList,
  LoroMap,
  LoroText,
  type JsonSchema,
} from 'loro-crdt';
import { LoroSyncPlugin, type LoroDocType } from 'loro-prosemirror';

// The application aliases Loro to its web build; these DOM-free tests use Node WASM.
vi.mock('loro-crdt', () => import('loro-crdt/nodejs'));

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: {
    bold: { inclusive: true },
    link: { attrs: { href: {} } },
  },
});

type TestView = {
  state: EditorState;
  isDestroyed: boolean;
  dispatch(transaction: Transaction): void;
};

function editor(doc = new LoroDoc() as unknown as LoroDocType) {
  const plugin = LoroSyncPlugin({ doc });
  const view: TestView = {
    state: EditorState.create({ schema, plugins: [plugin] }),
    isDestroyed: false,
    dispatch(transaction: Transaction) {
      this.state = this.state.applyTransaction(transaction).state;
    },
  };

  return { doc, plugin, view };
}

function paragraphText(doc: LoroDocType): LoroText {
  const root = doc.getMap('doc') as LoroMap;
  const paragraphs = root.get('children') as LoroList<LoroMap>;
  const paragraph = paragraphs.get(0);
  const children = paragraph.get('children') as LoroList<LoroText>;

  return children.get(0);
}

function markOperationCount(doc: LoroDocType): number {
  const updates: JsonSchema = doc.exportJsonUpdates();

  return updates.changes
    .flatMap(change => change.ops)
    .filter(operation => operation.content.type === 'mark').length;
}

function hasBoldPhrase(text: LoroText) {
  return text
    .toDelta()
    .some(
      part =>
        part.insert?.includes('bold') && part.attributes?.bold !== undefined,
    );
}

async function legacyHistoryFixture() {
  const seeded = editor();
  const lifecycle = seeded.plugin.spec.view!(
    seeded.view as unknown as EditorView,
  );
  await vi.runOnlyPendingTimersAsync();
  const bold = schema.mark('bold');
  seeded.view.dispatch(
    seeded.view.state.tr.replaceWith(
      0,
      seeded.view.state.doc.content.size,
      schema.node('paragraph', null, [
        schema.text('before '),
        schema.text('bold', [bold]),
        schema.text(' tail '),
      ]),
    ),
  );

  const text = paragraphText(seeded.doc);
  const beforeBold = 'before bold'.length;

  for (let index = 0; index < 600; index += 1) {
    text.applyDelta([{ retain: text.length }, { insert: 'x' }]);
    // Historical whole-run reconciliation redundantly unmarked only the
    // already-plain tail. It must never clear the preceding bold phrase.
    text.applyDelta([
      { retain: beforeBold },
      { retain: text.length - beforeBold, attributes: { bold: null } },
    ]);
    seeded.doc.commit({ origin: 'legacy-history-fixture' });
  }

  expect(hasBoldPhrase(text)).toBe(true);
  expect(markOperationCount(seeded.doc)).toBeGreaterThanOrEqual(600);

  const imported = new LoroDoc() as unknown as LoroDocType;
  imported.import(seeded.doc.export({ mode: 'snapshot' }));
  seeded.view.isDestroyed = true;
  lifecycle.destroy?.();

  return imported;
}

async function initialized(doc?: LoroDocType) {
  const instance = editor(doc);
  const lifecycle = instance.plugin.spec.view!(
    instance.view as unknown as EditorView,
  );
  await vi.runOnlyPendingTimersAsync();

  return { ...instance, lifecycle };
}

function destroy(instance: Awaited<ReturnType<typeof initialized>>) {
  instance.view.isDestroyed = true;
  instance.lifecycle.destroy?.();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('LoroSyncPlugin typing history', () => {
  it.each([true, false])(
    'keeps the pending bold toggle (%s) when a remote update arrives before typing',
    async enabled => {
      vi.useFakeTimers();
      const instance = await initialized();

      try {
        instance.view.dispatch(instance.view.state.tr.insertText('plain '));

        if (!enabled) {
          instance.view.dispatch(
            instance.view.state.tr.addMark(1, 7, schema.mark('bold')),
          );
        }

        const remote = new LoroDoc();
        remote.import(instance.doc.export({ mode: 'snapshot' }));
        instance.view.dispatch(
          instance.view.state.tr.setStoredMarks(
            enabled ? [schema.mark('bold')] : [],
          ),
        );

        // Even a receipt/property import replaces the editor document. The
        // local toolbar/keyboard choice must survive that replacement.
        remote.getMap('properties').set('receipt', 'saved');
        remote.commit();
        instance.doc.import(remote.export({ mode: 'snapshot' }));
        expect(instance.view.state.storedMarks).toEqual(
          enabled ? [schema.mark('bold')] : [],
        );
        instance.view.dispatch(instance.view.state.tr.insertText('next'));
        expect(instance.view.state.doc.lastChild?.lastChild?.marks).toEqual(
          enabled ? [schema.mark('bold')] : [],
        );
      } finally {
        destroy(instance);
      }
    },
  );

  it('keeps imported legacy formatting history stable while typing a plain tail', async () => {
    vi.useFakeTimers();
    const instance = await initialized(await legacyHistoryFixture());

    try {
      const text = paragraphText(instance.doc);
      const id = text.id;
      const marksBeforeTyping = markOperationCount(instance.doc);
      expect(marksBeforeTyping).toBeGreaterThanOrEqual(600);
      expect(hasBoldPhrase(text)).toBe(true);

      const toDelta = vi.spyOn(LoroText.prototype, 'toDelta');

      for (let index = 0; index < 20; index += 1) {
        instance.view.dispatch(
          instance.view.state.tr.insertText(
            'y',
            instance.view.state.doc.content.size - 1,
          ),
        );
      }

      expect(toDelta).not.toHaveBeenCalled();
      expect(markOperationCount(instance.doc)).toBe(marksBeforeTyping);
      expect(paragraphText(instance.doc).id).toEqual(id);
      expect(hasBoldPhrase(paragraphText(instance.doc))).toBe(true);
      expect(paragraphText(instance.doc).toString()).toBe(
        'before bold tail ' + 'x'.repeat(600) + 'y'.repeat(20),
      );
      expect(instance.view.state.doc.textContent).toBe(
        'before bold tail ' + 'x'.repeat(600) + 'y'.repeat(20),
      );
    } finally {
      destroy(instance);
    }
  });

  it('preserves UTF-16 replacements and Loro mark boundaries on the direct path', async () => {
    vi.useFakeTimers();
    const instance = await initialized();

    try {
      const bold = schema.mark('bold');
      instance.view.dispatch(
        instance.view.state.tr.replaceWith(
          0,
          instance.view.state.doc.content.size,
          schema.node('paragraph', null, [
            schema.text('a😀'),
            schema.text('bold', [bold]),
            schema.text('z'),
          ]),
        ),
      );
      instance.view.dispatch(instance.view.state.tr.insertText('!', 4));
      instance.view.dispatch(instance.view.state.tr.insertText('Q', 5, 9));

      const delta = paragraphText(instance.doc).toDelta();
      expect(instance.view.state.doc.textContent).toBe('a😀!Qz');
      expect(delta).toEqual([
        { insert: 'a😀!' },
        { insert: 'Q', attributes: { bold: {} } },
        { insert: 'z' },
      ]);
    } finally {
      destroy(instance);
    }
  });

  it('writes mark-only and link changes into the Loro delta', async () => {
    vi.useFakeTimers();
    const instance = await initialized();

    try {
      instance.view.dispatch(instance.view.state.tr.insertText('plain'));
      instance.view.dispatch(
        instance.view.state.tr.addMark(1, 6, schema.mark('bold')),
      );
      expect(paragraphText(instance.doc).toDelta()).toEqual([
        { insert: 'plain', attributes: { bold: {} } },
      ]);

      instance.view.dispatch(
        instance.view.state.tr.removeMark(1, 6, schema.mark('bold')),
      );
      instance.view.dispatch(
        instance.view.state.tr.addMark(
          1,
          6,
          schema.mark('link', { href: 'https://atomicdata.dev' }),
        ),
      );
      expect(paragraphText(instance.doc).toDelta()).toEqual([
        {
          insert: 'plain',
          attributes: { link: { href: 'https://atomicdata.dev' } },
        },
      ]);
    } finally {
      destroy(instance);
    }
  });

  it('keeps a closed inline composition ReplaceStep on the direct path', async () => {
    vi.useFakeTimers();
    const instance = await initialized();

    try {
      instance.view.dispatch(instance.view.state.tr.insertText('seed'));
      const toDelta = vi.spyOn(LoroText.prototype, 'toDelta');
      instance.view.dispatch(
        instance.view.state.tr
          .insertText('ime', 5)
          .setMeta('composition', 'ime'),
      );

      expect(toDelta).not.toHaveBeenCalled();
      expect(paragraphText(instance.doc).toDelta()).toEqual([
        { insert: 'seedime' },
      ]);
    } finally {
      destroy(instance);
    }
  });

  it('bounds multi-step fallback materialization per edited LoroText', async () => {
    vi.useFakeTimers();
    const instance = await initialized();

    try {
      instance.view.dispatch(instance.view.state.tr.insertText('seed'));
      const toDelta = vi.spyOn(LoroText.prototype, 'toDelta');
      instance.view.dispatch(
        instance.view.state.tr.insertText('a', 5).insertText('b', 6),
      );

      expect(toDelta.mock.calls.length).toBeLessThanOrEqual(2);
      expect(paragraphText(instance.doc).toDelta()).toEqual([
        { insert: 'seedab' },
      ]);
    } finally {
      destroy(instance);
    }
  });
});

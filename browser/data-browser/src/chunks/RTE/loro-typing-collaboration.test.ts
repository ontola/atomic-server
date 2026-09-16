import { afterEach, describe, expect, it, vi } from 'vitest';
import { Schema } from '@tiptap/pm/model';
import { EditorState, type Transaction } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { LoroDoc, LoroList, LoroMap, LoroText } from 'loro-crdt';
import {
  LoroSyncPlugin,
  LoroUndoPlugin,
  redo,
  type LoroDocType,
  undo,
} from 'loro-prosemirror';

// The app aliases Loro to its web build; these DOM-free tests use Node WASM.
vi.mock('loro-crdt', () => import('loro-crdt/nodejs'));

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', group: 'block' },
    text: { group: 'inline' },
  },
  marks: { bold: { inclusive: true } },
});

type TestView = {
  state: EditorState;
  isDestroyed: boolean;
  dispatch(transaction: Transaction): void;
};

function editor(
  doc = new LoroDoc() as unknown as LoroDocType,
  withUndo = false,
) {
  const sync = LoroSyncPlugin({ doc });
  const plugins = withUndo ? [sync, LoroUndoPlugin({ doc })] : [sync];
  const view: TestView = {
    state: EditorState.create({ schema, plugins }),
    isDestroyed: false,
    dispatch(transaction: Transaction) {
      this.state = this.state.applyTransaction(transaction).state;
    },
  };

  return { doc, sync, view };
}

async function initialized(doc?: LoroDocType, withUndo = false) {
  const instance = editor(doc, withUndo);
  const lifecycle = instance.sync.spec.view!(
    instance.view as unknown as EditorView,
  );
  await vi.runOnlyPendingTimersAsync();

  return { ...instance, lifecycle };
}

function paragraphTexts(doc: LoroDocType): LoroText[] {
  const root = doc.getMap('doc') as LoroMap;
  const paragraphs = root.get('children') as LoroList<LoroMap>;

  return paragraphs
    .toArray()
    .map(paragraph => (paragraph.get('children') as LoroList<LoroText>).get(0));
}

function destroy(...editors: Awaited<ReturnType<typeof initialized>>[]) {
  for (const instance of editors) {
    instance.view.isDestroyed = true;
    instance.lifecycle.destroy?.();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('LoroSyncPlugin guarded typing path', () => {
  it('keeps undo, redo, and subsequent typing on the existing LoroText', async () => {
    vi.useFakeTimers();
    const instance = await initialized(undefined, true);

    try {
      instance.view.dispatch(instance.view.state.tr.insertText('one'));

      expect(undo(instance.view.state, tr => instance.view.dispatch(tr))).toBe(
        true,
      );
      expect(instance.view.state.doc.textContent).toBe('');
      expect(redo(instance.view.state, tr => instance.view.dispatch(tr))).toBe(
        true,
      );
      await vi.runOnlyPendingTimersAsync();
      instance.view.dispatch(instance.view.state.tr.insertText('!', 4));

      expect(instance.view.state.doc.textContent).toBe('one!');
      expect(paragraphTexts(instance.doc)[0].toString()).toBe('one!');
    } finally {
      destroy(instance);
    }
  });

  it('converges two initialized editors after concurrent text and mark edits without echoing imports', async () => {
    vi.useFakeTimers();
    const first = await initialized();
    first.view.dispatch(first.view.state.tr.insertText('word'));
    const secondDoc = new LoroDoc() as unknown as LoroDocType;
    secondDoc.import(first.doc.export({ mode: 'snapshot' }));
    const second = await initialized(secondDoc);

    try {
      first.view.dispatch(first.view.state.tr.insertText('A', 1));
      second.view.dispatch(
        second.view.state.tr.addMark(1, 5, schema.mark('bold')),
      );

      const firstBeforeRemote = first.doc.oplogVersion();
      const secondBeforeRemote = second.doc.oplogVersion();
      let importedAsLocal = 0;
      const unsubscribe = first.doc.subscribe(event => {
        if (event.by === 'local') importedAsLocal += 1;
      });
      first.doc.import(
        second.doc.export({ mode: 'update', from: firstBeforeRemote }),
      );
      second.doc.import(
        first.doc.export({ mode: 'update', from: secondBeforeRemote }),
      );
      unsubscribe();

      expect(first.view.state.doc.toJSON()).toEqual(
        second.view.state.doc.toJSON(),
      );
      expect(first.view.state.doc.textContent).toBe('Aword');
      const boldText = first.view.state.doc
        .firstChild!.content.content.filter(node =>
          node.marks.some(mark => mark.eq(schema.mark('bold'))),
        )
        .map(node => node.text)
        .join('');
      // Concurrent boundary ordering may either leave A plain or merge it
      // into the bold run, but every original word character stays bold.
      expect(boldText).toContain('word');
      expect(paragraphTexts(first.doc)[0].toDelta()).toEqual(
        paragraphTexts(second.doc)[0].toDelta(),
      );
      expect(importedAsLocal).toBe(0);

      // A remote re-render carries non-local transaction metadata; an empty
      // exchange afterwards confirms there is no deferred echo either.
      const synced = second.doc.oplogVersion();
      second.doc.import(first.doc.export({ mode: 'update', from: synced }));
      expect(second.doc.oplogVersion().toJSON()).toEqual(synced.toJSON());
    } finally {
      destroy(first, second);
    }
  });

  it('keeps duplicate paragraphs mapped to their own LoroText after local and remote changes', async () => {
    vi.useFakeTimers();
    const first = await initialized();
    first.view.dispatch(
      first.view.state.tr.replaceWith(0, first.view.state.doc.content.size, [
        schema.node('paragraph', null, schema.text('same')),
        schema.node('paragraph', null, schema.text('same')),
      ]),
    );
    const secondDoc = new LoroDoc() as unknown as LoroDocType;
    secondDoc.import(first.doc.export({ mode: 'snapshot' }));
    const second = await initialized(secondDoc);

    try {
      const [firstText, secondText] = paragraphTexts(first.doc);
      first.view.dispatch(first.view.state.tr.insertText('!', 5));
      second.view.dispatch(second.view.state.tr.insertText('?', 11));

      const firstBeforeRemote = first.doc.oplogVersion();
      const secondBeforeRemote = second.doc.oplogVersion();
      first.doc.import(
        second.doc.export({ mode: 'update', from: firstBeforeRemote }),
      );
      second.doc.import(
        first.doc.export({ mode: 'update', from: secondBeforeRemote }),
      );

      expect(first.view.state.doc.textContent).toBe('same!same?');
      expect(second.view.state.doc.toJSON()).toEqual(
        first.view.state.doc.toJSON(),
      );
      expect(paragraphTexts(first.doc).map(text => text.id)).toEqual([
        firstText.id,
        secondText.id,
      ]);
    } finally {
      destroy(first, second);
    }
  });

  it('falls back for composition-tagged multi-step edits, then accepts ordinary typing', async () => {
    vi.useFakeTimers();
    const instance = await initialized();

    try {
      const composition = instance.view.state.tr
        .insertText('a')
        .insertText('b')
        .setMeta('composition', 'ime');
      instance.view.dispatch(composition);
      instance.view.dispatch(instance.view.state.tr.insertText('c', 3));

      expect(instance.view.state.doc.textContent).toBe('abc');
      expect(paragraphTexts(instance.doc)[0].toString()).toBe('abc');
    } finally {
      destroy(instance);
    }
  });
});

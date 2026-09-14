import { afterEach, expect, it, vi } from 'vitest';
import { LoroDoc, UndoManager } from 'loro-crdt';
import { Schema } from '@tiptap/pm/model';
import { EditorState, TextSelection } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import {
  LoroSyncPlugin,
  LoroUndoPlugin,
  undo as loroUndo,
  type LoroDocType,
} from 'loro-prosemirror';
import {
  createDocumentUndoViewManager,
  getDocumentUndoManager,
  getDocumentUndoViewManager,
} from './documentUndoSession';

// The app aliases Loro to its web build; this DOM-free test uses Node WASM.
vi.mock('loro-crdt', () => import('loro-crdt/nodejs'));

type Listener = (agent: unknown) => void;

afterEach(() => vi.useRealTimers());

function createStore(initialAgent?: { subject: string }) {
  const listeners = new Set<Listener>();
  let agent = initialAgent;

  return {
    getAgent: () => agent,
    on: (_event: unknown, listener: Listener) => {
      listeners.add(listener);

      return () => listeners.delete(listener);
    },
    changeAgent(nextAgent: unknown) {
      agent = nextAgent as { subject: string } | undefined;
      listeners.forEach(listener => listener(agent));
    },
  };
}

it('keeps undo and redo across editor bindings for the same document session', () => {
  const store = createStore();
  const doc = new LoroDoc();
  const map = doc.getMap('content');
  const first = getDocumentUndoManager(store, doc);

  map.set('text', 'first');
  doc.commit();
  first.undo();
  expect(map.get('text')).toBeUndefined();
  expect(first.canRedo()).toBe(true);

  const second = getDocumentUndoManager(store, doc);
  expect(second).toBe(first);
  second.redo();
  expect(map.get('text')).toBe('first');
});

it('isolates documents and creates a fresh session manager after an auth change', () => {
  const store = createStore();
  const firstDoc = new LoroDoc();
  const replacementDoc = new LoroDoc();
  const first = getDocumentUndoManager(store, firstDoc);
  const firstView = getDocumentUndoViewManager(store, firstDoc);
  firstDoc.getMap('content').set('text', 'old session edit');
  firstDoc.commit();
  expect(firstView.canUndo()).toBe(true);

  expect(getDocumentUndoManager(store, replacementDoc)).not.toBe(first);
  store.changeAgent({ subject: 'did:ad:agent:other' });

  const afterAuthChange = getDocumentUndoManager(store, firstDoc);
  expect(afterAuthChange).not.toBe(first);
  expect(afterAuthChange.canUndo()).toBe(false);
  expect(firstView.canUndo()).toBe(false);
  expect(firstView.undo()).toBe(false);
});

it('keeps history when the same agent refreshes its Store session', () => {
  const store = createStore({ subject: 'did:ad:agent:me' });
  const doc = new LoroDoc();
  const manager = getDocumentUndoManager(store, doc);

  store.changeAgent({ subject: 'did:ad:agent:me' });

  expect(getDocumentUndoManager(store, doc)).toBe(manager);
});

it('excludes system commits and imported remote changes from local undo history', () => {
  const store = createStore();
  const doc = new LoroDoc();
  const map = doc.getMap('content');
  const undoManager = getDocumentUndoManager(store, doc);

  map.set('system', 'metadata');
  doc.commit({ origin: 'atomic:system:metadata' });
  map.set('init', 'schema');
  doc.commit({ origin: 'sys:init' });

  const remote = new LoroDoc();
  remote.getMap('content').set('remote', 'peer edit');
  remote.commit();
  doc.import(remote.export({ mode: 'update' }));

  expect(undoManager.canUndo()).toBe(false);
});

it('does not let an old binding detach callbacks installed by its replacement', async () => {
  const callbacks: { push?: unknown; pop?: unknown } = {};
  const rawManager = {
    setOnPush(listener?: unknown) {
      callbacks.push = listener;
    },
    setOnPop(listener?: unknown) {
      callbacks.pop = listener;
    },
    canUndo: () => false,
    canRedo: () => false,
    undo: () => false,
    redo: () => false,
  };
  const active = () => true;
  const first = createDocumentUndoViewManager(
    rawManager as unknown as UndoManager,
    active,
  );
  const second = createDocumentUndoViewManager(
    rawManager as unknown as UndoManager,
    active,
  );
  const firstPush = (() => ({
    value: null as never,
    cursors: [],
  })) as Parameters<UndoManager['setOnPush']>[0];
  const secondPush = (() => ({
    value: null as never,
    cursors: [],
  })) as Parameters<UndoManager['setOnPush']>[0];

  first.setOnPush(firstPush);
  second.setOnPush(secondPush);
  first.setOnPush();
  await Promise.resolve();

  expect(callbacks.push).toBe(secondPush);
});

it('keeps actual LoroUndoPlugin undo and selection wiring after an overlapping old view tears down', async () => {
  vi.useFakeTimers();
  const schema = new Schema({
    nodes: {
      doc: { content: 'paragraph+' },
      paragraph: { content: 'text*', group: 'block' },
      text: { group: 'inline' },
    },
  });
  const doc = new LoroDoc() as unknown as LoroDocType;
  const seedSync = LoroSyncPlugin({ doc });
  const seedView = {
    state: EditorState.create({ schema, plugins: [seedSync] }),
    isDestroyed: false,
    dispatch(tr: Parameters<EditorView['dispatch']>[0]) {
      this.state = this.state.apply(tr);
    },
  } as EditorView;
  const seedPluginView = seedSync.spec.view?.(seedView);
  await vi.runOnlyPendingTimersAsync();
  seedView.dispatch(seedView.state.tr.insertText('abcd'));
  await vi.runOnlyPendingTimersAsync();
  seedPluginView?.destroy?.();

  const manager = new UndoManager(doc, {
    maxUndoSteps: 100,
    mergeInterval: 1000,
  });

  const makeView = () => {
    const sync = LoroSyncPlugin({ doc });
    const undo = LoroUndoPlugin({
      doc,
      undoManager: createDocumentUndoViewManager(manager, () => true),
    });
    const view = {
      state: EditorState.create({ schema, plugins: [sync, undo] }),
      isDestroyed: false,
      dispatch(tr: Parameters<EditorView['dispatch']>[0]) {
        this.state = this.state.apply(tr);
      },
    } as EditorView;
    const views = [sync, undo].map(plugin => plugin.spec.view?.(view));

    return {
      view,
      destroy: () => views.forEach(pluginView => pluginView?.destroy?.()),
    };
  };

  const oldView = makeView();
  await vi.runOnlyPendingTimersAsync();
  oldView.view.dispatch(
    oldView.view.state.tr.setSelection(
      TextSelection.create(oldView.view.state.doc, 3),
    ),
  );
  oldView.view.dispatch(oldView.view.state.tr.insertText('X'));
  const replacement = makeView();
  await vi.runOnlyPendingTimersAsync();
  oldView.destroy();

  expect(
    loroUndo(
      replacement.view.state,
      replacement.view.dispatch.bind(replacement.view),
    ),
  ).toBe(true);
  await vi.runOnlyPendingTimersAsync();
  expect(replacement.view.state.doc.textContent).toBe('abcd');
  expect(replacement.view.state.selection.anchor).toBe(3);
  replacement.destroy();
});

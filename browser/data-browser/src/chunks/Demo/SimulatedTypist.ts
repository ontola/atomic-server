// React Compiler: plain class, not a component (see DemoDirector.ts).
'use no memo';
import { Editor, Extension } from '@tiptap/core';
import { Selection } from '@tiptap/pm/state';
import {
  CHILDREN_KEY,
  CursorEphemeralStore,
  LoroSyncPlugin,
  ROOT_DOC_KEY,
  type CursorUser,
  type LoroDocType,
} from 'loro-prosemirror';
import type { Cursor, LoroDoc, PeerID } from 'loro-crdt';
import type { Resource, Store } from '@tomic/react';
import { getCollaborativeEditorSchema } from '../RTE/getCollaborativeEditorSchema';
import {
  forkResourceDoc,
  mergeMainIntoFork,
  pushForkDelta,
} from './simulatedEdits';

function waitForEditorInitialized(editor: Editor): Promise<void> {
  if (editor.isInitialized) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const onDestroy = () => {
      reject(new Error('Editor was destroyed before it finished initializing'));
    };

    editor.once('create', () => {
      editor.off('destroy', onDestroy);
      resolve();
    });
    editor.once('destroy', onDestroy);
  });
}

/**
 * Types into a documentV2 as a simulated remote peer: a headless Tiptap
 * editor bound (via LoroSyncPlugin) to a FORK of the document's Loro
 * doc. Every append (each typed letter) is committed on the fork and flushed through
 * `applyIncoming`, so the user's open editor renders it as a live
 * remote edit — mergeable with (and never clobbering) their own typing,
 * and invisible to their undo stack.
 *
 * The persona's caret rides the same channel real collaborators use: a
 * `CursorEphemeralStore` entry whose bytes are forwarded into the app's
 * LORO_EPHEMERAL dispatch, so the user's open editor renders the named,
 * colored caret exactly as it would for a real peer. The caret position
 * is computed directly on the fork (a Loro `Cursor` at the end of the
 * last text node) — `LoroEphemeralCursorPlugin` can't do it for us
 * because it only announces selections of a FOCUSED editor, and a
 * headless editor never has focus. Cursor bytes are sent AFTER the
 * text delta they refer to, so the position always resolves.
 *
 * Append-only by design: the peer only ever inserts at the end of the
 * document, so a concurrent user edit anywhere else is untouched.
 */
export class SimulatedTypist {
  private fork?: LoroDoc;
  private editor?: Editor;
  private cursors?: CursorEphemeralStore;
  private pendingCursorBytes?: Uint8Array;
  private unsubscribeCursors?: () => void;
  /** Where `appendText`/`appendInline` land: the last task-list item,
   *  or the document's trailing paragraph. Tracked explicitly because
   *  the editor auto-appends an empty paragraph after block nodes
   *  (click-below affordance), so "the last text block" is ambiguous. */
  private typingIntoTaskItem = false;

  public constructor(
    private store: Store,
    private resource: Resource,
    private personaSubject: string,
    private user?: CursorUser,
  ) {}

  public async start(): Promise<void> {
    this.fork = await forkResourceDoc(this.resource);

    const { extensions } = getCollaborativeEditorSchema(this.store);
    const fork = this.fork;

    this.cursors = new CursorEphemeralStore(fork.peerIdStr as PeerID, 30_000);
    this.unsubscribeCursors = this.cursors.subscribeLocalUpdates(bytes => {
      // Queue rather than send: the caret refers to ops the main doc
      // only receives on the next `flush()`.
      this.pendingCursorBytes = bytes;
    });

    this.editor = new Editor({
      extensions: [
        ...extensions,
        Extension.create({
          name: 'demoLoroSync',
          addProseMirrorPlugins() {
            return [LoroSyncPlugin({ doc: fork as unknown as LoroDocType })];
          },
        }),
      ],
      enableContentCheck: false,
      injectCSS: false,
      editorProps: {
        attributes: {
          'aria-hidden': 'true',
        },
      },
    });

    await waitForEditorInitialized(this.editor);
  }

  /** Open a fresh paragraph at the end of the document. */
  public appendParagraph(): void {
    if (!this.editor) return;
    this.syncFromMain();
    this.typingIntoTaskItem = false;

    // A trailing empty paragraph (a fresh doc's initial one, or the
    // click-below paragraph the editor keeps after block nodes) IS the
    // fresh paragraph — opening another leaves a stray blank line.
    const last = this.editor.state.doc.lastChild;

    if (last?.type.name === 'paragraph' && last.content.size === 0) {
      return;
    }

    this.editor.commands.insertContentAt(this.editor.state.doc.content.size, {
      type: 'paragraph',
    });
    this.flush();
  }

  /** Append text at the current typing target (last task item or the
   *  trailing paragraph). Inserted as an explicit text NODE: a raw
   *  string goes through tiptap's HTML-ish parsing, which block-wraps
   *  it and escapes the target. */
  public appendText(text: string): void {
    if (!this.editor) return;
    this.syncFromMain();
    this.editor.commands.insertContentAt(this.insertionPos(), {
      type: 'text',
      text,
    });
    this.flush();
  }

  /** Append an arbitrary block node (task list, resource embed, …) at
   *  the end of the document, as Tiptap JSON. */
  public appendContent(content: {
    type?: string;
    [key: string]: unknown;
  }): void {
    if (!this.editor) return;
    this.syncFromMain();
    this.editor.commands.insertContentAt(
      this.editor.state.doc.content.size,
      content,
    );
    this.typingIntoTaskItem = content.type === 'taskList';
    this.flush();
  }

  /** Append inline content (e.g. a resource mention) at the current
   *  typing target, followed by a space. The space isn't cosmetic: a
   *  Loro cursor can only anchor inside a TEXT node (loro-prosemirror
   *  renders list cursors at the parent node's start), so with a bare
   *  trailing embed the persona's caret would render on the embed's
   *  LEFT. The space gives the caret a text position after the embed —
   *  and is what a human types after a mention anyway. */
  public appendInline(content: object): void {
    if (!this.editor) return;
    this.syncFromMain();
    this.editor.commands.insertContentAt(this.insertionPos(), content);
    this.editor.commands.insertContentAt(this.insertionPos(), {
      type: 'text',
      text: ' ',
    });
    this.flush();
  }

  /** Add an item to the last task list (start one with `appendContent`
   *  first); its text is typed via `appendText`. */
  public appendTaskItem(checked: boolean): void {
    if (!this.editor) return;
    this.syncFromMain();

    const list = lastChildOfType(this.editor, 'taskList');

    if (!list) return;

    // One inside the list's closing boundary = after its last item.
    this.editor.commands.insertContentAt(list.start + list.node.nodeSize - 1, {
      type: 'taskItem',
      attrs: { checked },
      content: [{ type: 'paragraph' }],
    });
    this.typingIntoTaskItem = true;
    this.flush();
  }

  public stop(): void {
    // Announce the caret's departure before tearing down (peers would
    // otherwise wait out the 30s TTL).
    if (this.cursors && this.fork) {
      this.cursors.delete(this.fork.peerIdStr);
      this.forwardCursor();
    }

    this.unsubscribeCursors?.();
    this.editor?.destroy();
    this.editor = undefined;
    this.fork = undefined;
    this.cursors = undefined;
  }

  /** Merge the user's concurrent edits into the fork so appends land
   *  relative to what they actually see. */
  private syncFromMain(): void {
    if (this.fork) {
      mergeMainIntoFork(this.resource, this.fork);
    }
  }

  /** Where typing goes: the end of the last task-list item when a task
   *  list is the active target, else the end of the document's last
   *  text block (the trailing paragraph). */
  private insertionPos(): number {
    if (!this.editor) return 0;

    const { doc } = this.editor.state;

    if (this.typingIntoTaskItem) {
      const list = lastChildOfType(this.editor, 'taskList');

      if (list) {
        const insideEnd = list.start + list.node.nodeSize - 1;

        return Selection.near(doc.resolve(insideEnd), -1).from;
      }
    }

    return Selection.atEnd(doc).from;
  }

  private flush(): void {
    if (!this.fork) return;
    this.fork.commit({
      message: this.personaSubject,
      timestamp: Date.now(),
    });
    pushForkDelta(this.store, this.resource, this.fork);
    // Now that the referenced ops are in the main doc, the caret can
    // follow.
    this.announceCaret();
    this.forwardCursor();
  }

  /** Park the persona's caret at the end of the last text node. */
  private announceCaret(): void {
    if (!this.cursors || !this.fork || !this.user) return;

    try {
      const anchor = lastTextCursor(this.fork);

      if (anchor) {
        this.cursors.setLocal({ anchor, focus: anchor, user: this.user });
      }
    } catch {
      // The caret is cosmetic; typing must never fail on it.
    }
  }

  private forwardCursor(): void {
    if (!this.pendingCursorBytes) return;

    this.store.__handleLoroEphemeralMessage(
      this.resource.subject,
      this.pendingCursorBytes,
    );
    this.pendingCursorBytes = undefined;
  }
}

/** The last top-level node of the given type, with its offset. */
function lastChildOfType(
  editor: Editor,
  typeName: string,
): { node: import('@tiptap/pm/model').Node; start: number } | undefined {
  let found:
    | { node: import('@tiptap/pm/model').Node; start: number }
    | undefined;

  editor.state.doc.forEach((node, offset) => {
    if (node.type.name === typeName) {
      found = { node, start: offset };
    }
  });

  return found;
}

interface TextLike {
  getCursor: (pos: number) => Cursor | undefined;
  length: number;
}

/** A Loro cursor at the end of the LAST text node of the
 *  loro-prosemirror document tree ("where the typist just typed").
 *  Depth-first from the end WITH backtracking: the trailing empty
 *  paragraph the editor keeps after block nodes has no text, so a
 *  greedy last-child walk would come up empty while the typist is
 *  filling a task item. */
function lastTextCursor(doc: LoroDoc): Cursor | undefined {
  const text = findLastText(doc.getMap(ROOT_DOC_KEY), 0);

  return text?.getCursor(text.length);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findLastText(node: any, depth: number): TextLike | undefined {
  if (depth > 32 || !node || typeof node.kind !== 'function') {
    return undefined;
  }

  if (node.kind() === 'Text') {
    return node as TextLike;
  }

  if (node.kind() === 'Map') {
    return findLastText(node.get(CHILDREN_KEY), depth + 1);
  }

  if (node.kind() === 'List') {
    for (let i = node.length - 1; i >= 0; i--) {
      const found = findLastText(node.get(i), depth + 1);

      if (found) return found;
    }
  }

  return undefined;
}

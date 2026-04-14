import { recreateTransform } from '@fellow/prosemirror-recreate-transform';
import { Editor } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import Collaboration from '@tiptap/extension-collaboration';
import type { Node } from '@tiptap/pm/model';
import type { Store } from '@tomic/react';
import * as Y from 'yjs';
import { AI_YJS_EDIT_ORIGIN } from './AIEditYOrigin';
import { getCollaborativeEditorSchema } from './getCollaborativeEditorSchema';
import { getRegisteredCollaborativeDocumentEditor } from './collaborativeDocumentEditorRegistry';

const RECREATE_OPTIONS = {
  complexSteps: true,
  simplifyDiff: true,
  wordDiffs: false,
} as const;

function dispatchRecreateTransform(
  yDoc: Y.Doc,
  editor: Editor,
  newDoc: Node,
): void {
  const transform = recreateTransform(
    editor.state.doc,
    newDoc,
    RECREATE_OPTIONS,
  );

  yDoc.transact(() => {
    const tr = editor.state.tr;

    for (let i = 0; i < transform.steps.length; i++) {
      tr.step(transform.steps[i]);
    }

    editor.view.dispatch(tr);
  }, AI_YJS_EDIT_ORIGIN);
}

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
 * Applies a patched Tiptap JSON document to the shared Y.Doc by diffing the
 * current ProseMirror document against the target and dispatching through the
 * Collaboration extension (incremental Y.Xml updates), instead of clearing the
 * fragment and bulk-importing JSON.
 *
 * Uses the live editor when this resource is open; otherwise creates a
 * short-lived headless editor with the same collaboration extensions + schema
 * as {@link getCollaborativeEditorSchema}.
 *
 * Wrapped in `yDoc.transact(..., AI_YJS_EDIT_ORIGIN)` so nested Yjs work inside
 * y-sync keeps that origin and {@link useYSync} still suppresses broadcasts for
 * AI preview edits.
 */
export async function applyPatchedJsonToYDocCollaborative(options: {
  store: Store;
  yDoc: Y.Doc;
  subject: string;
  patchedJson: JSONContent;
}): Promise<void> {
  const { store, yDoc, subject, patchedJson } = options;
  const live = getRegisteredCollaborativeDocumentEditor(subject);

  if (live) {
    const newDoc = live.schema.nodeFromJSON(patchedJson);
    dispatchRecreateTransform(yDoc, live, newDoc);

    return;
  }

  const { schema, extensions } = getCollaborativeEditorSchema(store);
  const newDoc = schema.nodeFromJSON(patchedJson);

  const editor = new Editor({
    extensions: [
      ...extensions,
      Collaboration.configure({
        document: yDoc,
        field: 'content',
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

  try {
    await waitForEditorInitialized(editor);
    dispatchRecreateTransform(yDoc, editor, newDoc);
  } finally {
    editor.destroy();
  }
}

import { recreateTransform } from '@fellow/prosemirror-recreate-transform';
import { Editor, Extension } from '@tiptap/core';
import type { JSONContent } from '@tiptap/core';
import type { Node } from '@tiptap/pm/model';
import type { Store } from '@tomic/react';
import {
  LoroSyncPlugin,
  LoroUndoPlugin,
  type LoroDocType,
} from 'loro-prosemirror';
import type { LoroDoc } from 'loro-crdt';
import { getCollaborativeEditorSchema } from './getCollaborativeEditorSchema';
import { getRegisteredCollaborativeDocumentEditor } from './collaborativeDocumentEditorRegistry';

const RECREATE_OPTIONS = {
  complexSteps: true,
  simplifyDiff: true,
  wordDiffs: false,
} as const;

function dispatchRecreateTransform(editor: Editor, newDoc: Node): void {
  const transform = recreateTransform(
    editor.state.doc,
    newDoc,
    RECREATE_OPTIONS,
  );

  const tr = editor.state.tr;

  for (let i = 0; i < transform.steps.length; i++) {
    tr.step(transform.steps[i]);
  }

  editor.view.dispatch(tr);
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
 * Applies a patched Tiptap JSON document to the shared LoroDoc by diffing the
 * current ProseMirror document against the target and dispatching through the
 * LoroSyncPlugin, instead of clearing and bulk-importing JSON.
 *
 * Uses the live editor when this resource is open; otherwise creates a
 * short-lived headless editor with the same collaboration extensions + schema
 * as {@link getCollaborativeEditorSchema}.
 */
export async function applyPatchedJsonToLoroDocCollaborative(options: {
  store: Store;
  loroDoc: LoroDoc;
  subject: string;
  patchedJson: JSONContent;
}): Promise<void> {
  const { store, loroDoc, subject, patchedJson } = options;
  const live = getRegisteredCollaborativeDocumentEditor(subject);

  if (live) {
    const newDoc = live.schema.nodeFromJSON(patchedJson);
    dispatchRecreateTransform(live, newDoc);

    return;
  }

  const { schema, extensions } = getCollaborativeEditorSchema(store);
  const newDoc = schema.nodeFromJSON(patchedJson);

  const editor = new Editor({
    extensions: [
      ...extensions,
      Extension.create({
        name: 'loroSync',
        addProseMirrorPlugins() {
          return [
            LoroSyncPlugin({ doc: loroDoc as LoroDocType }),
            LoroUndoPlugin({ doc: loroDoc as LoroDocType }),
          ];
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

  try {
    await waitForEditorInitialized(editor);
    dispatchRecreateTransform(editor, newDoc);
  } finally {
    editor.destroy();
  }
}

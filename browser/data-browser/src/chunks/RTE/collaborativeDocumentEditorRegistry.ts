import type { Editor } from '@tiptap/core';

const editors = new Map<string, Editor>();

/**
 * When a document is open in the UI, the live Tiptap editor is registered so
 * AI / tooling can dispatch ProseMirror transactions on that instance instead
 * of creating a second Collaboration binding on the same Y.Doc.
 */
export function registerCollaborativeDocumentEditor(
  subject: string,
  editor: Editor,
): () => void {
  editors.set(subject, editor);

  return () => {
    if (editors.get(subject) === editor) {
      editors.delete(subject);
    }
  };
}

export function getRegisteredCollaborativeDocumentEditor(
  subject: string,
): Editor | undefined {
  const ed = editors.get(subject);

  if (!ed || ed.isDestroyed) {
    if (ed) {
      editors.delete(subject);
    }

    return undefined;
  }

  return ed;
}

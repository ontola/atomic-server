import { MarkdownManager } from '@tiptap/markdown';
import type { Schema } from '@tiptap/pm/model';
import type { Store } from '@tomic/react';
import type * as Y from 'yjs';
import { extractPlainTextFromYDoc } from '@chunks/RTE/extractPlainTextFromYDoc';
import { getCollaborativeEditorSchema } from '@chunks/RTE/getCollaborativeEditorSchema';
import { getProsemirrorObjFromYDoc } from '@chunks/RTE/prosemirrorObjFromYDoc';

export function getDocumentDiffSerializeContext(store: Store): {
  schema: Schema;
  mdManager: MarkdownManager;
} {
  const { schema, extensions } = getCollaborativeEditorSchema(store);

  return {
    schema,
    mdManager: new MarkdownManager({ extensions }),
  };
}

/**
 * Serialize collaborative document Y.Doc to Markdown for diffing.
 * Falls back to plain text if TipTap/Markdown serialization fails.
 */
export function yDocToMarkdownString(
  yDoc: Y.Doc,
  schema: Schema,
  mdManager: MarkdownManager,
): string {
  try {
    const json = getProsemirrorObjFromYDoc(yDoc, schema);

    return mdManager.serialize(json);
  } catch {
    return extractPlainTextFromYDoc(yDoc);
  }
}

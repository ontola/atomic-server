import { MarkdownManager } from '@tiptap/markdown';
import type { Schema } from '@tiptap/pm/model';
import type { Store } from '@tomic/react';
import type { LoroDoc } from 'loro-crdt';
import { getCollaborativeEditorSchema } from '@chunks/RTE/getCollaborativeEditorSchema';

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

function extractTextFromNode(node: unknown): string {
  if (!node || typeof node !== 'object') return '';

  const n = node as { text?: unknown; content?: unknown };

  if (typeof n.text === 'string') return n.text;

  if (Array.isArray(n.content)) {
    return n.content.map(extractTextFromNode).join(' ');
  }

  return '';
}

/**
 * Serialize collaborative document LoroDoc to Markdown for diffing.
 * Falls back to plain text if TipTap/Markdown serialization fails.
 */
export function loroDocToMarkdownString(
  loroDoc: LoroDoc,
  schema: Schema,
  mdManager: MarkdownManager,
): string {
  try {
    const json = loroDoc.toJSON()?.doc;
    if (!json) return '';

    return mdManager.serialize(json);
  } catch {
    const docRoot = loroDoc.toJSON()?.doc;

    return docRoot ? extractTextFromNode(docRoot) : '';
  }
}

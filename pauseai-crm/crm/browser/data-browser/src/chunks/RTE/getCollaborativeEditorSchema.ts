import { getSchema, type Extensions } from '@tiptap/core';
import type { Store } from '@tomic/react';
import type { Schema } from '@tiptap/pm/model';
import { getDocumentCollaborationExtensions } from './documentCollaborationExtensions';

export function getCollaborativeEditorSchema(store: Store): {
  schema: Schema;
  extensions: Extensions;
} {
  const extensions = getDocumentCollaborationExtensions(store);

  return { schema: getSchema(extensions), extensions };
}

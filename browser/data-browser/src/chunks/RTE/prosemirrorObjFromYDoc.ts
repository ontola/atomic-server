import type { JSONContent } from '@tiptap/core';
import type { Schema } from '@tiptap/pm/model';
import { yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap';
import * as Y from 'yjs';

export function getProsemirrorObjFromYDoc(yDoc: Y.Doc, schema: Schema) {
  const fragment = yDoc.getXmlFragment('content');

  const rootNode = yXmlFragmentToProseMirrorRootNode(fragment, schema);

  return rootNode.toJSON() as JSONContent;
}

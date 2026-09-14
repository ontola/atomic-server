import { dataBrowser, type Resource, type Store } from '@tomic/react';
import type { JSONContent } from '@tiptap/core';
import {
  createNodeFromLoroObj,
  type LoroNode,
  type LoroNodeMapping,
} from 'loro-prosemirror';
import { getCollaborativeEditorSchema } from './getCollaborativeEditorSchema';

export type DocumentV2TiptapJsonResult =
  | { ok: true; docJson: JSONContent }
  | { ok: false; error: string };

export interface ReadDocumentV2TiptapJsonOptions {
  /** Convert a detached snapshot so loro-prosemirror cannot alter live state. */
  detached?: boolean;
}

export const hasDocumentContent = (resource: Resource): boolean =>
  resource.hasClasses(dataBrowser.classes.documentV2) ||
  resource.hasClasses(dataBrowser.classes.meeting);

/** Read a document-v2 body as TipTap JSON (not raw loro-prosemirror `toJSON`). */
export function readDocumentV2TiptapJson(
  resource: Resource,
  store: Store,
  options: ReadDocumentV2TiptapJsonOptions = {},
): DocumentV2TiptapJsonResult {
  if (!hasDocumentContent(resource)) {
    return { ok: false, error: 'Resource has no editable document content' };
  }

  try {
    const loroDoc = resource.getLoroDoc();

    if (!loroDoc) {
      return { ok: false, error: 'Loro not loaded' };
    }

    let readOnlyDoc: NonNullable<typeof loroDoc> | undefined;

    try {
      let documentToRead = loroDoc;

      if (options.detached) {
        // loro-prosemirror's conversion uses `getOrCreateContainer` for
        // missing attribute maps. Source inspection opts into a detached
        // copy so those additions never touch the live CRDT.
        const LoroDocClass = loroDoc.constructor as new () => NonNullable<
          typeof loroDoc
        >;
        readOnlyDoc = new LoroDocClass();
        readOnlyDoc.import(loroDoc.export({ mode: 'snapshot' }));
        documentToRead = readOnlyDoc;
      }

      const docMap = documentToRead.getMap('doc');

      if (
        docMap.get('nodeName') === null ||
        docMap.get('nodeName') === undefined
      ) {
        return {
          ok: true,
          docJson: { type: 'doc', content: [] },
        };
      }

      const { schema } = getCollaborativeEditorSchema(store);
      const mapping: LoroNodeMapping = new Map();
      const pmNode = createNodeFromLoroObj(
        schema,
        docMap as unknown as LoroNode,
        mapping,
      );

      return { ok: true, docJson: pmNode.toJSON() as JSONContent };
    } finally {
      readOnlyDoc?.free();
    }
  } catch {
    return { ok: false, error: 'Failed to read document content' };
  }
}

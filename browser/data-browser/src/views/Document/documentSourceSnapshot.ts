import type { Resource, Store } from '@tomic/react';
import { readDocumentV2TiptapJson } from '@chunks/RTE/readDocumentV2TiptapJson';

export type DocumentSourceSnapshot =
  | { kind: 'source'; content: string }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; error: Error };

/**
 * Captures the value that the source dialog presents for one open session.
 * `undefined` means the resource is still loading, so the dialog keeps its
 * loading state instead of mistaking an incomplete resource for an empty doc.
 */
export function captureDocumentSourceSnapshot(
  resource: Resource,
  store: Store,
  loading: boolean,
  error: Error | undefined,
): DocumentSourceSnapshot | undefined {
  if (loading) {
    return undefined;
  }

  if (error) {
    return { kind: 'error', error };
  }

  // Do not call the shared reader until an existing LoroDoc is present.
  // `Resource.getLoroDoc()` creates one when absent, which would make a
  // read-only view mutate local state.
  if (!resource.hasLoroDoc()) {
    return {
      kind: 'unavailable',
      message:
        'This document has no loaded Loro snapshot in this tab. Open the document and try again once it has finished loading.',
    };
  }

  const loroDoc = resource.getLoroDoc();

  if (!loroDoc || loroDoc.getPendingTxnLength() > 0) {
    return {
      kind: 'unavailable',
      message:
        'The document has pending edits. Close this dialog and try again after the edits are saved.',
    };
  }

  try {
    const result = readDocumentV2TiptapJson(resource, store, {
      detached: true,
    });

    if (result.ok) {
      return {
        kind: 'source',
        content: JSON.stringify(result.docJson, null, 2),
      };
    }

    return { kind: 'error', error: new Error(result.error) };
  } catch (reason) {
    return {
      kind: 'error',
      error:
        reason instanceof Error
          ? reason
          : new Error('Failed to read document content'),
    };
  }
}

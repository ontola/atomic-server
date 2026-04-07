import {
  useLoroDoc,
  LoroLoader,
  type DataBrowser,
  type Resource,
} from '@tomic/react';

/**
 * Extracts plain text from a Loro-backed document resource.
 * The document content is stored by loro-prosemirror in a tree structure
 * under the "doc" root container. This walks that tree to extract text.
 */
export function useDocumentText(
  resource: Resource<DataBrowser.DocumentV2>,
  maxLength?: number,
) {
  const doc = useLoroDoc(resource);

  if (!doc || !LoroLoader.isLoaded()) {
    return null;
  }

  try {
    // loro-prosemirror stores the document under a root Map called "doc"
    // with a tree structure: { nodeName, attributes, children: [...] }
    // Text content is in leaf nodes as plain strings in the children array.
    const json = doc.toJSON();
    const docRoot = json?.doc;

    if (!docRoot) {
      return null;
    }

    let result = extractTextFromNode(docRoot);

    if (maxLength !== undefined && result.length > maxLength) {
      result = result.slice(0, maxLength) + '...';
    }

    return result.trim() || null;
  } catch {
    return null;
  }
}

/** Recursively extract text from a loro-prosemirror node tree. */
function extractTextFromNode(node: unknown): string {
  if (typeof node === 'string') {
    return node;
  }

  if (!node || typeof node !== 'object') {
    return '';
  }

  const obj = node as Record<string, unknown>;

  // If it has children, recurse into them
  if (Array.isArray(obj.children)) {
    const parts: string[] = [];

    for (const child of obj.children) {
      const text = extractTextFromNode(child);

      if (text) {
        parts.push(text);
      }
    }

    // Add spacing between block-level nodes
    const nodeName = obj.nodeName as string | undefined;
    const isBlock =
      nodeName === 'paragraph' ||
      nodeName === 'heading' ||
      nodeName === 'doc';

    return parts.join(isBlock ? ' ' : '');
  }

  return '';
}

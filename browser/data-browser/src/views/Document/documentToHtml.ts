import { generateHTML, type JSONContent } from '@tiptap/core';
import type { Store } from '@tomic/react';
import { getDocumentCollaborationExtensions } from '@chunks/RTE/documentCollaborationExtensions';

/** Converts TipTap JSON using the same extension set as the document editor. */
export function documentToHtml(docJson: JSONContent, store: Store): string {
  const html = generateHTML(docJson, getDocumentCollaborationExtensions(store));
  const template = document.createElement('template');
  template.innerHTML = html;

  // Formatting only separates top-level siblings. It never touches inline
  // text or pre/code content, where broad text replacement changes meaning.
  return Array.from(template.content.childNodes)
    .map(node =>
      'outerHTML' in node ? node.outerHTML : (node.textContent ?? ''),
    )
    .join('\n');
}

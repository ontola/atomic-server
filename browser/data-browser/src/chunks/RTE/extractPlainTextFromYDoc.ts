import * as Y from 'yjs';

/**
 * Plain text from a collaborative document Y.Doc (fragment name `content`).
 */
export function extractPlainTextFromYDoc(doc: Y.Doc, maxLength?: number): string {
  const fragment = doc.getXmlFragment('content');
  let text = '';

  for (const node of fragment.createTreeWalker(() => true)) {
    if (node instanceof Y.XmlText) {
      text += node.toString().replace(/<[^>]*>?/g, '');
    }

    if (node instanceof Y.XmlElement) {
      text += ' ';
    }

    if (maxLength !== undefined && text.length > maxLength) {
      text += '...';
      break;
    }
  }

  return text.trim();
}

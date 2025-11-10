import {
  dataBrowser,
  useYDoc,
  type DataBrowser,
  type Resource,
} from '@tomic/react';
import * as Y from 'yjs';

const extractText = (doc: Y.Doc, maxLength?: number) => {
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
};

/**
 * Extracts plain text from the yDoc in a document-v2 resource.
 * Pass a maxLength to truncate the text at the desired length.
 */
export function useDocumentText(
  resource: Resource<DataBrowser.DocumentV2>,
  maxLength?: number,
) {
  const doc = useYDoc(resource, dataBrowser.properties.documentContent);

  if (!doc) {
    return null;
  }

  return extractText(doc, maxLength);
}

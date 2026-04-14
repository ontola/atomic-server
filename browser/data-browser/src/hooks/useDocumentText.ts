import {
  dataBrowser,
  useYDoc,
  type DataBrowser,
  type Resource,
} from '@tomic/react';
import { extractPlainTextFromYDoc } from '@chunks/RTE/extractPlainTextFromYDoc';

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

  return extractPlainTextFromYDoc(doc, maxLength);
}

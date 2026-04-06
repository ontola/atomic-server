import {
  dataBrowser,
  useLoroDoc,
  LoroLoader,
  type DataBrowser,
  type Resource,
} from '@tomic/react';

/**
 * Extracts plain text from a Loro-backed document resource.
 * Pass a maxLength to truncate the text at the desired length.
 */
export function useDocumentText(
  resource: Resource<DataBrowser.DocumentV2>,
  maxLength?: number,
) {
  const doc = useLoroDoc(resource);

  if (!doc || !LoroLoader.isLoaded()) {
    return null;
  }

  const text = doc.getText(dataBrowser.properties.documentContent);
  let result = text.toString();

  if (maxLength !== undefined && result.length > maxLength) {
    result = result.slice(0, maxLength) + '...';
  }

  return result.trim() || null;
}

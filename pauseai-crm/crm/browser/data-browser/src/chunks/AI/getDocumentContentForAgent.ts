import {
  readDocumentV2TiptapJson,
  hasDocumentContent,
  type DocumentV2TiptapJsonResult,
} from '@chunks/RTE/readDocumentV2TiptapJson';
import { type Resource, type Store } from '@tomic/react';
import { tiptapJsonToAgentXml } from './tiptapJsonToAgentXml';

export type DocumentContentForAgentResult =
  | { ok: true; text: string }
  | { ok: false; error: string };

export type { DocumentV2TiptapJsonResult };
export { readDocumentV2TiptapJson };

export function getDocumentContentForAgent(
  resource: Resource,
  store: Store,
): DocumentContentForAgentResult {
  if (!hasDocumentContent(resource)) {
    return { ok: true, text: '' };
  }

  const readResult = readDocumentV2TiptapJson(resource, store);

  if (!readResult.ok) {
    return readResult;
  }

  return { ok: true, text: tiptapJsonToAgentXml(readResult.docJson) };
}

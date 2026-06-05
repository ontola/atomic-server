import {
  readDocumentV2TiptapJson,
  type DocumentV2TiptapJsonResult,
} from '@chunks/RTE/readDocumentV2TiptapJson';
import { commits, dataBrowser, type Resource, type Store } from '@tomic/react';
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
  if (!resource.hasClasses(dataBrowser.classes.documentV2)) {
    return { ok: true, text: '' };
  }

  const readResult = readDocumentV2TiptapJson(resource, store);

  if (!readResult.ok) {
    return readResult;
  }

  return { ok: true, text: tiptapJsonToAgentXml(readResult.docJson) };
}

/**
 * Plain-object snapshot of a resource for AI tools and user-message context.
 * Document-v2 bodies are included as `_documentContent` (TipTap XML).
 */
export function toResourceResultObjectForAgent(
  resource: Resource,
  includeCommitData: boolean,
  store: Store,
  options?: { includeAtId?: boolean },
): Record<string, unknown> {
  const props = Object.fromEntries(
    resource
      .getEntries()
      .filter(
        ([key]) => includeCommitData || key !== commits.properties.lastCommit,
      ),
  );

  const base = options?.includeAtId
    ? { '@id': resource.subject, ...props }
    : props;

  if (!resource.hasClasses(dataBrowser.classes.documentV2)) {
    return base;
  }

  return enrichDocumentV2GetResult(base, resource, store);
}

export function enrichDocumentV2GetResult(
  base: Record<string, unknown>,
  resource: Resource,
  store: Store,
): Record<string, unknown> {
  const { [dataBrowser.properties.documentContent]: _omit, ...rest } = base;
  const contentResult = getDocumentContentForAgent(resource, store);

  if (!contentResult.ok) {
    return {
      ...rest,
      _documentContent: null,
      _documentContentError: contentResult.error,
    };
  }

  return {
    ...rest,
    _documentContent: contentResult.text,
  };
}

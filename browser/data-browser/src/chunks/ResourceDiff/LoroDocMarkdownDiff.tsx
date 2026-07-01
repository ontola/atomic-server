import Markdown from '@components/datatypes/Markdown';
import { createMarkdownDiff } from '@components/datatypes/markdown/MarkdownDiff';
import { readDocumentV2TiptapJson } from '@chunks/RTE/readDocumentV2TiptapJson';
import { useStore, type Resource } from '@tomic/react';
import { useMemo } from 'react';
import {
  getDocumentDiffSerializeContext,
  loroDocToMarkdownString,
} from './loroDocToMarkdownForDiff';

interface LoroDocMarkdownDiffProps {
  oldResource?: Resource;
  newResource: Resource;
  propertySubject: string;
  showFullValue?: boolean;
}

function resourceToMarkdown(
  resource: Resource | undefined,
  store: ReturnType<typeof useStore>,
  serializeCtx: ReturnType<typeof getDocumentDiffSerializeContext>,
): string {
  if (!resource) return '';

  const read = readDocumentV2TiptapJson(resource, store);

  if (read.ok) {
    try {
      return serializeCtx.mdManager.serialize(read.docJson);
    } catch {
      // fall through to loroDocToMarkdownString
    }
  }

  const loroDoc = resource.getLoroDoc();

  if (!loroDoc) return '';

  return loroDocToMarkdownString(
    loroDoc,
    serializeCtx.schema,
    serializeCtx.mdManager,
  );
}

/**
 * Renders a diff of two tiptap docs by converting them to markdown first and then using the markdown diffing feature.
 * This is useful if you need to render a diff of a document without using a tiptap editor.
 */
export const LoroDocMarkdownDiff: React.FC<LoroDocMarkdownDiffProps> = ({
  oldResource,
  newResource,
  propertySubject: _propertySubject, // synthetic diff key; body read from Loro `doc`
  showFullValue = false,
}) => {
  const store = useStore();

  const serializeCtx = useMemo(
    () => getDocumentDiffSerializeContext(store),
    [store],
  );

  const oldMarkdown = useMemo(
    () => resourceToMarkdown(oldResource, store, serializeCtx),
    [oldResource, store, serializeCtx],
  );
  const newMarkdown = useMemo(
    () => resourceToMarkdown(newResource, store, serializeCtx),
    [newResource, store, serializeCtx],
  );

  const diff = createMarkdownDiff(oldMarkdown, newMarkdown, showFullValue);

  return <Markdown preserveLineBreaks text={diff} />;
};

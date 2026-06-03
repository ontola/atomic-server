import Markdown from '@components/datatypes/Markdown';
import { createMarkdownDiff } from '@components/datatypes/markdown/MarkdownDiff';
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

/**
 * Renders a diff of two tiptap docs by converting them to markdown first and then using the markdown diffing feature.
 * This is useful if you need to render a diff of a document without using a tiptap editor.
 */
export const LoroDocMarkdownDiff: React.FC<LoroDocMarkdownDiffProps> = ({
  oldResource,
  newResource,
  propertySubject,
  showFullValue = false,
}) => {
  const store = useStore();

  const loroOld = oldResource?.getLoroDoc();
  const loroNew = newResource.getLoroDoc();

  const serializeCtx = useMemo(
    () => getDocumentDiffSerializeContext(store),
    [store],
  );

  const oldMarkdown = loroOld
    ? loroDocToMarkdownString(loroOld, serializeCtx.schema, serializeCtx.mdManager)
    : '';
  const newMarkdown = loroNew
    ? loroDocToMarkdownString(loroNew, serializeCtx.schema, serializeCtx.mdManager)
    : '';

  const diff = createMarkdownDiff(oldMarkdown, newMarkdown, showFullValue);

  return <Markdown preserveLineBreaks text={diff} />;
};

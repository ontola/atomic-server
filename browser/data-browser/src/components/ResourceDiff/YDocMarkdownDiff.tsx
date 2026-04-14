import Markdown from '@components/datatypes/Markdown';
import { createMarkdownDiff } from '@components/datatypes/markdown/MarkdownDiff';
import { isYDoc, useStore, type Resource } from '@tomic/react';
import { useMemo } from 'react';
import {
  getDocumentDiffSerializeContext,
  yDocToMarkdownString,
} from './yDocToMarkdownForDiff';

interface YDocMarkdownDiffProps {
  oldResource?: Resource;
  newResource: Resource;
  propertySubject: string;
  showFullValue?: boolean;
}

/**
 * Renders a diff of two tiptap docs by converting them to markdown first and then using the markdown diffing feature.
 * This is usefull if you need to render a diff of a document whitout using a tiptap editor.
 */
export const YDocMarkdownDiff: React.FC<YDocMarkdownDiffProps> = ({
  oldResource,
  newResource,
  propertySubject,
  showFullValue = false,
}) => {
  const store = useStore();

  const valOld = oldResource?.get(propertySubject);
  const valNew = newResource.get(propertySubject);

  const yOld = isYDoc(valOld) ? valOld : undefined;
  const yNew = isYDoc(valNew) ? valNew : undefined;

  const serializeCtx = useMemo(
    () => getDocumentDiffSerializeContext(store),
    [store],
  );

  const oldMarkdown = yOld
    ? yDocToMarkdownString(yOld, serializeCtx.schema, serializeCtx.mdManager)
    : '';
  const newMarkdown = yNew
    ? yDocToMarkdownString(yNew, serializeCtx.schema, serializeCtx.mdManager)
    : '';

  const diff = createMarkdownDiff(oldMarkdown, newMarkdown, showFullValue);

  return <Markdown preserveLineBreaks text={diff} />;
};

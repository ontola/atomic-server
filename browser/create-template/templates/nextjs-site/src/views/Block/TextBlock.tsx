import { Resource } from '@tomic/react';
import { MarkdownContent } from '@/components/MarkdownContent';
import type { TextBlock as TextBlockType } from '@/ontologies/website';

const TextBlock = ({ resource }: { resource: Resource<TextBlockType> }) => {
  return (
    <MarkdownContent
      subject={resource.subject}
      initialValue={resource.props.description}
    />
  );
};

export default TextBlock;

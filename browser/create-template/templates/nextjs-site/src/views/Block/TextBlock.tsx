import { Resource } from '@tomic/react';
import { remark } from 'remark';
import html from 'remark-html';
import matter from 'gray-matter';
import { MarkdownContent } from '@/components/MarkdownContent';

const TextBlock = ({ resource }: { resource: Resource }) => {
  const matterResult = matter(resource.props.description);

  const processed = remark().use(html).processSync(matterResult.content);

  const initialContent = processed.toString();
  return (
    <MarkdownContent
      subject={resource.subject}
      initialContent={initialContent}
    />
  );
};

export default TextBlock;

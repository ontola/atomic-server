'use client';

import { useResource } from '@tomic/react';
import matter from 'gray-matter';
import html from 'remark-html';
import { remark } from 'remark';
import { TextBlock } from '@/ontologies/website';

export const MarkdownContent = ({
  subject,
  initialContent,
}: {
  subject: string;
  initialContent: string | TrustedHTML;
}) => {
  const resource = useResource<TextBlock>(subject);

  const matterResult = matter(resource.props.description ?? '');
  const processed = remark().use(html).processSync(matterResult.content);

  return (
    <div
      dangerouslySetInnerHTML={{
        __html: resource.loading ? initialContent : processed.toString(),
      }}
    />
  );
};

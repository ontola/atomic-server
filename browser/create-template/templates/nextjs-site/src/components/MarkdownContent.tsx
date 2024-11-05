'use client';

import { useResource } from '@tomic/react';
import matter from 'gray-matter';
import html from 'remark-html';
import { remark } from 'remark';
import { Blogpost } from '@/ontologies/website';
import { useEffect, useState } from 'react';

export const MarkdownContent = ({
  subject,
  initialContent,
}: {
  subject: string;
  initialContent: string | TrustedHTML;
}) => {
  const resource = useResource<Blogpost>(subject);
  const [content, setContent] = useState<string | TrustedHTML>(initialContent);

  const matterResult = matter(resource.props.description ?? '');
  const processed = remark().use(html).processSync(matterResult.content);

  useEffect(() => {
    if (processed.toString() !== content && resource.loading === false) {
      setContent(processed.toString());
    }
  }, [resource]);

  return <div dangerouslySetInnerHTML={{ __html: content }} />;
};

'use client';

import { useResource } from '@tomic/react';
import matter from 'gray-matter';
import html from 'remark-html';
import { remark } from 'remark';
import { TextBlock } from '@/ontologies/website';
import styles from '@/views/Block/TextBlock.module.css';

/**
 * Component that renders markdown content.
 * It is hydrated on the client and will update whenever the markdown on the server changes.
 */
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
      className={styles.wrapper}
      dangerouslySetInnerHTML={{
        __html: resource.loading ? initialContent : processed.toString(),
      }}
    />
  );
};

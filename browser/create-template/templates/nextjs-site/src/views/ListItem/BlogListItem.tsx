'use client';

import { Blogpost } from '@/ontologies/website';
import { core, useResource, useString, Image } from '@tomic/react';
import styles from './BlogListItem.module.css';

const BlogListItem = ({ subject }: { subject: string }) => {
  const formatter = new Intl.DateTimeFormat('default', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const resource = useResource<Blogpost>(subject);
  const [title] = useString(resource, core.properties.name);

  const date = resource.props.publishedAt
    ? formatter.format(new Date(resource.props.publishedAt))
    : '';
  return (
    <a className={styles.card} href={resource.props.href}>
      <div className={styles.imageWrapper}>
        <Image subject={resource.props.coverImage} alt='' />
      </div>
      <div className={styles.cardContent}>
        <div className={styles.publishDate}>{date}</div>
        <h2 className={styles.h2}>{title}</h2>
        <p className={styles.p}>
          {resource.props.description?.slice(0, 300)}...
        </p>
      </div>
    </a>
  );
};

export default BlogListItem;

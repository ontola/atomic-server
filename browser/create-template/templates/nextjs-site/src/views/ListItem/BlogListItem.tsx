import { Blogpost } from '@/ontologies/website';
import { Resource } from '@tomic/react';
import { Image } from '@/components/Image';
import { getLanguageConfig, localizePath } from '@/atomic/i18n';
import styles from './BlogListItem.module.css';

const BlogListItem = async ({
  resource,
  lang,
}: {
  resource: Resource<Blogpost>;
  lang?: string;
}) => {
  const { defaultLanguage } = await getLanguageConfig();
  const href = localizePath(
    resource.props.href ?? '/',
    lang ?? defaultLanguage,
    defaultLanguage,
  );
  const formatter = new Intl.DateTimeFormat('default', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const date = resource.props.publishedAt
    ? formatter.format(new Date(resource.props.publishedAt))
    : undefined;

  return (
    <a className={styles.card} href={href}>
      {resource.props.coverImage && (
        <div className={styles.imageWrapper}>
          <Image subject={resource.props.coverImage} alt='' />
        </div>
      )}
      <div className={styles.cardContent}>
        {date && <div className={styles.publishDate}>{date}</div>}
        <h2 className={styles.h2}>{resource.title}</h2>
        <p className={styles.p}>
          {resource.props.description?.slice(0, 300)}...
        </p>
      </div>
    </a>
  );
};

export default BlogListItem;

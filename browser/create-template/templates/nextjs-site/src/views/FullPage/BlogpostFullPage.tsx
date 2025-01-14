import Container from '@/components/Layout/Container';
import type { Blogpost } from '@/ontologies/website';
import { Resource } from '@tomic/lib';
import styles from './BlogpostFullPage.module.css';
import { Image } from '@/components/Image';
import { MarkdownContent } from '@/components/MarkdownContent';

const formatter = new Intl.DateTimeFormat('default', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const BlogpostFullPage = ({ resource }: { resource: Resource<Blogpost> }) => {
  const date = formatter.format(new Date(resource.props.publishedAt));

  return (
    <Container>
      <div className={styles.blogWrapper}>
        <div className={styles.coverImageWrapper}>
          <Image subject={resource.props.coverImage} alt='' />
        </div>
        <div className={styles.content}>
          <h1 className={styles.h1}>{resource.title}</h1>
          <p className={styles.publishDate}>{date}</p>
          <MarkdownContent
            subject={resource.subject}
            initialValue={resource.props.description}
          />
        </div>
      </div>
    </Container>
  );
};

export default BlogpostFullPage;

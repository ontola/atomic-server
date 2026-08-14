import Container from '@/components/Layout/Container';
import type { Blogpost } from '@/ontologies/website';
import { Resource } from '@tomic/lib';
import styles from './BlogpostFullPage.module.css';
import { Image } from '@/components/Image';
import { EditableDescription, EditableName } from '@/components/EditableField';

const formatter = new Intl.DateTimeFormat('default', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

const BlogpostFullPage = ({ resource }: { resource: Resource<Blogpost> }) => {
  const date = resource.props.publishedAt
    ? formatter.format(new Date(resource.props.publishedAt))
    : undefined;

  return (
    <Container>
      <div className={styles.blogWrapper}>
        {resource.props.coverImage && (
          <div className={styles.coverImageWrapper}>
            <Image subject={resource.props.coverImage} alt='' />
          </div>
        )}
        <div className={styles.content}>
          <EditableName
            className={styles.h1}
            subject={resource.subject}
            initialValue={resource.title}
          />
          {date && <p className={styles.publishDate}>{date}</p>}
          <EditableDescription
            subject={resource.subject}
            initialValue={resource.props.description}
          />
        </div>
      </div>
    </Container>
  );
};

export default BlogpostFullPage;

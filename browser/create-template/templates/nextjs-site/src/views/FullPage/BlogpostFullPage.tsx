import Container from '@/components/Layout/Container';
import { Blogpost } from '@/ontologies/website';
import { Resource } from '@tomic/lib';
import styles from './BlogpostFullPage.module.css';
import { Image } from '@/components/Image';
import matter from 'gray-matter';
import html from 'remark-html';
import { remark } from 'remark';
import { MarkdownContent } from '@/components/MarkdownContent';

const BlogpostFullPage = ({ resource }: { resource: Resource<Blogpost> }) => {
  const formatter = new Intl.DateTimeFormat('default', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  const date = formatter.format(new Date(resource.props.publishedAt));

  const matterResult = matter(resource.props.description);
  const processed = remark().use(html).processSync(matterResult.content);
  const initialContent = processed.toString();

  return (
    <Container>
      <div className={styles.blogWrapper}>
        <Image subject={resource.props.coverImage} alt='' />
        <div className={styles.content}>
          <h1 className={styles.h1}>{resource.title}</h1>
          <p className={styles.publishDate}>{date}</p>
          <MarkdownContent
            subject={resource.subject}
            initialContent={initialContent}
          />
        </div>
      </div>
    </Container>
  );
};

export default BlogpostFullPage;

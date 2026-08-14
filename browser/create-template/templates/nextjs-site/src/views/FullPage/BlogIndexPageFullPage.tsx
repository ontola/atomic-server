import { type Resource } from '@tomic/lib';
import { type Page } from '@/ontologies/website';
import styles from './BlogIndexPageFullPage.module.css';
import VStack from '@/components/Layout/VStack';
import ListItemView from '../ListItem/ListItemView';
import { getAllBlogposts } from '@/atomic/getAllBlogposts';
import FilterableBlogList from '@/components/FilterableBlogList';
import Container from '@/components/Layout/Container';
import { store } from '@/store';

const BlogIndexPageFullPage = async ({
  resource,
  lang,
}: {
  resource: Resource<Page>;
  lang?: string;
}) => {
  const subjects = await getAllBlogposts(lang);
  const posts = await Promise.all(
    subjects.map(async subject => {
      const post = await store.getResource(subject);

      return { subject, title: post.title ?? '' };
    }),
  );

  return (
    <Container>
      <div className={styles.wrapper}>
        <VStack>
          <FilterableBlogList
            heading={<h1>{resource.title}</h1>}
            titles={posts.map(post => post.title)}
          >
            {posts.map(post => (
              <li key={post.subject}>
                <ListItemView subject={post.subject} lang={lang} />
              </li>
            ))}
          </FilterableBlogList>
        </VStack>
      </div>
    </Container>
  );
};

export default BlogIndexPageFullPage;

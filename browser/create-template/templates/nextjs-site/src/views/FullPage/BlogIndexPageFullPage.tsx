import Container from '@/components/Layout/Container';
import { website, type Page } from '@/ontologies/website';
import { core, type Resource } from '@tomic/lib';
import styles from './BlogIndexPageFullPage.module.css';
import searchStyle from '@/components/Searchbar.module.css';
import VStack from '@/components/Layout/VStack';
import HStack from '@/components/Layout/HStack';
import ListItemView from '../ListItem/ListItemView';
import { getAllBlogposts } from '@/atomic/getAllBlogposts';
import { Suspense } from 'react';
import Searchbar from '@/components/Searchbar';
import { store } from '@/store';

const BlogIndexPageFullPage = async ({
  resource,
  searchParams,
}: {
  resource: Resource<Page>;
  searchParams?: Record<string, string | string[] | undefined>;
}) => {
  const allItems = await getAllBlogposts();
  let results: string[] = [];

  if (searchParams?.search && typeof searchParams.search === 'string') {
    results = await store.search(searchParams.search, {
      filters: {
        [core.properties.isA]: website.classes.blogpost,
      },
    });
  } else {
    results = allItems;
  }

  return (
    <Container>
      <div className={styles.wrapper}>
        <VStack>
          <HStack wrap fullWidth align='center' justify='space-between'>
            <h1>{resource.title}</h1>

            <Suspense
              fallback={
                <input
                  className={searchStyle.input}
                  type='search'
                  aria-label='Search'
                  placeholder='Search blogposts...'
                  disabled
                />
              }
            >
              <Searchbar />
            </Suspense>
          </HStack>
          {results.length !== 0 ? (
            <ul>
              {results.map(post => (
                <li key={post}>
                  <ListItemView subject={post} />
                </li>
              ))}
            </ul>
          ) : (
            <Container>
              <p>No results found.</p>
            </Container>
          )}
        </VStack>
      </div>
    </Container>
  );
};

export default BlogIndexPageFullPage;

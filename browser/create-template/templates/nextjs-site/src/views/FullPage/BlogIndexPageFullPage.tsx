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
import { env } from '@/env';
import { isListedCmsResource } from '@/atomic/publicContent';

const BlogIndexPageFullPage = async ({
  resource,
  lang,
  searchParams,
}: {
  resource: Resource<Page>;
  lang?: string;
  searchParams?: Record<string, string | string[] | undefined>;
}) => {
  const allItems = await getAllBlogposts(lang);
  let results: string[] = [];

  // We check if the searchParams have a search query. If so, we search for blogposts that match the query.
  // If there is no search query, we show all blogposts.
  if (searchParams?.search && typeof searchParams.search === 'string') {
    const firstBlogpost = allItems[0]
      ? await store.getResource(allItems[0])
      : undefined;
    const blogParent =
      (firstBlogpost?.get(core.properties.parent) as string | undefined) ??
      env.NEXT_PUBLIC_ATOMIC_DRIVE;

    results = await store.search(searchParams.search, {
      parents: blogParent,
      filters: {
        [core.properties.isA]: website.classes.blogpost,
      },
    });
    const hits = await Promise.all(
      results.map(subject => store.getResource(subject)),
    );
    results = hits.filter(isListedCmsResource).map(resource => resource.subject);
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
          {results.length > 0 ? (
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

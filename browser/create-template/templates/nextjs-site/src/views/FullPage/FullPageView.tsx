import { website } from '@/ontologies/website';
import PageFullPage from './PageFullPage';
import BlogIndexPageFullPage from './BlogIndexPageFullPage';
import BlogpostFullPage from './BlogpostFullPage';
import DefaultFullPage from './DefaultFullPage';
import { store } from '@/store';

const FullPageView = async ({
  subject,
  searchParams,
}: {
  subject: string;
  searchParams?: Record<string, string | string[] | undefined>;
}) => {
  const resource = await store.getResource(subject);

  // Pick a component based on the resource's class.
  const Component = resource.matchClass(
    {
      [website.classes.page]: PageFullPage,
      [website.classes.blogIndexPage]: BlogIndexPageFullPage,
      [website.classes.blogpost]: BlogpostFullPage,
    },
    DefaultFullPage,
  );

  return <Component resource={resource} searchParams={searchParams} />;
};

export default FullPageView;

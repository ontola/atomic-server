import { website } from '@/ontologies/website';
import BlogListItem from './BlogListItem';
import DefaultView from '@/views/DefaultView';
import { store } from '@/app/store';
import { Suspense } from 'react';

const ListItemView = async ({ subject }: { subject: string }) => {
  const listItem = await store.getResource(subject);

  const Component = listItem.matchClass(
    {
      [website.classes.blogpost]: BlogListItem,
    },
    DefaultView,
  );

  return (
    <Suspense fallback={<p>loading...</p>}>
      <Component subject={subject} />
    </Suspense>
  );
};

export default ListItemView;

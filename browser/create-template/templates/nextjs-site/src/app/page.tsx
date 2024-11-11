import FullPageView from '@/views/FullPage/FullPageView';
import { notFound } from 'next/navigation';
import { getCurrentResource } from '@/atomic/getCurrentResource';
import { Metadata } from 'next';
import { core } from '@tomic/lib';

export const generateMetadata = async (): Promise<Metadata> => {
  const resource = await getCurrentResource('/');

  return {
    title: resource?.title,
    description: resource?.get(core.properties.description),
  };
};

export default async function Page() {
  const resource = await getCurrentResource('/');

  if (!resource) {
    return notFound();
  }

  return <FullPageView subject={resource.subject} />;
}

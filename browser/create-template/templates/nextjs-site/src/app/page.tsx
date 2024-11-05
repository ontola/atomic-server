import FullPageView from '@/views/FullPage/FullPageView';
import { notFound } from 'next/navigation';
import { getCurrentResource } from '@/atomic/getCurrentResource';
import { env } from '@/env';
import { Metadata } from 'next';
import { core } from '@tomic/lib';

export const generateMetadata = async (): Promise<Metadata> => {
  const url = new URL(env.NEXT_PUBLIC_ATOMIC_SERVER_URL);
  const resource = await getCurrentResource(url);

  return {
    title: resource?.title,
    description: resource?.get(core.properties.description),
  };
};

export default async function Page() {
  const url = new URL(env.NEXT_PUBLIC_ATOMIC_SERVER_URL);
  const resource = await getCurrentResource(url);

  if (!resource) {
    return notFound();
  }

  return <FullPageView subject={resource.subject} />;
}

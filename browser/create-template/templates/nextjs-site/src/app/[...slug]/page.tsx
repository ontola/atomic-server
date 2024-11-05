import { getCurrentResource } from '@/atomic/getCurrentResource';
import { env } from '@/env';
import FullPageView from '@/views/FullPage/FullPageView';
import { core } from '@tomic/lib';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

type Props = {
  params: Promise<{
    slug: string[];
  }>;
  searchParams?: Promise<{
    [key: string]: string | string[] | undefined;
  }>;
};

export const generateMetadata = async ({
  params,
}: Props): Promise<Metadata> => {
  const slug = (await params).slug;

  const resourceUrl = new URL(
    `${env.NEXT_PUBLIC_ATOMIC_SERVER_URL}/${slug.join('/')}`,
  );
  const resource = await getCurrentResource(resourceUrl);

  return {
    title: resource?.title,
    description: resource?.get(core.properties.description),
  };
};

const Page = async (props: Props) => {
  const params = await props.params;
  const searchParams = await props.searchParams;
  const resourceUrl = new URL(
    `${env.NEXT_PUBLIC_ATOMIC_SERVER_URL}/${params.slug.join('/')}`,
  );
  const resource = await getCurrentResource(resourceUrl);

  if (!resource) {
    return notFound();
  }

  return (
    <FullPageView subject={resource.subject} searchParams={searchParams} />
  );
};

export default Page;

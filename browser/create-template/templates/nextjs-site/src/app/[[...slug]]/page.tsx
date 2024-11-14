import { getCurrentResource } from '@/atomic/getCurrentResource';
import FullPageView from '@/views/FullPage/FullPageView';
import { core } from '@tomic/lib';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

type Params = {
  slug?: string[];
};

type Props = {
  params: Promise<Params>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const fetchResource = async (slug?: string[]) => {
  const path = slug ? `/${slug.join('/')}` : '/';
  return await getCurrentResource(path);
};

export const generateMetadata = async ({
  params,
}: Props): Promise<Metadata> => {
  const slug = (await params).slug;
  const resource = await fetchResource(slug);

  return {
    title: resource?.title,
    description: resource?.get(core.properties.description),
  };
};

const Page = async ({ params, searchParams }: Props) => {
  const slug = (await params).slug;
  const search = await searchParams;
  const resource = await fetchResource(slug);

  if (!resource) {
    return notFound();
  }

  return <FullPageView subject={resource.subject} searchParams={search} />;
};

export default Page;

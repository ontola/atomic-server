import { getCurrentResource } from '@/atomic/getCurrentResource';
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

  const resource = await getCurrentResource(`${slug.join('/')}`);

  return {
    title: resource?.title,
    description: resource?.get(core.properties.description),
  };
};

const Page = async (props: Props) => {
  const params = await props.params;
  const searchParams = await props.searchParams;

  const resource = await getCurrentResource(`/${params.slug.join('/')}`);

  if (!resource) {
    return notFound();
  }

  return (
    <FullPageView subject={resource.subject} searchParams={searchParams} />
  );
};

export default Page;

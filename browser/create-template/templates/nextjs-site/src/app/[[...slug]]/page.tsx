import { getCurrentResource } from '@/atomic/getCurrentResource';
import { getLanguageAlternates, parseLocalizedPath } from '@/atomic/i18n';
import FullPageView from '@/views/FullPage/FullPageView';
import { core } from '@tomic/lib';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';

type Params = {
  slug?: string[];
};

type Props = {
  params: Promise<Params>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

const slugToPath = (slug?: string[]) => (slug ? `/${slug.join('/')}` : '/');

const fetchResource = async (slug?: string[]) => {
  return await getCurrentResource(slugToPath(slug));
};

export const generateMetadata = async ({
  params,
}: Props): Promise<Metadata> => {
  const slug = (await params).slug;
  const resource = await fetchResource(slug);

  // Link the different translations of this page together via hreflang alternates.
  const alternates = resource ? await getLanguageAlternates(resource) : [];

  return {
    title: resource?.title,
    description: resource?.get(core.properties.description),
    ...(alternates.length > 0 && {
      alternates: {
        languages: Object.fromEntries(
          alternates.map(alternate => [alternate.lang, alternate.href]),
        ),
      },
    }),
  };
};

const Page = async ({ params, searchParams }: Props) => {
  const slug = (await params).slug;
  const search = await searchParams;
  const { lang } = await parseLocalizedPath(slugToPath(slug));
  const resource = await fetchResource(slug);

  if (!resource) {
    return notFound();
  }

  return (
    <FullPageView subject={resource.subject} lang={lang} searchParams={search} />
  );
};

export default Page;

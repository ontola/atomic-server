import { getCurrentResource } from '@/atomic/getCurrentResource';
import { getSitemapPaths } from '@/atomic/getPublicPages';
import { getLanguageAlternates, parseLocalizedPath } from '@/atomic/i18n';
import { cmsPathToSlug } from '@/atomic/feeds';
import FullPageView from '@/views/FullPage/FullPageView';
import { core } from '@tomic/lib';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

export const revalidate = 60;
export const dynamicParams = true;

type Params = {
  slug?: string[];
};

type Props = {
  params: Promise<Params>;
};

const slugToPath = (slug?: string[]) => (slug ? `/${slug.join('/')}` : '/');

const fetchResource = async (slug?: string[]) => {
  return await getCurrentResource(slugToPath(slug));
};

/**
 * Prerender every public path so the first byte is already the right language
 * and content. Unknown paths still generate on demand (`dynamicParams`).
 * An empty sitemap at build (index still catching up) only prerenders `/`;
 * ISR refreshes the rest within `revalidate` seconds instead of baking
 * empty listings forever.
 */
export async function generateStaticParams(): Promise<Params[]> {
  try {
    const paths = await getSitemapPaths();

    if (paths.length === 0) {
      console.warn(
        'No CMS pages at build time; `/` will generate on demand (ISR).',
      );

      return [{ slug: [] }];
    }

    return paths.map(path => ({ slug: cmsPathToSlug(path) }));
  } catch (error) {
    console.warn('Could not list CMS pages at build time:', error);

    return [{ slug: [] }];
  }
}

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

const Page = async ({ params }: Props) => {
  const slug = (await params).slug;
  const { lang } = await parseLocalizedPath(slugToPath(slug));
  const resource = await fetchResource(slug);

  if (!resource) {
    return notFound();
  }

  return <FullPageView subject={resource.subject} lang={lang} />;
};

export default Page;

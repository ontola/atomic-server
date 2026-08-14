import { CollectionBuilder, type Resource } from '@tomic/lib';
import { website } from '@/ontologies/website';
import { driveFilter, store } from '@/store';
import { env } from '@/env';
import { findTranslation, parseLocalizedPath } from './i18n';
import { isListedCmsResource } from './publicContent';

/** The Website resource's `homepage` is what `/` (and `/nl`) serve. */
async function getWebsiteHomepage(): Promise<Resource | undefined> {
  const site = await store.fetchResourceFromServer(
    env.NEXT_PUBLIC_WEBSITE_RESOURCE,
    { noWebSocket: true },
  );

  if (site.error) {
    return undefined;
  }

  const homepageSubject = site.get(website.properties.homepage);

  if (typeof homepageSubject !== 'string') {
    return undefined;
  }

  const homepage = await store.fetchResourceFromServer(homepageSubject, {
    noWebSocket: true,
  });

  return isListedCmsResource(homepage) ? homepage : undefined;
}

/**
 * Queries the server for a resource with a href property that matches the given url pathname.
 * @param url The current URL in the browser.
 * @returns Promise that resolves to the subject of the resource, or undefined if no resource was found.
 */
export async function getCurrentResource(
  path: string,
): Promise<Resource | undefined> {
  // The path may start with a language prefix, e.g. /nl/blog/some-post.
  const { lang, path: pagePath, prefixed } = await parseLocalizedPath(path);

  if (pagePath === '/' || pagePath === '') {
    const homepage = await getWebsiteHomepage();

    if (homepage) {
      return prefixed ? findTranslation(homepage, lang) : homepage;
    }
  }

  // Find the resource with the current path as href.
  const collection = await new CollectionBuilder(store)
    .setDrive(env.NEXT_PUBLIC_ATOMIC_DRIVE)
    .setProperty(website.properties.href)
    .setValue(pagePath)
    .addFilter(driveFilter)
    .buildAndFetch();

  if (collection.totalMembers === 0) {
    return undefined;
  }

  const subjects = await collection.getAllMembers();
  const candidates = (
    await Promise.all(
      subjects.map(subject =>
        store.fetchResourceFromServer(subject, { noWebSocket: true }),
      ),
    )
  ).filter(isListedCmsResource);

  if (candidates.length === 0) {
    return undefined;
  }

  const resource = candidates[0];

  if (!prefixed) {
    // Without an explicit language in the URL, the resource's own href wins:
    // every translation is reachable through its own path.
    return resource;
  }

  // When the resource is not in the explicitly requested language, prefer a
  // translation that is.
  return await findTranslation(resource, lang);
}

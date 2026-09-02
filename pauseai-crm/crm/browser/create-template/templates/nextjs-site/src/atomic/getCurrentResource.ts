import { CollectionBuilder, type Resource } from '@tomic/lib';
import { website } from '@/ontologies/website';
import { driveFilter, store } from '@/store';
import { env } from '@/env';
import { findTranslation, parseLocalizedPath } from './i18n';

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

  const currentResourceSubject = await collection.getMemberWithIndex(0);

  if (!currentResourceSubject) {
    return undefined;
  }

  const resource = await store.fetchResourceFromServer(currentResourceSubject, {
    noWebSocket: true,
  });

  if (!prefixed) {
    // Without an explicit language in the URL, the resource's own href wins:
    // every translation is reachable through its own path.
    return resource;
  }

  // When the resource is not in the explicitly requested language, prefer a
  // translation that is.
  return await findTranslation(resource, lang);
}

import { isFork, type Resource } from '@tomic/lib';
import { website } from '$lib/ontologies/website';

/**
 * Whether a resource should appear on the public site.
 *
 * Forks copy the original's `href`, so an unfiltered path query can serve a
 * draft instead of the published page. `published-at` in the future is a
 * scheduled post — still stored, but not rendered. Visibility is still
 * location/ACL; this is presentation only.
 *
 * The second argument is an options object on purpose: `array.filter(fn)`
 * passes the index as the second argument, which must not be read as `now`.
 */
export function isListedCmsResource(
  resource: Resource,
  options?: { now?: number },
): boolean {
  if (resource.error || isFork(resource)) {
    return false;
  }

  if (resource.hasClasses(website.classes.blogpost)) {
    const publishedAt = resource.get(website.properties.publishedAt);
    const now = options?.now ?? Date.now();

    if (publishedAt === undefined || publishedAt === null) {
      return false;
    }

    if (Number(publishedAt) > now) {
      return false;
    }
  }

  return true;
}

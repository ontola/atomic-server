import { isFork } from './forks.js';
import type { Resource } from './resource.js';

/**
 * Whether a resource should appear on a generated public site.
 *
 * Forks copy the original's `href`, so an unfiltered path query can serve a
 * draft instead of the published page. A blog post with a missing or future
 * `published-at` is stored but not rendered. Visibility is still location/ACL;
 * this is presentation only.
 *
 * Do not pass this directly to `array.filter` — that supplies the index as
 * `options`. Call `r => isListedCmsResource(r, options)` instead.
 */
export function isListedCmsResource(
  resource: Resource,
  options: {
    blogpostClass: string;
    publishedAtProperty: string;
    now?: number;
  },
): boolean {
  if (resource.error || isFork(resource)) {
    return false;
  }

  if (resource.hasClasses(options.blogpostClass)) {
    const publishedAt = resource.get(options.publishedAtProperty);
    const now = options.now ?? Date.now();

    if (publishedAt === undefined || publishedAt === null) {
      return false;
    }

    if (Number(publishedAt) > now) {
      return false;
    }
  }

  return true;
}

/** Data Browser edit form for a resource. Same contract as Cmd/Ctrl+E in the app. */
export function cmsEditUrl(cmsOrigin: string, subject: string): string {
  const origin = cmsOrigin.endsWith('/') ? cmsOrigin : `${cmsOrigin}/`;
  const url = new URL('app/edit', origin);
  url.searchParams.set('subject', subject);

  return url.toString();
}

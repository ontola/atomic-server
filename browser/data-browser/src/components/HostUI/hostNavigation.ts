// @wc-ignore-file
import { isResourceSubject, type Store } from '@tomic/react';
import { paths } from '../../routes/paths';
import { externalLink } from '@helpers/extensions/externalLink';

/** Resolve a confirmed navigation through the signed-in person's read path. */
export async function resourceToOpen(
  store: Pick<Store, 'getResource'>,
  value: unknown,
): Promise<{ subject: string; title: string }> {
  if (typeof value !== 'string' || !value || value.length > 4096) {
    throw new Error('openResource takes a resource subject');
  }

  if (!isResourceSubject(value)) externalLink(value);
  const resource = await store.getResource(value);
  if (resource.error) throw resource.error;

  return { subject: resource.subject, title: resource.title };
}

/** A frame names a resource, never a same-origin host route. */
export function resourceNavigationURL(subject: string): string {
  return `${paths.show}?${new URLSearchParams({ subject })}`;
}

import { commits, dataBrowser, useCollection } from '@tomic/react';
import { useLastSeenComments } from './useLastSeenComments';

/**
 * Live number of comments on a resource (Messages whose `about` points at it)
 * plus whether some of them are unseen on this device. Comments are
 * client-signed commits, so drive sync keeps the collection membership up to
 * date without refetching.
 */
export function useCommentCount(subject: string): {
  count: number;
  hasUnseen: boolean;
} {
  // The page size must cover the whole thread: `applyResourceChange` can only
  // recognize an already-counted member if it's in a cached page — a sync
  // echo for a member outside the page would be double-counted as new.
  const { collection, ready } = useCollection(
    {
      property: dataBrowser.properties.about,
      value: subject,
      sort_by: commits.properties.createdAt,
    },
    { pageSize: 100 },
  );
  const [lastSeen] = useLastSeenComments(subject);

  const count = ready ? collection.totalMembers : 0;
  const hasUnseen = count > 0 && (lastSeen === undefined || count > lastSeen);

  return { count, hasUnseen };
}

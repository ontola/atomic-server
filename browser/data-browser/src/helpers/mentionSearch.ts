import type { Store } from '@tomic/react';
import { getRecentResources } from './recentResources';

export const MAX_MENTION_SUGGESTIONS = 10;

/** With nothing typed yet, offer what the user opened recently in this drive,
 * topped up with the drive's own children so a fresh drive isn't empty. */
const getSubjectsWithoutQuery = async (
  store: Store,
  drive: string,
  exclude: string | undefined,
): Promise<string[]> => {
  const subjects = getRecentResources(drive).filter(s => s !== exclude);

  if (subjects.length < MAX_MENTION_SUGGESTIONS) {
    try {
      const driveResource = await store.getResource(drive);
      const children = await driveResource.getChildrenCollection(
        MAX_MENTION_SUGGESTIONS,
      );

      for (const child of await children.getMembersOnPage(0)) {
        if (child !== exclude && !subjects.includes(child)) {
          subjects.push(child);
        }
      }
    } catch (e) {
      console.error('Could not list drive children for @ mentions', e);
    }
  }

  const resources = await Promise.all(
    subjects.map(subject => store.getResource(subject)),
  );

  // Recents can point at resources that were deleted or are no longer
  // readable since they were opened.
  return resources
    .filter(r => !r.error && r.title)
    .slice(0, MAX_MENTION_SUGGESTIONS)
    .map(r => r.subject);
};

/** Subjects to offer for an `@` mention in `drive`: a search for `query`, or
 * recent/child resources when nothing is typed yet. Shared by the document
 * editor and the chat composer. */
export const findMentionSubjects = async (
  store: Store,
  drive: string,
  query: string,
  exclude?: string,
): Promise<string[]> =>
  query.trim()
    ? store.search(query.toLowerCase(), {
        limit: MAX_MENTION_SUGGESTIONS,
        // Including the results could lead to weird behavior when the document itself is returned from the server.
        include: false,
        parents: [drive],
      })
    : getSubjectsWithoutQuery(store, drive, exclude);

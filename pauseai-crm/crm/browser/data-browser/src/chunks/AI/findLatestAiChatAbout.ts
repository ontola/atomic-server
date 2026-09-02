import { ai, commits, core, dataBrowser, type Store } from '@tomic/react';
import { CollectionBuilder } from '@tomic/lib';

/**
 * Finds the most recently created AI chat whose `about` points at the given
 * subject. The `about` index is shared with comments (Messages), so members
 * are filtered by class client-side.
 */
export async function findLatestAiChatAbout(
  store: Store,
  subject: string,
): Promise<string | undefined> {
  const collection = new CollectionBuilder(store)
    .setProperty(dataBrowser.properties.about)
    .setValue(subject)
    .setFilters([{ property: core.properties.isA, value: ai.classes.aiChat }])
    .setSortBy(commits.properties.createdAt)
    .setSortDesc(true)
    .setPageSize(30)
    .build();

  await collection.waitForReady();

  // Newest first; only the first page is considered.
  const max = Math.min(collection.totalMembers, 30);

  for (let i = 0; i < max; i++) {
    const member = await collection.getMemberWithIndex(i);

    if (!member) {
      continue;
    }

    const resource = await store.getResource(member);

    if (resource.hasClasses(ai.classes.aiChat)) {
      return member;
    }
  }

  return undefined;
}

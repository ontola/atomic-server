import type { Store } from '@tomic/react';
import { getOrCreateFolderByLocalId } from './folderByLocalId';

/** Well-known id of the per-drive Drafts folder, resolved via `localId`. */
const DRAFTS_LOCAL_ID = 'drafts';

/**
 * The drive's Drafts folder, created on first use.
 *
 * A *draft* is unpublished new content — an ordinary resource that has not been
 * published yet. It is not a class, it is a *place*: anything living in this
 * folder is a draft, and publishing it is simply moving it somewhere publicly
 * readable. The folder carries no public read grant, so its contents are visible
 * to people who can write to the drive but not to the public — which is what
 * keeps an unpublished draft unpublished.
 *
 * This is distinct from a Fork (see {@link getOrCreateForksFolder}): a fork
 * proposes a change to an *existing* resource and merges onto it, whereas a draft
 * is brand-new content with no target other than its parent.
 */
export async function getOrCreateDraftsFolder(
  store: Store,
  drive: string,
): Promise<string> {
  return getOrCreateFolderByLocalId(store, drive, DRAFTS_LOCAL_ID, {
    name: 'Drafts',
    description:
      'Unpublished new content. Resources here are visible to people who can write to this drive; publish one by moving it somewhere publicly readable.',
  });
}

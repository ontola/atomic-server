/**
 * Ordering for a resource's children in the sidebar tree.
 *
 * `sortOrder` and `createdAt` deliberately share one number space: a
 * drag-and-drop mints a fractional `sortOrder` BETWEEN two neighbours' keys,
 * and the server sorts by the same fallback, so the two are comparable by
 * construction.
 *
 * A member carrying neither is the awkward case. It used to fall back to its
 * array index, which is a different space entirely — an index of 3 against
 * `createdAt` timestamps around 1.7e12 sorts to the very front — so any
 * resource missing `createdAt` jumped to the top of the tree.
 */

export interface ChildSortEntry {
  subject: string;
  /** `sortOrder`, else `createdAt`, else `undefined` when neither exists. */
  key: number | undefined;
  /** Position in the server's `createdAt`-ordered response. */
  index: number;
}

/**
 * Order children by their sort key, keeping keyless members where the server
 * put them rather than letting them fall into a foreign number space.
 *
 * The server already returns members in `createdAt` order, so a keyless member
 * inherits the preceding member's key and the index tie-break preserves their
 * relative order. Keyless members before the first known key inherit that key,
 * so they stay at the front instead of sorting as zero.
 */
export function orderChildren(entries: readonly ChildSortEntry[]): string[] {
  const keyed = entries.map(entry => ({ ...entry }));

  let carried: number | undefined;

  for (const entry of keyed) {
    if (entry.key === undefined) {
      entry.key = carried;
    } else {
      carried = entry.key;
    }
  }

  const firstKnown = keyed.find(entry => entry.key !== undefined)?.key ?? 0;

  for (const entry of keyed) {
    if (entry.key === undefined) entry.key = firstKnown;
  }

  keyed.sort((a, b) => (a.key === b.key ? a.index - b.index : a.key! - b.key!));

  return keyed.map(entry => entry.subject);
}

import { commits, dataBrowser, type Resource } from '@tomic/react';

/**
 * Fractional `sortOrder` math, shared by sidebar drag-and-drop and table row
 * insertion. A resource's effective sort key is its explicit `sortOrder` or,
 * when absent, its `createdAt` — the server's query index applies the same
 * fallback, so both live on one numeric (timestamp) axis and repositioning
 * one resource never requires renumbering its siblings.
 */

/**
 * Resolve a resource's sort key: its explicit `sortOrder` if set, else
 * `createdAt`. Returns `undefined` if neither is available — the caller
 * picks a default.
 */
export function readSortKey(
  resource: Resource | undefined,
): number | undefined {
  if (!resource) return undefined;
  const explicit = resource.get(dataBrowser.properties.sortOrder);
  if (typeof explicit === 'number') return explicit;
  const createdAt = resource.get(commits.properties.createdAt);
  if (typeof createdAt === 'number') return createdAt;

  return undefined;
}

/**
 * Compute the fractional `sortOrder` to assign to a moved/inserted resource
 * given its new neighbors. Mirrors the classic fractional-index pattern
 * — midpoint when both neighbors exist; offset by 1 when only one does.
 *
 * The `±1` step at the ends is arbitrary but big enough that subsequent
 * drops on the same side still get sub-second resolution (next midpoint
 * is `±0.5`, then `±0.25`, …).
 */
export function computeSortOrder(
  prevKey: number | undefined,
  nextKey: number | undefined,
): number {
  if (prevKey !== undefined && nextKey !== undefined) {
    return (prevKey + nextKey) / 2;
  }

  if (prevKey !== undefined) {
    // Insert at end — must come after `prev`.
    return prevKey + 1;
  }

  if (nextKey !== undefined) {
    // Insert at start — must come before `next`.
    return nextKey - 1;
  }

  // No siblings — any value works; align with the implicit createdAt
  // axis so future inserts sit naturally.
  return Date.now();
}

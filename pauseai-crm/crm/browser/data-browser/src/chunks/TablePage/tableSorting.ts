import { dataBrowser } from '@tomic/react';

export interface TableSorting {
  prop: string;
  sortDesc: boolean;
}

/**
 * Default row order: `sortOrder`, the fractional sibling-order key. The server
 * falls back to `createdAt` for rows without an explicit key, so this is
 * identical to creation order until a row is explicitly positioned (e.g.
 * Shift+Enter inserting below the cursor).
 */
export const DEFAULT_SORT_PROP = dataBrowser.properties.sortOrder;

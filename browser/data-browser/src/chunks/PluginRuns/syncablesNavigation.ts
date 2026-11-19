import { canonicalizeScheme } from '@tomic/lib';

const PLATFORM_ID = /^syncables:platform:https?%3A%2F%2F[^:]+:[a-z0-9-]{1,80}$/;
const NODE_PREFIX = 'syncables:node:';

/** Stable installation IDs are independent of the App's current display name. */
export function isSyncablesPlatformRoot(localId: unknown): boolean {
  return typeof localId === 'string' && PLATFORM_ID.test(localId);
}

/** These tables hold resources that belong in the drive's navigation tree. */
export function isSyncablesNavigationTable(localId: unknown): boolean {
  if (typeof localId !== 'string') return false;
  if (localId === 'syncables:accounts') return true;
  if (isSyncablesPlatformRoot(localId)) return true;
  if (!localId.startsWith(NODE_PREFIX) || localId.length > 65_536) return false;

  try {
    const key: unknown = JSON.parse(
      decodeURIComponent(localId.slice(NODE_PREFIX.length)),
    );

    if (key && typeof key === 'object' && !Array.isArray(key)) {
      const source = key as Record<string, unknown>;
      const principal = source.principal;

      // Navigation alone grants no read/write authority. Host profiles validate
      // the complete source identity before executing any collection action.
      return (
        source.version === 2 &&
        (source.kind === 'collection' || source.kind === 'principal') &&
        typeof source.proxyOrigin === 'string' &&
        source.proxyOrigin.length > 0 &&
        typeof source.platform === 'string' &&
        source.platform.length > 0 &&
        !!principal &&
        typeof principal === 'object' &&
        !Array.isArray(principal) &&
        ((principal as Record<string, unknown>).kind === 'authenticated' ||
          (principal as Record<string, unknown>).kind === 'public')
      );
    }

    return (
      Array.isArray(key) &&
      (key.length === 5 || key.length === 6) &&
      (key[2] === 'organizations' ||
        key[2] === 'repositories' ||
        key[2] === 'public')
    );
  } catch {
    return false;
  }
}

/** View definitions use the table's parent link, just like its real children. */
export function withoutTableViews(
  children: string[],
  viewSubjects: string[],
): string[] {
  if (viewSubjects.length === 0) return children;
  const views = new Set(viewSubjects.filter(Boolean).map(canonicalizeScheme));

  return children.filter(subject => !views.has(canonicalizeScheme(subject)));
}

import { canonicalizeScheme } from '@tomic/lib';

const PLATFORM_ID = /^syncables:platform:https?%3A%2F%2F[^:]+:[a-z0-9-]{1,80}$/;
const NODE_PREFIX = 'syncables:node:';

/** These tables hold resources that belong in the drive's navigation tree. */
export function isSyncablesNavigationTable(localId: unknown): boolean {
  if (typeof localId !== 'string') return false;
  if (PLATFORM_ID.test(localId)) return true;
  if (!localId.startsWith(NODE_PREFIX)) return false;

  try {
    const key: unknown = JSON.parse(
      decodeURIComponent(localId.slice(NODE_PREFIX.length)),
    );

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

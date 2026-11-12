/**
 * Which drive subjects a component may hand to `useResources` (which fetches).
 *
 * Other drives than the current one are never fetched in the background: the
 * agent's saved/recent lists can hold legacy drives on servers that no longer
 * serve them, and every fetch of those is a failing network request. A drive
 * is fetched only when the person opens the switcher; until then, drives
 * already in memory or kept on this device cost nothing and stay allowed.
 */
export function lazyDriveSubjects(
  subjects: string[],
  opts: {
    /** The switcher / list is open, so the person is looking at the titles. */
    opened: boolean;
    isLocal: (subject: string) => boolean;
    isLoaded: (subject: string) => boolean;
  },
): string[] {
  if (opts.opened) return subjects;

  return subjects.filter(s => opts.isLocal(s) || opts.isLoaded(s));
}

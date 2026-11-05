/**
 * Resources the user opened recently, per drive, most recent first. Kept in
 * localStorage so the `@` mention menu can offer them before anything is
 * typed, when full-text search has no query to rank on.
 *
 * Kept per agent: a browser can hold several identities, and one must not see
 * what another opened. Without an agent nothing is shown or written.
 */

const MAX_PER_DRIVE = 20;

export const recentResourcesKey = (agent: string) => `recentResources:${agent}`;

/** The key from before recents were per agent. Its owner is unknown, so it is
 * dropped, not migrated. */
const LEGACY_KEY = 'recentResources';

try {
  window.localStorage.removeItem(LEGACY_KEY);
} catch {
  // Storage unavailable: there is nothing to remove.
}

type RecentResources = Record<string, string[]>;

function read(agent: string | undefined): RecentResources {
  if (!agent) return {};

  try {
    const raw = window.localStorage.getItem(recentResourcesKey(agent));
    const parsed: unknown = raw ? JSON.parse(raw) : {};

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as RecentResources)
      : {};
  } catch {
    return {};
  }
}

export function getRecentResources(
  agent: string | undefined,
  drive: string,
): string[] {
  const list = read(agent)[drive];

  return Array.isArray(list) ? list : [];
}

const listeners = new Set<() => void>();

/** Calls `cb` whenever a recent list changes in this tab. */
export function subscribeRecentResources(cb: () => void): () => void {
  listeners.add(cb);

  return () => {
    listeners.delete(cb);
  };
}

function write(agent: string, all: RecentResources): void {
  try {
    window.localStorage.setItem(recentResourcesKey(agent), JSON.stringify(all));
  } catch {
    // Storage full or blocked: recents are a convenience, not state.
  }

  listeners.forEach(l => l());
}

export function addRecentResource(
  agent: string | undefined,
  drive: string,
  subject: string,
): void {
  if (!agent) return;

  // The drive itself is always one click away in the sidebar.
  if (subject === drive) return;

  const all = read(agent);
  const current = Array.isArray(all[drive]) ? all[drive] : [];

  if (current[0] === subject) return;

  all[drive] = [subject, ...current.filter(s => s !== subject)].slice(
    0,
    MAX_PER_DRIVE,
  );

  write(agent, all);
}

/** Forgets `subject`, e.g. because it was deleted, trashed or went missing. */
export function removeRecentResource(
  agent: string | undefined,
  drive: string,
  subject: string,
): void {
  if (!agent) return;

  const all = read(agent);
  const current = Array.isArray(all[drive]) ? all[drive] : [];

  if (!current.includes(subject)) return;

  all[drive] = current.filter(s => s !== subject);
  write(agent, all);
}

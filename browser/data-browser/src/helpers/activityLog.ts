// @wc-ignore-file
/**
 * Pure helpers for the drive's activity log: a small, bounded JSON array kept
 * on the drive resource (`dataBrowser.properties.activityLog`), newest first.
 * No store access here so the merge rules are easy to test.
 */

export type ActivityKind = 'created' | 'edited' | 'deleted';

export interface ActivityEntry {
  subject: string;
  agent: string;
  /** Unix ms. */
  at: number;
  kind: ActivityKind;
}

/** Hard bound on the stored log. Keeps the drive's JSON value small. */
export const MAX_ACTIVITY_ENTRIES = 50;
/** Same agent + same subject within this window is one entry. */
export const COALESCE_MS = 10 * 60 * 1000;
/**
 * A timestamp-only refresh younger than this is not worth a drive commit, so
 * `mergeActivity` hands back the same array and the writer skips the save.
 */
export const MIN_REWRITE_MS = 60 * 1000;

const KINDS: ActivityKind[] = ['created', 'edited', 'deleted'];

function isEntry(value: unknown): value is ActivityEntry {
  if (!value || typeof value !== 'object') return false;

  const v = value as Record<string, unknown>;

  return (
    typeof v.subject === 'string' &&
    typeof v.agent === 'string' &&
    typeof v.at === 'number' &&
    Number.isFinite(v.at) &&
    KINDS.includes(v.kind as ActivityKind)
  );
}

/** Reads whatever the drive holds (array, JSON string or nothing) into entries. */
export function parseActivityLog(value: unknown): ActivityEntry[] {
  let raw = value;

  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }

  if (!Array.isArray(raw)) return [];

  return raw.filter(isEntry).slice(0, MAX_ACTIVITY_ENTRIES);
}

function combineKind(
  existing: ActivityKind,
  incoming: ActivityKind,
): ActivityKind {
  if (incoming === 'deleted' || existing === 'deleted') return 'deleted';

  if (existing === 'created' || incoming === 'created') return 'created';

  return 'edited';
}

/**
 * Folds new activity into the log. Returns the very same `log` array when
 * nothing worth persisting changed.
 */
export function mergeActivity(
  log: ActivityEntry[],
  incoming: ActivityEntry[],
): ActivityEntry[] {
  const next = log.map(entry => ({ ...entry }));
  let changed = false;

  for (const item of [...incoming].sort((a, b) => a.at - b.at)) {
    const index = next.findIndex(
      e =>
        e.subject === item.subject &&
        e.agent === item.agent &&
        Math.abs(item.at - e.at) <= COALESCE_MS,
    );

    if (index === -1) {
      next.push({ ...item });
      changed = true;
      continue;
    }

    const existing = next[index];
    const kind = combineKind(existing.kind, item.kind);
    const at = Math.max(existing.at, item.at);

    if (kind !== existing.kind || at - existing.at >= MIN_REWRITE_MS) {
      changed = true;
    }

    existing.kind = kind;
    existing.at = at;
  }

  if (!changed) return log;

  return next.sort((a, b) => b.at - a.at).slice(0, MAX_ACTIVITY_ENTRIES);
}

export type ActivityGroupLabel = 'Today' | 'This week' | 'Earlier';

export interface ActivityGroup {
  label: ActivityGroupLabel;
  entries: ActivityEntry[];
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Buckets (already newest-first) entries into Today / This week / Earlier. */
export function groupActivity(
  entries: ActivityEntry[],
  now: number = Date.now(),
): ActivityGroup[] {
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const buckets: Record<ActivityGroupLabel, ActivityEntry[]> = {
    Today: [],
    'This week': [],
    Earlier: [],
  };

  for (const entry of entries) {
    if (entry.at >= startOfToday) buckets.Today.push(entry);
    else if (entry.at >= startOfToday - 6 * DAY_MS) {
      buckets['This week'].push(entry);
    } else buckets.Earlier.push(entry);
  }

  return (['Today', 'This week', 'Earlier'] as const)
    .filter(label => buckets[label].length > 0)
    .map(label => ({ label, entries: buckets[label] }));
}

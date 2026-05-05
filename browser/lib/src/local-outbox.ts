/**
 * Single durable queue for "writes that haven't reached the server".
 * Replaces the prior 4-store quartet (`_pendingCommits` +
 * `atomic.offline.<subject>` + `dirtyForSync` Set +
 * `atomic.dirtyForSync` localStorage key) with one Map + one
 * localStorage key.
 *
 * Drain is idempotent — concurrent calls share the in-flight
 * promise, which is the structural version of the `pushCommits`
 * re-entrance fix from `5c168355`.
 */

import type { Commit } from './commit.js';
import { commitToJsonADObject, parseCommitJSON } from './commit.js';

export interface OutboxEntry {
  subject: string;
  commits: Commit[];
  enqueuedAt: number;
  lastAttemptAt?: number;
  lastAttemptError?: string;
}

export interface OutboxDrainContext {
  /** Throw to leave the entry queued with `lastAttemptError` set. */
  postEntry: (entry: OutboxEntry) => Promise<void>;
  /** Caller-supplied ordering (agents → drive → children). */
  sort: (entries: readonly OutboxEntry[]) => OutboxEntry[];
  /** Optional: classify a post failure as terminal (the commit can never
   *  succeed, e.g. genesis collision against an existing server resource).
   *  Terminal entries are dropped from the outbox after `onTerminalDrop`
   *  fires, so the client recovers automatically instead of retrying
   *  the same doomed commit on every reconnect. */
  isTerminalError?: (entry: OutboxEntry, error: unknown) => boolean;
  /** Notification hook for dropped entries — caller typically surfaces
   *  a toast and clears related local state. */
  onTerminalDrop?: (entry: OutboxEntry, error: unknown) => void;
}

/**
 * Pattern-match server error messages that mean "this commit will never
 * be accepted, no matter how many times we retry." Returning `true` drops
 * the offending entry from the outbox; `false` keeps it queued for the
 * next drain.
 *
 * Conservative by design — only patterns we're certain are terminal go
 * here. A false positive silently discards a user write, which is worse
 * than retrying forever (the worse failure mode is already what the
 * outbox does without this guard). Add new entries only with the server-
 * side error string they correspond to.
 */
export function isTerminalCommitErrorMessage(message: string): boolean {
  // Genesis collision: client tried to (re-)create a resource that
  // already exists. Happens when local state lost `lastCommit` and a
  // follow-up save built a genesis commit. The resource is fine on the
  // server; the only loss is the never-applied diff in this commit.
  // See `planning/fix-canvas-genesis-save.md`.
  if (message.includes('is_genesis: true, but the resource already exists')) {
    return true;
  }

  return false;
}

const STORAGE_KEY = 'atomic.outbox';
const LEGACY_DIRTY_KEY = 'atomic.dirtyForSync';
const LEGACY_OFFLINE_PREFIX = 'atomic.offline.';

interface PersistedEntry {
  subject: string;
  commits: unknown[];
  enqueuedAt: number;
}

export class LocalOutbox {
  private entries = new Map<string, OutboxEntry>();
  private drainInFlight: Promise<void> | undefined;
  private onChange: () => void = () => undefined;

  constructor(onChange?: () => void) {
    if (onChange) this.onChange = onChange;
    this.hydrate();
  }

  upsertCommit(subject: string, commit: Commit): void {
    const entry: OutboxEntry = this.entries.get(subject) ?? {
      subject,
      commits: [],
      enqueuedAt: Date.now(),
    };
    entry.commits.push(commit);
    this.entries.set(subject, entry);
    this.persist();
    this.onChange();
  }

  /** Replace the queue for a subject. Empty array clears the entry. */
  setEntry(subject: string, commits: Commit[]): void {
    if (commits.length === 0) {
      this.entries.delete(subject);
    } else {
      const existing = this.entries.get(subject);
      this.entries.set(subject, {
        subject,
        commits: [...commits],
        enqueuedAt: existing?.enqueuedAt ?? Date.now(),
      });
    }

    this.persist();
    this.onChange();
  }

  pending(): readonly OutboxEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  hasPending(subject: string): boolean {
    return this.entries.has(subject);
  }

  getEntry(subject: string): OutboxEntry | undefined {
    return this.entries.get(subject);
  }

  /** True while a drain is in flight. Mirrors `drainInFlight` for
   * external read access (status displays). */
  get isDraining(): boolean {
    return this.drainInFlight !== undefined;
  }

  /** Idempotent drain: concurrent calls share the in-flight promise. */
  async drain(ctx: OutboxDrainContext): Promise<void> {
    if (this.drainInFlight) return this.drainInFlight;
    this.drainInFlight = this.doDrain(ctx).finally(() => {
      this.drainInFlight = undefined;
    });

    return this.drainInFlight;
  }

  private async doDrain(ctx: OutboxDrainContext): Promise<void> {
    if (this.entries.size === 0) return;

    for (const entry of ctx.sort([...this.entries.values()])) {
      // Re-fetch in case `upsertCommit` ran for the same subject
      // while we were draining earlier entries.
      const live = this.entries.get(entry.subject);
      if (!live) continue;
      live.lastAttemptAt = Date.now();

      try {
        await ctx.postEntry(live);
        // Remove only the commits we actually posted. Compare by
        // signature, not array length, because `setEntry` REPLACES
        // the queue rather than appending: if new commits arrived
        // during the post and happened to land at the same total
        // length as `live` (e.g. typing one letter while the previous
        // letter's commit was in flight), a length-based check
        // silently dropped the new ones. Repro: e2e
        // `quick-edit text typing ux` and `rename-regression`.
        const after = this.entries.get(entry.subject);

        if (after) {
          const postedSigs = new Set(
            live.commits.map(c => c.signature).filter((s): s is string => !!s),
          );
          const remaining = after.commits.filter(
            c => !c.signature || !postedSigs.has(c.signature),
          );

          if (remaining.length === 0) {
            this.entries.delete(entry.subject);
          } else {
            after.commits = remaining;
          }
        }
      } catch (e) {
        live.lastAttemptError = e instanceof Error ? e.message : String(e);

        // Terminal errors (e.g. genesis-against-existing-resource) can't
        // be retried into success — drop the entry so the client stops
        // re-posting the same doomed commit on every reconnect, then
        // notify the caller so it can show a toast / clear related
        // local state.
        if (ctx.isTerminalError?.(live, e)) {
          console.warn(
            '[Outbox] dropping terminal entry',
            live.subject,
            '—',
            live.lastAttemptError,
          );
          this.entries.delete(entry.subject);
          ctx.onTerminalDrop?.(live, e);
        }
      }

      this.persist();
      this.onChange();
    }
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      if (this.entries.size === 0) {
        localStorage.removeItem(STORAGE_KEY);

        return;
      }

      const out: PersistedEntry[] = [...this.entries.values()].map(e => ({
        subject: e.subject,
        commits: e.commits.map(c => commitToJsonADObject(c)),
        enqueuedAt: e.enqueuedAt,
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch (e) {
      console.warn('[Outbox] persist failed:', e);
    }
  }

  /** Read unified key; one-shot migrate the legacy keys if needed. */
  private hydrate(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);

      if (raw) {
        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed)) {
          for (const p of parsed as PersistedEntry[]) this.hydrateEntry(p);

          return;
        }
      }
    } catch (e) {
      console.warn('[Outbox] hydrate failed:', e);
    }

    // Legacy migration: pull from `atomic.dirtyForSync` +
    // `atomic.offline.<subject>` keys, then delete them.
    try {
      const subjects = JSON.parse(
        localStorage.getItem(LEGACY_DIRTY_KEY) ?? 'null',
      );
      if (!Array.isArray(subjects)) return;

      for (const subject of subjects) {
        if (typeof subject !== 'string') continue;
        const raw = localStorage.getItem(LEGACY_OFFLINE_PREFIX + subject);
        if (!raw) continue;

        try {
          this.hydrateEntry({
            subject,
            commits: JSON.parse(raw),
            enqueuedAt: Date.now(),
          });
        } catch {
          // skip bad entry
        }
      }

      localStorage.removeItem(LEGACY_DIRTY_KEY);
      for (const s of subjects)
        localStorage.removeItem(LEGACY_OFFLINE_PREFIX + s);
      this.persist();
    } catch (e) {
      console.warn('[Outbox] legacy migration failed:', e);
    }
  }

  private hydrateEntry(p: PersistedEntry): void {
    if (!p.subject || !Array.isArray(p.commits)) return;
    const commits: Commit[] = [];

    for (const c of p.commits) {
      try {
        commits.push(parseCommitJSON(JSON.stringify(c)));
      } catch {
        // skip individual bad commit
      }
    }

    if (commits.length > 0) {
      this.entries.set(p.subject, {
        subject: p.subject,
        commits,
        enqueuedAt: p.enqueuedAt ?? Date.now(),
      });
    }
  }
}

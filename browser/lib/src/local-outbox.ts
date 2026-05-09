/**
 * Single durable queue for "writes that haven't reached the server".
 *
 * Before this class existed, four parallel stores tracked the same
 * concept:
 *
 *   1. `Resource._pendingCommits: Commit[]` — in-memory per-resource
 *      queue, drained by `pushCommits`.
 *   2. `localStorage['atomic.offline.<subject>']` — per-subject JSON
 *      blob of commits that survived a reload.
 *   3. `Store.dirtyForSync: Set<string>` — in-memory "which subjects
 *      need drain on reconnect".
 *   4. `localStorage['atomic.dirtyForSync']` — persisted version of #3.
 *
 * They had to be kept in sync manually, and a fifth piece —
 * `Resource._lastLocalSignature` — was in-memory only, so reload
 * partially forgot the commit chain.
 *
 * `LocalOutbox` is the single source of truth. The in-memory map is
 * the working copy; one localStorage key (`atomic.outbox`) is the
 * durable mirror. Drain is idempotent — concurrent calls join the
 * in-flight promise (folds in the re-entrance fix from `5c168355`).
 *
 * `Resource._pendingCommits` still exists as the ephemeral signing
 * buffer (signing produces N commits in one synchronous call;
 * persistence happens once afterward). After `pushCommits` runs the
 * outbox is the canonical record; the in-memory array is cleared.
 */

import type { Commit } from './commit.js';
import { commitToJsonADObject, parseCommitJSON } from './commit.js';

/** One queued write — the commit chain for a single resource subject. */
export interface OutboxEntry {
  subject: string;
  commits: Commit[];
  enqueuedAt: number;
  /** Updated on each drain attempt so the UI can surface "stuck" entries. */
  lastAttemptAt?: number;
  lastAttemptError?: string;
}

/**
 * What the outbox needs from the outside world to drain entries.
 * Decoupled so the outbox doesn't depend on `Store` or `WSClient`.
 */
export interface OutboxDrainContext {
  /**
   * Called once per entry, in priority order. Should return when the
   * entry has been fully synced (all commits posted, server acked).
   * Throwing leaves the entry in the queue with `lastAttemptError`
   * set; the next drain will retry.
   */
  postEntry: (entry: OutboxEntry) => Promise<void>;
  /**
   * Caller-supplied ordering: agents before drives before children,
   * shallow before deep. Optional — default is insertion order, which
   * works when the caller queues commits in the right order anyway.
   */
  sort?: (entries: readonly OutboxEntry[]) => OutboxEntry[];
}

const STORAGE_KEY = 'atomic.outbox';
const LEGACY_DIRTY_KEY = 'atomic.dirtyForSync';
const LEGACY_OFFLINE_PREFIX = 'atomic.offline.';

interface PersistedEntry {
  subject: string;
  commits: unknown[]; // serialised commits (parseCommitJSON-shaped)
  enqueuedAt: number;
}

export class LocalOutbox {
  private entries = new Map<string, OutboxEntry>();
  private drainInFlight: Promise<void> | undefined;
  private listeners = new Set<() => void>();

  constructor() {
    this.hydrate();
  }

  /**
   * Append a commit to the entry for `subject`. Creates a fresh
   * entry if one doesn't exist. Persists synchronously so a reload
   * mid-keystroke doesn't lose the commit.
   */
  upsertCommit(subject: string, commit: Commit): void {
    const existing = this.entries.get(subject);
    const entry: OutboxEntry = existing ?? {
      subject,
      commits: [],
      enqueuedAt: Date.now(),
    };
    entry.commits.push(commit);
    this.entries.set(subject, entry);
    this.persist();
    this.emitChange();
  }

  /**
   * Replace the entry for `subject` wholesale. Used by
   * `Resource.applyPendingCommitsLocally` which wants to set the
   * commit chain from `_pendingCommits` in one go (and in the
   * post-reload path where we hydrate from localStorage to seed
   * `_pendingCommits` back).
   */
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
    this.emitChange();
  }

  /**
   * Remove an entry — call after `postEntry` succeeds for the
   * corresponding subject.
   */
  clearEntry(subject: string): void {
    if (this.entries.delete(subject)) {
      this.persist();
      this.emitChange();
    }
  }

  /** Snapshot of the queue for status displays / sync-page. */
  pending(): readonly OutboxEntry[] {
    return [...this.entries.values()];
  }

  /** Number of pending subjects — replaces `dirtyForSync.size`. */
  get size(): number {
    return this.entries.size;
  }

  /** Subjects with pending commits — replaces `[...dirtyForSync]`. */
  pendingSubjects(): string[] {
    return [...this.entries.keys()];
  }

  hasPending(subject: string): boolean {
    return this.entries.has(subject);
  }

  /** Read the (potentially stale) entry for a subject without copying. */
  getEntry(subject: string): OutboxEntry | undefined {
    return this.entries.get(subject);
  }

  /**
   * Drain every entry against `ctx.postEntry`. Idempotent —
   * concurrent calls share the in-flight promise. Failures leave
   * the failing entry in the queue with `lastAttemptError` set so
   * the next drain retries it.
   */
  async drain(ctx: OutboxDrainContext): Promise<void> {
    if (this.drainInFlight) return this.drainInFlight;

    this.drainInFlight = this.doDrain(ctx).finally(() => {
      this.drainInFlight = undefined;
    });

    return this.drainInFlight;
  }

  private async doDrain(ctx: OutboxDrainContext): Promise<void> {
    if (this.entries.size === 0) return;

    const ordered = (ctx.sort ?? defaultSort)([...this.entries.values()]);

    for (const entry of ordered) {
      // Re-fetch from the map in case a concurrent `upsertCommit` on
      // the same subject added new commits while we were draining
      // earlier entries.
      const live = this.entries.get(entry.subject);
      if (!live) continue;

      live.lastAttemptAt = Date.now();

      try {
        await ctx.postEntry(live);
        // Success — only clear if no NEW commits arrived during the
        // post (a `signChanges` for the same subject mid-drain). We
        // compare commit counts rather than identity to handle the
        // case where `postEntry` mutates the entry in place.
        const after = this.entries.get(entry.subject);
        if (after && after.commits.length === live.commits.length) {
          this.entries.delete(entry.subject);
        } else if (after) {
          // Fresh commits arrived; remove the ones we successfully
          // posted, keep the rest for the next drain.
          after.commits = after.commits.slice(live.commits.length);
        }
        this.persist();
        this.emitChange();
      } catch (e) {
        live.lastAttemptError = e instanceof Error ? e.message : String(e);
        this.persist();
        this.emitChange();
        // Continue draining other entries — one stuck subject
        // shouldn't block the rest.
      }
    }
  }

  /** Subscribe to outbox changes (size, content). */
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);

    return () => {
      this.listeners.delete(cb);
    };
  }

  private emitChange(): void {
    for (const cb of this.listeners) cb();
  }

  private persist(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      if (this.entries.size === 0) {
        localStorage.removeItem(STORAGE_KEY);

        return;
      }

      const serialised: PersistedEntry[] = [...this.entries.values()].map(
        e => ({
          subject: e.subject,
          commits: e.commits.map(c => commitToJsonADObject(c)),
          enqueuedAt: e.enqueuedAt,
        }),
      );
      localStorage.setItem(STORAGE_KEY, JSON.stringify(serialised));
    } catch (e) {
      console.warn('[Outbox] persist failed:', e);
    }
  }

  /**
   * Read the persisted state on construction. Also performs a
   * one-shot migration from the legacy `atomic.offline.<subject>`
   * + `atomic.dirtyForSync` keys — once the migration runs we
   * delete those keys so the next reload only consults the
   * unified store.
   */
  private hydrate(): void {
    if (typeof localStorage === 'undefined') return;

    // Preferred path: unified key.
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as PersistedEntry[];
        if (Array.isArray(parsed)) {
          for (const p of parsed) {
            if (!p.subject || !Array.isArray(p.commits)) continue;
            const commits: Commit[] = [];
            for (const c of p.commits) {
              try {
                commits.push(parseCommitJSON(JSON.stringify(c)));
              } catch {
                // Skip individual bad commit; don't drop the whole entry.
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
          return;
        }
      }
    } catch (e) {
      console.warn('[Outbox] hydrate from unified key failed:', e);
    }

    // Migration path: pull from legacy keys.
    try {
      const dirtyRaw = localStorage.getItem(LEGACY_DIRTY_KEY);
      if (!dirtyRaw) return;
      const subjects = JSON.parse(dirtyRaw);
      if (!Array.isArray(subjects)) return;

      for (const subject of subjects) {
        if (typeof subject !== 'string') continue;
        const offlineRaw = localStorage.getItem(
          LEGACY_OFFLINE_PREFIX + subject,
        );
        if (!offlineRaw) continue;
        try {
          const arr = JSON.parse(offlineRaw);
          if (!Array.isArray(arr)) continue;
          const commits: Commit[] = [];
          for (const c of arr) {
            try {
              commits.push(parseCommitJSON(JSON.stringify(c)));
            } catch {
              // skip
            }
          }
          if (commits.length > 0) {
            this.entries.set(subject, {
              subject,
              commits,
              enqueuedAt: Date.now(),
            });
          }
        } catch {
          // skip
        }
      }

      // Migration complete — clean up legacy keys + persist unified.
      localStorage.removeItem(LEGACY_DIRTY_KEY);
      for (const subject of subjects) {
        localStorage.removeItem(LEGACY_OFFLINE_PREFIX + subject);
      }
      this.persist();
    } catch (e) {
      console.warn('[Outbox] legacy migration failed:', e);
    }
  }
}

/**
 * Default sort for `drain`. Mirrors the prior `Store.sortDirtyForSync`:
 * agents first, then drives, then everything else; within a tier,
 * shallow-parent before deep.
 */
function defaultSort(entries: readonly OutboxEntry[]): OutboxEntry[] {
  const priority = (subject: string): number => {
    if (subject.startsWith('did:ad:agent:')) return 0;
    return 2; // Drive priority needs the Store; default leaves it on the caller.
  };

  return [...entries].sort((a, b) => priority(a.subject) - priority(b.subject));
}

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

  pendingSubjects(): string[] {
    return [...this.entries.keys()];
  }

  hasPending(subject: string): boolean {
    return this.entries.has(subject);
  }

  getEntry(subject: string): OutboxEntry | undefined {
    return this.entries.get(subject);
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
        // If new commits arrived during the post, keep the unposted
        // tail; otherwise clear the entry.
        const after = this.entries.get(entry.subject);
        if (after && after.commits.length === live.commits.length) {
          this.entries.delete(entry.subject);
        } else if (after) {
          after.commits = after.commits.slice(live.commits.length);
        }
      } catch (e) {
        live.lastAttemptError = e instanceof Error ? e.message : String(e);
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

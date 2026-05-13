/**
 * Single durable queue for "writes that haven't reached the server".
 *
 * Sign-at-drain shape: the outbox tracks **dirty subjects** rather than
 * signed commits. Local Loro edits mark a subject dirty; the drain
 * exports the accumulated Loro delta, signs ONE commit per subject per
 * drain pass, POSTs, and clears the dirty bit.
 *
 * Two exceptions to the "no signed commits in the outbox" rule:
 * - `signedGenesis`: the DID-derived subject of a new resource requires
 *   a synchronous sign of the genesis commit (the signature *is* the
 *   subject). That envelope is stored here and POSTed verbatim before
 *   any incremental delta sign for the same subject.
 *
 * Drain is idempotent — concurrent calls share the in-flight promise.
 */

import type { Commit } from './commit.js';
import { commitToJsonADObject, parseCommitJSON } from './commit.js';

export interface OutboxEntry {
  subject: string;
  /** When this subject first became dirty since the last successful drain.
   *  Used for ordering and stale-entry detection. */
  enqueuedAt: number;
  /** Pre-signed genesis commit. Set by `newResource` when DID-deriving
   *  the subject from a sync sign. Drain POSTs this verbatim before
   *  attempting any incremental Loro-delta sign. Cleared on ack. */
  signedGenesis?: Commit;
  /** Base64-encoded Loro `VersionVector` of the last version that was
   *  successfully synced to the server, captured when this subject went
   *  dirty WHILE OFFLINE. On reload the Loro doc rehydrates from clientDb
   *  with the offline edit already applied, so its save cursor would reset
   *  to the current (edited) version and the reconnect drain would compute
   *  an empty delta — silently dropping the offline edit. Restoring the
   *  cursor to THIS version before the first post-reload export makes the
   *  drain emit the offline delta. Cleared once that delta is acked. */
  baseVersion?: string;
  lastAttemptAt?: number;
  lastAttemptError?: string;
}

export interface OutboxDrainContext {
  /** Drain ONE subject: POST signedGenesis if present, then export the
   *  Loro delta, sign one commit, POST, advance the export cursor.
   *  Throw to leave the entry dirty with `lastAttemptError` set. */
  drainSubject: (subject: string) => Promise<void>;
  /** Caller-supplied ordering (agents → drive → children). */
  sort: (entries: readonly OutboxEntry[]) => OutboxEntry[];
  /** Optional: classify a drain failure as terminal (the entry can never
   *  succeed, e.g. genesis collision against an existing server resource).
   *  Terminal entries are cleared from the outbox after `onTerminalDrop`
   *  fires. */
  isTerminalError?: (entry: OutboxEntry, error: unknown) => boolean;
  /** Notification hook for dropped entries — caller typically surfaces
   *  a toast and clears related local state. */
  onTerminalDrop?: (entry: OutboxEntry, error: unknown) => void;
}

/**
 * Pattern-match server error messages that mean "this drain will never
 * succeed, no matter how many times we retry." Returning `true` drops
 * the offending entry from the outbox; `false` keeps it queued for the
 * next drain.
 *
 * Conservative by design — only patterns we're certain are terminal go
 * here. A false positive silently discards a user write, which is worse
 * than retrying forever. Add new entries only with the server-side error
 * string they correspond to.
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
  enqueuedAt: number;
  signedGenesis?: unknown;
  baseVersion?: string;
}

export class LocalOutbox {
  private entries = new Map<string, OutboxEntry>();
  private drainInFlight: Promise<void> | undefined;
  private onChange: () => void = () => undefined;
  private persistScheduled = false;

  constructor(onChange?: () => void) {
    if (onChange) this.onChange = onChange;
    this.hydrate();

    // Best-effort: flush pending writes before the tab closes.
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.flushPersist());
      window.addEventListener('pagehide', () => this.flushPersist());
    }
  }

  /** Mark a subject as having local Loro edits that need to drain.
   *  Idempotent; called once per Loro local-updates fire. */
  markDirty(subject: string): void {
    const existing = this.entries.get(subject);

    if (existing) {
      // Already dirty; bump enqueuedAt only if it was never set (recovery).
      this.schedulePersist();
      this.onChange();

      return;
    }

    this.entries.set(subject, {
      subject,
      enqueuedAt: Date.now(),
    });
    this.schedulePersist();
    this.onChange();
  }

  /** Clear the dirty bit for a subject. Called by the drain after the
   *  Loro delta has been signed + POSTed + acked. If a `signedGenesis`
   *  is still pending, the entry stays (use `clearGenesis` to also
   *  remove that). */
  clearDirty(subject: string): void {
    const entry = this.entries.get(subject);
    if (!entry) return;

    if (entry.signedGenesis) {
      // Still holding a genesis envelope — keep the entry but treat
      // it as "no incremental delta dirty"; the next drain will POST
      // the genesis envelope and recheck.
      this.schedulePersist();
      this.onChange();

      return;
    }

    this.entries.delete(subject);
    this.schedulePersist();
    this.onChange();
  }

  /** Stash a pre-signed genesis commit for `subject`. Marks the entry
   *  dirty so the drain picks it up. Called by `store.newResource` for
   *  DID-derived subjects (the signature *is* the subject). */
  setGenesisCommit(subject: string, commit: Commit): void {
    const entry: OutboxEntry = this.entries.get(subject) ?? {
      subject,
      enqueuedAt: Date.now(),
    };
    entry.signedGenesis = commit;
    this.entries.set(subject, entry);
    this.schedulePersist();
    this.onChange();
  }

  /** Drop the `signedGenesis` field after the genesis POST has acked.
   *  If the subject is also dirty (new Loro ops arrived during the
   *  genesis POST), the entry stays so the next drain pass signs the
   *  incremental delta. */
  clearGenesis(subject: string): void {
    const entry = this.entries.get(subject);
    if (!entry || !entry.signedGenesis) return;

    entry.signedGenesis = undefined;
    // After genesis: the entry still represents "this subject is
    // dirty" — any post-genesis Loro ops are queued by the
    // Loro subscriber's `markDirty`. Leave the entry; the drain
    // loop will detect "no Loro delta" and clear it.
    this.schedulePersist();
    this.onChange();
  }

  /** Record the last-synced Loro version for an offline edit, so a reload
   *  can restore the save cursor before draining (see `baseVersion` on
   *  `OutboxEntry`). Captures only the FIRST offline baseline per dirty
   *  span — later offline edits build on the same last-synced cursor (no
   *  successful drain happened in between), so we must not overwrite it
   *  with a newer version. */
  setBaseVersion(subject: string, baseVersion: string): void {
    const entry: OutboxEntry = this.entries.get(subject) ?? {
      subject,
      enqueuedAt: Date.now(),
    };

    if (entry.baseVersion === undefined) {
      entry.baseVersion = baseVersion;
      this.entries.set(subject, entry);
      this.schedulePersist();
      this.onChange();
    }
  }

  /** Drop the offline base version once its delta has been synced. */
  clearBaseVersion(subject: string): void {
    const entry = this.entries.get(subject);
    if (!entry || entry.baseVersion === undefined) return;

    entry.baseVersion = undefined;
    this.schedulePersist();
    this.onChange();
  }

  pending(): readonly OutboxEntry[] {
    return [...this.entries.values()];
  }

  get size(): number {
    return this.entries.size;
  }

  /** True when the subject has an entry — either a pre-signed genesis,
   *  a dirty bit, or both. */
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

    // Snapshot subjects at start. Newly-dirtied subjects mid-drain
    // get picked up by the next drain trigger (microtask onChange).
    for (const entry of ctx.sort([...this.entries.values()])) {
      const live = this.entries.get(entry.subject);
      if (!live) continue;
      live.lastAttemptAt = Date.now();

      try {
        await ctx.drainSubject(live.subject);
      } catch (e) {
        live.lastAttemptError = e instanceof Error ? e.message : String(e);

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

      this.schedulePersist();
      this.onChange();
    }
  }

  /**
   * Coalesce multiple mutations into one localStorage write per
   * microtask. The microtask flush keeps durability semantics in
   * practice (any await yields to the microtask queue and persists)
   * without the per-call CPU spike.
   */
  private schedulePersist(): void {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    queueMicrotask(() => {
      this.persistScheduled = false;
      this.flushPersist();
    });
  }

  /**
   * Synchronously write the current outbox state. Used by the
   * microtask flush above and by `beforeunload` / `pagehide`.
   */
  private flushPersist(): void {
    if (typeof localStorage === 'undefined') return;
    this.persistScheduled = false;

    try {
      if (this.entries.size === 0) {
        localStorage.removeItem(STORAGE_KEY);

        return;
      }

      const out: PersistedEntry[] = [...this.entries.values()].map(e => ({
        subject: e.subject,
        enqueuedAt: e.enqueuedAt,
        signedGenesis: e.signedGenesis
          ? commitToJsonADObject(e.signedGenesis)
          : undefined,
        baseVersion: e.baseVersion,
      }));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
    } catch (e) {
      console.warn('[Outbox] persist failed:', e);
    }
  }

  /** Force a synchronous write of the current state. */
  public flush(): void {
    this.flushPersist();
  }

  /** Read unified key; one-shot migrate the legacy keys if needed. */
  private hydrate(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const raw = localStorage.getItem(STORAGE_KEY);

      if (raw) {
        const parsed = JSON.parse(raw);

        if (Array.isArray(parsed)) {
          for (const p of parsed) this.hydrateEntry(p);

          return;
        }
      }
    } catch (e) {
      console.warn('[Outbox] hydrate failed:', e);
    }

    // Legacy migration: pull from `atomic.dirtyForSync` +
    // `atomic.offline.<subject>` keys, then delete them. Old shape
    // stored signed commits per subject; under sign-at-drain we just
    // mark them dirty and let the next drain re-sign from Loro state.
    try {
      const subjects = JSON.parse(
        localStorage.getItem(LEGACY_DIRTY_KEY) ?? 'null',
      );
      if (!Array.isArray(subjects)) return;

      for (const subject of subjects) {
        if (typeof subject !== 'string') continue;
        this.entries.set(subject, {
          subject,
          enqueuedAt: Date.now(),
        });
      }

      localStorage.removeItem(LEGACY_DIRTY_KEY);
      for (const s of subjects)
        localStorage.removeItem(LEGACY_OFFLINE_PREFIX + s);
      this.flushPersist();
    } catch (e) {
      console.warn('[Outbox] legacy migration failed:', e);
    }
  }

  private hydrateEntry(p: unknown): void {
    if (typeof p !== 'object' || p === null) return;
    const obj = p as Record<string, unknown>;
    if (typeof obj.subject !== 'string') return;

    let signedGenesis: Commit | undefined;

    if (obj.signedGenesis) {
      try {
        signedGenesis = parseCommitJSON(JSON.stringify(obj.signedGenesis));
      } catch {
        // skip — entry stays dirty without a pre-signed genesis,
        // which means the drain will try to sign a fresh delta.
      }
    }

    // Backcompat: old persisted entries had `commits: Commit[]`. We
    // no longer store signed envelopes here (the Loro state is the
    // source of truth), so the array is discarded — the next drain
    // re-signs from Loro. Empty commits arrays from clean shutdowns
    // are also discarded silently.
    const enqueuedAt =
      typeof obj.enqueuedAt === 'number' ? obj.enqueuedAt : Date.now();

    this.entries.set(obj.subject, {
      subject: obj.subject,
      enqueuedAt,
      signedGenesis,
      baseVersion:
        typeof obj.baseVersion === 'string' ? obj.baseVersion : undefined,
    });
  }
}

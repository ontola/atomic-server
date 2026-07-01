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
  /** Consecutive failed drain attempts. Drives exponential backoff so a
   *  persistently-failing commit (e.g. a parent not yet synced) stops
   *  hammering the server. Reset to 0 on success. */
  failures?: number;
  /** Set when a drain failed with an UNRECOVERABLE error that retrying can
   *  never fix (e.g. `401 Unauthorized` — the agent lacks write rights on the
   *  target parent). A blocked entry stays in the outbox so it stays visible to
   *  the user ("could not sync"), but the drain stops retrying it and the
   *  scheduler stops waking for it. Cleared by `markDirty` — a fresh local edit
   *  is a new signal worth re-attempting (rights may have since been granted). */
  blocked?: boolean;
}

/** Exponential backoff before re-attempting a failed drain: 1s, 2s, 4s … capped
 *  at 30s. Without this, a non-terminal failure reschedules immediately
 *  (`setTimeout(0)`) and the outbox spins on the server at full speed. */
const DRAIN_BACKOFF_BASE_MS = 1000;
const DRAIN_BACKOFF_MAX_MS = 30_000;

export function drainBackoffMs(failures: number): number {
  if (failures <= 0) return 0;

  return Math.min(
    DRAIN_BACKOFF_BASE_MS * 2 ** (failures - 1),
    DRAIN_BACKOFF_MAX_MS,
  );
}

// How many consecutive failures a BLOCKING-classified error (e.g. a 401) must
// rack up before we give up and park it. A 401 "no write right ... in its
// parents" is frequently TRANSIENT under sign-at-drain: a child/edit commit
// races ahead of its parent's genesis ack, so the parent chain the server
// walks for rights is briefly incomplete. Backoff-retry resolves it once the
// parent lands (usually within a few seconds). We only conclude "genuinely
// unauthorized" after the backoff has retried well past any ordering race —
// `drainBackoffMs` sums to ~90s of waiting by the 8th failure, far beyond the
// few-second window an ordering race needs.
export const BLOCK_AFTER_FAILURES = 8;

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
  /** Optional: classify a drain failure as BLOCKING — unrecoverable by retry
   *  (e.g. `401 Unauthorized`) but the entry is kept (not dropped) so it stays
   *  visible. A blocked entry is skipped by future drains until `markDirty`
   *  re-arms it. Checked after `isTerminalError`. */
  isBlockingError?: (entry: OutboxEntry, error: unknown) => boolean;
  /** Notification hook fired once when an entry transitions to blocked —
   *  caller typically surfaces a persistent "could not sync" message. */
  onBlocked?: (entry: OutboxEntry, error: unknown) => void;
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

  // Required-property validation failure: the commit produces a resource that
  // is missing a property its class `requires`, so the server rejects it on
  // EVERY attempt — the commit is structurally invalid, not transiently
  // unsyncable. Retrying floods the ingest pipeline forever (this is the
  // ai-message `content`-missing loop that peaked our ingest API). Dropping it
  // is correct: no retry can ever satisfy the constraint. The server emits
  // "Property <p> missing. Is required in class <c> " (resources.rs).
  if (message.includes('missing. Is required in class')) {
    return true;
  }

  return false;
}

/**
 * Pattern-match server errors that mean "this drain cannot succeed by
 * retrying, but the user write is not necessarily lost." Unlike
 * {@link isTerminalCommitErrorMessage} (which drops the entry), a match here
 * *blocks* the entry: it stays in the outbox, visible as "could not sync", and
 * stops being retried until a fresh local edit (`markDirty`) re-arms it.
 *
 * Authorization rejections are the canonical case: a commit POSTed under a
 * parent the agent has no `write` right on will be `401`-rejected forever.
 * Retrying spins the server (see the 401-flood); the only resolutions are a
 * rights change or the user abandoning the edit — neither helped by hammering.
 */
export function isUnrecoverableCommitErrorMessage(message: string): boolean {
  // Server emits: "No https://atomicdata.dev/properties/write right has been found..."
  if (message.includes('/properties/write right has been found')) {
    return true;
  }

  return false;
}

/** Prefix for per-agent outbox namespaces: `atomic.outbox.<agentSubject>`. */
const STORAGE_KEY_PREFIX = 'atomic.outbox';
/** Pre-scoping key: a SINGLE shared queue for all identities. Its existence is
 *  the cross-user bug — a new agent inherited a prior agent's commits. Migrated
 *  away (re-filed by owner) on first run, then deleted. */
const LEGACY_FLAT_KEY = 'atomic.outbox';
/** Namespace used when no agent is set (cold open before sign-in). Resource
 *  creation requires an agent, so in practice this stays empty. */
const ANON_NAMESPACE = '__anonymous__';
const LEGACY_DIRTY_KEY = 'atomic.dirtyForSync';
const LEGACY_OFFLINE_PREFIX = 'atomic.offline.';

/** localStorage key for an agent's outbox. The outbox is identity-scoped:
 *  each agent gets its own queue so a new identity never drains a previous
 *  agent's commits (whose `did:ad:<sig>` subjects are derived from that
 *  agent's signature and can't be re-signed by anyone else). */
function outboxKeyFor(agentSubject: string | undefined): string {
  return `${STORAGE_KEY_PREFIX}.${agentSubject ?? ANON_NAMESPACE}`;
}

/** The owning agent of a persisted entry: the signer of its pre-signed genesis
 *  commit. `undefined` for dirty-only entries that carry no signed envelope. */
function signerOfPersisted(p: unknown): string | undefined {
  if (typeof p !== 'object' || p === null) return undefined;

  const sg = (p as Record<string, unknown>).signedGenesis;
  if (!sg) return undefined;

  try {
    return parseCommitJSON(JSON.stringify(sg)).signer;
  } catch {
    return undefined;
  }
}

/** Parse a stored namespace value into an entry array; `[]` on absent/garbage. */
function parseStoredEntries(raw: string | null): PersistedEntry[] {
  if (!raw) return [];

  try {
    const parsed = JSON.parse(raw);

    return Array.isArray(parsed) ? (parsed as PersistedEntry[]) : [];
  } catch {
    return [];
  }
}

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
  /** localStorage key for the CURRENTLY-bound agent's queue. Switched by
   *  {@link rebind} on agent change. Starts anonymous until `setAgent`. */
  private activeKey: string = outboxKeyFor(undefined);

  constructor(onChange?: () => void) {
    if (onChange) this.onChange = onChange;
    // One-shot: split the old shared queue into per-agent namespaces before
    // hydrating, so a later `rebind` finds each agent's migrated entries.
    this.migrateLegacyFlatKey();
    this.hydrate();

    // Best-effort: flush pending writes before the tab closes.
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.flushPersist());
      window.addEventListener('pagehide', () => this.flushPersist());
    }
  }

  /** Bind the outbox to `agentSubject`'s queue. Persists the current agent's
   *  entries under its own key, then loads the target agent's pending entries.
   *  Called from `Store.setAgent` on every identity change (sign-in, invite,
   *  dev-drive recovery, sign-out). Each agent's outbox is isolated. */
  rebind(agentSubject: string | undefined): void {
    const nextKey = outboxKeyFor(agentSubject);
    if (nextKey === this.activeKey) return;

    // Persist the outgoing agent's queue under its key, then swap.
    this.flushPersist();
    this.entries.clear();
    this.activeKey = nextKey;
    this.hydrate();
    this.onChange();
  }

  /** Mark a subject as having local Loro edits that need to drain.
   *  Idempotent; called once per Loro local-updates fire. */
  markDirty(subject: string): void {
    const existing = this.entries.get(subject);

    if (existing) {
      // Already dirty; bump enqueuedAt only if it was never set (recovery).
      // A fresh edit re-arms a blocked entry: clear the block and the failure
      // streak so the next drain re-attempts (rights may now be granted).
      if (existing.blocked) {
        existing.blocked = false;
        existing.failures = 0;
      }

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

  /** Count of entries parked as {@link OutboxEntry.blocked} — unrecoverable by
   *  retry (e.g. `401`), kept only for visibility. `size - blockedCount` is the
   *  number still actively draining. */
  get blockedCount(): number {
    let n = 0;

    for (const e of this.entries.values()) {
      if (e.blocked) n++;
    }

    return n;
  }

  /** True when the subject has an entry — either a pre-signed genesis,
   *  a dirty bit, or both. */
  hasPending(subject: string): boolean {
    return this.entries.has(subject);
  }

  getEntry(subject: string): OutboxEntry | undefined {
    return this.entries.get(subject);
  }

  /** Soonest epoch-ms at which some entry is eligible to drain, honoring
   *  per-entry backoff. Returns 0 when something is due now, or undefined when
   *  the outbox is empty. `Store.scheduleOutboxDrain` uses this to wake at the
   *  right time instead of busy-retrying a failing entry. */
  nextDueAt(): number | undefined {
    let soonest: number | undefined;

    for (const e of this.entries.values()) {
      // Blocked entries never become due on their own — they wait for a fresh
      // `markDirty`. Excluding them lets `nextDueAt` return undefined when
      // nothing is drainable, so the scheduler doesn't arm a no-op timer.
      if (e.blocked) continue;

      const due =
        e.failures && e.lastAttemptAt !== undefined
          ? e.lastAttemptAt + drainBackoffMs(e.failures)
          : 0;

      if (soonest === undefined || due < soonest) {
        soonest = due;
      }
    }

    return soonest;
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

      // Blocked: an unrecoverable failure (e.g. 401) parked this entry. It
      // waits for a fresh `markDirty` to re-arm — never retried on its own.
      if (live.blocked) continue;

      // Backoff: skip an entry still inside its post-failure window. The next
      // drain (scheduled at `nextDueAt`) re-attempts it once it's due. Prevents
      // the immediate-retry spin on a persistently-failing commit.
      if (
        live.failures &&
        live.lastAttemptAt !== undefined &&
        Date.now() < live.lastAttemptAt + drainBackoffMs(live.failures)
      ) {
        continue;
      }

      live.lastAttemptAt = Date.now();

      try {
        await ctx.drainSubject(live.subject);
        // Success — clear the failure counter. The entry itself is usually
        // already removed by `drainSubject`; this handles the genesis-acked-
        // but-still-dirty leftover case.
        const stillLive = this.entries.get(entry.subject);
        if (stillLive) stillLive.failures = 0;
      } catch (e) {
        live.lastAttemptError = e instanceof Error ? e.message : String(e);
        console.warn(
          '[Outbox] drain failed for subject:',
          live.subject,
          'error:',
          live.lastAttemptError,
        );

        if (ctx.isTerminalError?.(live, e)) {
          // Unrecoverable AND the write is lost — drop it.
          console.warn(
            '[Outbox] dropping terminal entry',
            live.subject,
            '—',
            live.lastAttemptError,
          );
          this.entries.delete(entry.subject);
          ctx.onTerminalDrop?.(live, e);
        } else {
          // Back off and retry. This includes BLOCKING-classified errors
          // (e.g. 401): they are usually transient ordering races (parent not
          // yet synced), so we retry them like any failure. Only once a
          // blocking error has survived `BLOCK_AFTER_FAILURES` backoff retries
          // — long past any ordering race — do we park it as genuinely
          // unauthorized ("stop + surface"); a later `markDirty` re-arms it.
          live.failures = (live.failures ?? 0) + 1;

          if (
            live.failures >= BLOCK_AFTER_FAILURES &&
            ctx.isBlockingError?.(live, e)
          ) {
            console.warn(
              '[Outbox] blocking entry (stopped retrying after',
              live.failures,
              'failures) —',
              live.subject,
              '—',
              live.lastAttemptError,
            );
            live.blocked = true;
            ctx.onBlocked?.(live, e);
          }
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
        localStorage.removeItem(this.activeKey);

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
      localStorage.setItem(this.activeKey, JSON.stringify(out));
    } catch (e) {
      console.warn('[Outbox] persist failed:', e);
    }
  }

  /** Force a synchronous write of the current state. */
  public flush(): void {
    this.flushPersist();
  }

  /** Re-file the pre-scoping shared queue (`atomic.outbox`) into per-agent
   *  namespaces, keyed by each entry's `signedGenesis.signer`. Runs once: the
   *  flat key is deleted afterward. Dirty-only entries (no signed envelope)
   *  carry no owner — they are DROPPED rather than risk being adopted by the
   *  wrong identity, which is the exact cross-user bug this scoping fixes. */
  private migrateLegacyFlatKey(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const raw = localStorage.getItem(LEGACY_FLAT_KEY);
      if (raw === null) return;

      const parsed = JSON.parse(raw);

      if (Array.isArray(parsed)) {
        const byOwner = new Map<string, PersistedEntry[]>();

        for (const p of parsed) {
          const owner = signerOfPersisted(p);
          if (!owner) continue; // unattributable → drop

          const bucket = byOwner.get(owner) ?? [];
          bucket.push(p as PersistedEntry);
          byOwner.set(owner, bucket);
        }

        for (const [owner, entries] of byOwner) {
          const key = outboxKeyFor(owner);
          const existing = parseStoredEntries(localStorage.getItem(key));
          localStorage.setItem(key, JSON.stringify([...existing, ...entries]));
        }
      }

      localStorage.removeItem(LEGACY_FLAT_KEY);
    } catch (e) {
      console.warn('[Outbox] flat-key migration failed:', e);
    }
  }

  /** Read the active agent's namespace; one-shot migrate older keys if empty. */
  private hydrate(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      const raw = localStorage.getItem(this.activeKey);

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

import { AtomicError, RequestCancelledError } from './error.js';
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
 * - `signedDestroy`: a delete has no Loro delta to export at drain time —
 *   the signed destroy envelope IS the whole write. `Resource.destroy()`
 *   signs it eagerly, stores it here, and removes the resource locally;
 *   the drain POSTs it verbatim (with the same backoff / offline replay
 *   as any other entry) and drops the entry on ack.
 *
 * Drain is idempotent — a call that arrives while a pass is in flight
 * chains ONE follow-up pass (with a fresh entry snapshot) instead of
 * merely sharing the in-flight promise, so `await drain()` always means
 * "every entry that was dirty when I called has been attempted".
 *
 * Storage: the entries live in the client database (`Tree::Outbox` in the
 * agent's redb file, one row per subject), next to the snapshots they refer
 * to. An offline save writes its snapshot and its entry in one worker
 * message and one flush ({@link LocalOutbox.recordOfflineSave}), so a reload
 * finds both or neither. The database attaches a moment after page load, so
 * until {@link LocalOutbox.attachDatabase} has merged its rows the outbox is
 * not {@link LocalOutbox.hydrated}. Without a client database (Tauri, where
 * the local server persists everything; insecure origins; a database that
 * failed to open) the queue falls back to one JSON blob per agent in
 * localStorage, `atomic.outbox.<agent>`. That blob is also what older builds
 * wrote, so attaching a database imports it and then removes the key.
 */

import type { Commit } from './commit.js';
import {
  commitToJsonADObject,
  isCommitSubject,
  parseCommitJSON,
} from './commit.js';
import { ErrorCode } from './ws-v2.js';
import type { ClientDbOutboxWrite } from './client-db.js';

/** The client database, as far as the outbox uses it. */
export interface OutboxDatabase {
  outboxEntries(agent: string): Promise<string[]>;
  outboxWrite(write: ClientDbOutboxWrite, durable: boolean): Promise<void>;
}

/** Whether a client database can hold the outbox (test doubles and older
 *  workers may lack the outbox calls; those keep the localStorage queue). */
export function isOutboxDatabase(db: unknown): db is OutboxDatabase {
  return (
    typeof db === 'object' &&
    db !== null &&
    typeof (db as OutboxDatabase).outboxEntries === 'function' &&
    typeof (db as OutboxDatabase).outboxWrite === 'function'
  );
}

export interface OutboxEntry {
  subject: string;
  /** When this subject first became dirty since the last successful drain.
   *  Used for ordering and stale-entry detection. */
  enqueuedAt: number;
  /** Pre-signed genesis commit. Set by `newResource` when DID-deriving
   *  the subject from a sync sign. Drain POSTs this verbatim before
   *  attempting any incremental Loro-delta sign. Cleared on ack. */
  signedGenesis?: Commit;
  /** Pre-signed destroy commit. Set by `Resource.destroy()`; the resource
   *  is removed locally at once and the drain POSTs this verbatim. Cleared
   *  (with the whole entry) on ack. When `signedGenesis` is ALSO still
   *  pending the resource never reached the server, so the drain POSTs
   *  neither and just drops the entry. */
  signedDestroy?: Commit;
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
  /** The server's refusal code for `lastAttemptError`, when it sent one. */
  lastAttemptCode?: number;
  /** In-memory cause, retained on this entry even if a terminal failure drops
   * it from the queue. Explicit saves hold the entry across a drain. */
  lastAttemptFailure?: { cause: unknown };
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
  /** Set once a finished drive resync has re-armed this entry after the server
   *  refused it for a missing parent. One automatic re-arm per entry: if the
   *  resync did not deliver the parent, a second block is final until the next
   *  edit, instead of a retry round on every reconnect. Cleared with the block
   *  by a fresh edit. */
  rearmedAfterResync?: boolean;
  /** Epoch ms before which this entry must not be sent: the server refused
   *  it as BUSY (or rate limited it) and said when to come back. Not a
   *  failure: it is never counted in `failures` and never persisted. */
  busyUntil?: number;
}

/** After this long without a pace report the server hint is forgotten. */
export const PACE_QUIET_MS = 60_000;

/** Random extra wait added to a BUSY retry delay, as a fraction of it (capped
 *  at `BUSY_JITTER_MAX_MS`), so clients the server told the same thing do not
 *  return in one wave. */
const BUSY_JITTER_FRACTION = 0.25;
const BUSY_JITTER_MAX_MS = 1000;

/** Bound on remembered last-commit times. */
const LAST_COMMIT_MAX = 2048;

/** The wait a commit failure asks for ("busy, come back later"), if it is
 *  one. Such a failure is deferred, not counted: nothing was attempted. */
export function busyDelayMs(e: unknown): number | undefined {
  return e instanceof AtomicError ? e.retryAfterMs : undefined;
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

/** Consecutive failed drains of one entry before it counts as persistently
 *  failing and is reported once through `onRepeatedFailure`. Earlier than
 *  `BLOCK_AFTER_FAILURES`, which only applies to errors classed as blocking. */
export const REPORT_AFTER_FAILURES = 4;

/** How many subjects of one tier are drained at once when the caller
 *  supplies `tierOf`. Bounded so a reconnect with hundreds of dirty
 *  subjects does not open hundreds of concurrent COMMITs. */
export const DEFAULT_DRAIN_CONCURRENCY = 8;

export interface OutboxDrainContext {
  /** Drain ONE subject: POST signedGenesis if present, then export the
   *  Loro delta, sign one commit, POST, advance the export cursor.
   *  Throw to leave the entry dirty with `lastAttemptError` set. */
  drainSubject: (subject: string) => Promise<void>;
  /** Caller-supplied ordering (agents → drive → children). */
  sort: (entries: readonly OutboxEntry[]) => OutboxEntry[];
  /** Optional: the ordering tier an entry belongs to. Entries of one tier
   *  have no ordering dependency on each other (siblings under an
   *  already-synced parent), so the drain runs a tier's subjects
   *  concurrently — the COMMIT frames pipeline on the socket and the acks
   *  match by request id — and barriers between tiers, so a child's
   *  genesis never races ahead of its parent's. The tier keys of the sorted
   *  entries must be grouped (all of one tier adjacent). Without it every
   *  entry is its own tier: the sequential, one-round-trip-per-subject
   *  drain. */
  tierOf?: (entry: OutboxEntry) => string;
  /** Optional: how many subjects of one tier to drain at once. Defaults to
   *  `DEFAULT_DRAIN_CONCURRENCY`; only consulted when `tierOf` is given. */
  concurrency?: number;
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
  /** Fired once per failure streak, when an entry has failed
   *  `REPORT_AFTER_FAILURES` drains in a row, whatever the error. For
   *  reporting only: the entry keeps retrying as before. */
  onRepeatedFailure?: (entry: OutboxEntry, error: unknown) => void;
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
/**
 * Whether `subject` names a Commit. Re-exported from `commit.ts` so outbox
 * callers keep a stable import.
 */
export { isCommitSubject } from './commit.js';

/**
 * Codes this client acts on. `decodeError` (ws-v2.ts) cannot tell a pre-F5
 * server's `[requestId][message]` frame from a post-F5 `[requestId][code]
 * [message]` one: read under the new layout, the message's first two bytes
 * become an arbitrary nonzero `code`. Only members of this set are trusted;
 * anything else (including `UNKNOWN`) is read as text by
 * {@link legacyRefusalCode}. Mirrors `commit-refusals.json`.
 */
const KNOWN_ERROR_CODES: ReadonlySet<number> = new Set(
  Object.values(ErrorCode).filter(code => code !== ErrorCode.UNKNOWN),
);

/**
 * The ONLY place that reads a refusal's wording: for servers that predate the
 * code of a refusal, which sent `UNKNOWN` (or, for not-enrolled,
 * `SYNC_REJECTED`). A server that sends the code never reaches it. Mirrors
 * what the server's raise sites now set (`lib/src/sync/protocol.rs`).
 */
export function legacyRefusalCode(message: string): number {
  const has = (text: string) => message.includes(text);

  if (has('Commits cannot be edited')) return ErrorCode.IMMUTABLE_COMMIT;

  if (has('is_genesis: true, but the resource already exists')) {
    return ErrorCode.GENESIS_COLLISION;
  }

  if (has('missing. Is required in class')) {
    return ErrorCode.MISSING_REQUIRED_PROPERTY;
  }

  if (has("Commit's Loro update produced no state changes")) {
    return ErrorCode.CAUSALITY_CONFLICT;
  }

  if (has('parked as pending')) return ErrorCode.PENDING_DEPS;

  if (
    has('is not enrolled for sync on this node') ||
    has('has reached its storage quota on this node')
  ) {
    return ErrorCode.SYNC_REJECTED;
  }

  if (has('Incorrect signature for Commit') || has('No signature set')) {
    return ErrorCode.INVALID_SIGNATURE;
  }

  if (
    has('/properties/write right has been found') ||
    has('/properties/append right has been found')
  ) {
    return ErrorCode.UNAUTHORIZED_WRITE;
  }

  if (has('Failed getting class')) return ErrorCode.MISSING_CLASS;

  if (/Parent of .+ not found/.test(message)) return ErrorCode.MISSING_PARENT;

  if (
    has('was already applied here; refusing replay') ||
    has("predates the resource's genesis") ||
    has('is_genesis: false, but the resource does not exist yet') ||
    has('has no such resource to destroy')
  ) {
    return ErrorCode.DESTROY_SETTLED;
  }

  return ErrorCode.UNKNOWN;
}

/**
 * What a refusal is: the server's `code` when this client knows it, else the
 * wording read by {@link legacyRefusalCode}.
 */
export function refusalCode(message: string, code?: number): number {
  if (code === undefined || !KNOWN_ERROR_CODES.has(code)) {
    return legacyRefusalCode(message);
  }

  return code;
}

/** The write can never succeed, however often it is retried: drop it. A false
 *  positive silently discards a user write, so only codes that are certain. */
export function isTerminalCommitError(message: string, code?: number): boolean {
  switch (refusalCode(message, code)) {
    case ErrorCode.GENESIS_COLLISION:
    case ErrorCode.MISSING_REQUIRED_PROPERTY:
    case ErrorCode.IMMUTABLE_COMMIT:
      return true;
    default:
      return false;
  }
}

/**
 * Whether a terminal refusal is bookkeeping rather than a lost write, so the
 * drop is logged, not toasted: a redundant genesis (the resource exists) or a
 * write aimed at a Commit (whatever was signed, no edit could apply).
 */
export function isBenignTerminalCommitError(
  message: string,
  code?: number,
): boolean {
  const c = refusalCode(message, code);

  return c === ErrorCode.GENESIS_COLLISION || c === ErrorCode.IMMUTABLE_COMMIT;
}

/**
 * Retrying cannot succeed but the write is not necessarily lost: the entry is
 * parked (visible as "could not sync") until a fresh edit re-arms it.
 */
export function isUnrecoverableCommitError(
  message: string,
  code?: number,
): boolean {
  switch (refusalCode(message, code)) {
    case ErrorCode.UNAUTHORIZED_WRITE:
    case ErrorCode.MISSING_CLASS:
    case ErrorCode.SYNC_REJECTED:
    case ErrorCode.MISSING_PARENT:
    case ErrorCode.INVALID_SIGNATURE:
    case ErrorCode.CAUSALITY_CONFLICT:
      return true;
    default:
      return false;
  }
}

/** The delta depends on ops the server never got: the drain clears the save
 *  cursor so the next attempt sends a self-contained snapshot. */
export const isPendingDepsRefusal = (message: string, code?: number) =>
  refusalCode(message, code) === ErrorCode.PENDING_DEPS;

/** The node does not host the drive. It has no code of its own: it is a
 *  `SYNC_REJECTED` (quota is the other) told apart by its text, so a client
 *  that predates any change here reads it alike. */
export const isNotEnrolledRefusal = (
  message: string | undefined,
  code?: number,
) =>
  !!message?.includes('is not enrolled for sync on this node') &&
  refusalCode(message, code) === ErrorCode.SYNC_REJECTED;

/** Whether a thrown error is a not-enrolled refusal (reads its `code`). */
export const isNotEnrolledError = (error: unknown) =>
  isNotEnrolledRefusal(
    error instanceof Error ? error.message : String(error),
    error instanceof AtomicError ? error.code : undefined,
  );

/** The server does not hold the commit's parent. */
export const isMissingParentRefusal = (message: string, code?: number) =>
  refusalCode(message, code) === ErrorCode.MISSING_PARENT;

/** A destroy refusal that means the resource is already gone: an ack. */
export const isSettledDestroyRefusal = (message: string, code?: number) =>
  refusalCode(message, code) === ErrorCode.DESTROY_SETTLED;

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
  signedDestroy?: unknown;
  baseVersion?: string;
}

export class LocalOutbox {
  private entries = new Map<string, OutboxEntry>();
  private drainInFlight: Promise<void> | undefined;
  /** True while a follow-up drain pass is chained behind the in-flight one
   *  but hasn't started yet. At most one follow-up is queued at a time; it
   *  resets when the follow-up starts, so a still-later `drain()` call can
   *  chain the next one. See {@link drain}. */
  private drainFollowUpQueued = false;
  private onChange: () => void = () => undefined;
  private persistScheduled = false;
  /** localStorage key for the CURRENTLY-bound agent's queue. Switched by
   *  {@link rebind} on agent change. Starts anonymous until `setAgent`. */
  private activeKey: string = outboxKeyFor(undefined);
  /** The agent whose queue this is; `ANON_NAMESPACE` when signed out. Also
   *  the agent half of the database rows' keys. */
  private activeAgent: string = ANON_NAMESPACE;
  /** The client database holding the active agent's queue, once attached.
   *  Until then (and without one) the queue is kept in localStorage. */
  private database: OutboxDatabase | undefined;
  /** The database an {@link attachDatabase} call is loading from. */
  private attaching: OutboxDatabase | undefined;
  /** Bumped by {@link rebind}, so an attach that finishes after an identity
   *  change does not load one agent's rows into another's queue. */
  private bindGeneration = 0;
  /** Subjects mutated while {@link attachDatabase} was reading the rows. For
   *  those the in-memory state wins over what the database returned. */
  private touchedWhileAttaching: Set<string> | undefined;
  /** What the database holds per subject, as far as this tab knows: the
   *  serialized entry last written. A write sends only what differs. */
  private written = new Map<string, string>();
  /** The last database write, for {@link flush} to wait on. */
  private writeChain: Promise<void> = Promise.resolve();
  /** Whether the entries are complete: false from {@link expectDatabase}
   *  until the database's rows are merged or it is known not to come. */
  /** The server's latest write-load hint (`pace_ms`), see
   *  {@link setServerPace}. In ms; 0 = no pressure. */
  private serverPaceMs = 0;
  private paceReportedAt = 0;
  /** When each subject last had a commit acknowledged, for pacing. */
  private lastCommitAt = new Map<string, number>();
  /** Subjects with an explicit save running, with a count. */
  private explicit = new Map<string, number>();
  private _hydrated = true;
  private hydratedWaiters: Array<() => void> = [];
  /** Set by {@link expectDatabase}: after a {@link rebind}, the new agent's
   *  queue is incomplete until its database attaches too. */
  private databaseExpected = false;

  constructor(onChange?: () => void) {
    if (onChange) this.onChange = onChange;
    // One-shot: split the old shared queue into per-agent namespaces before
    // hydrating, so a later `rebind` finds each agent's migrated entries.
    this.migrateLegacyFlatKey();
    this.hydrate();

    // Best-effort: flush pending writes before the tab closes.
    if (typeof window !== 'undefined') {
      window.addEventListener('beforeunload', () => this.flushInBackground());
      window.addEventListener('pagehide', () => this.flushInBackground());
    }
  }

  /** Bind the outbox to `agentSubject`'s queue. Persists the current agent's
   *  entries under its own key, then loads the target agent's pending entries.
   *  Called from `Store.setAgent` on every identity change (sign-in, invite,
   *  dev-drive recovery, sign-out). Each agent's outbox is isolated. */
  rebind(agentSubject: string | undefined): void {
    const nextKey = outboxKeyFor(agentSubject);
    if (nextKey === this.activeKey) return;

    // Persist the outgoing agent's queue where it lives, then swap. The
    // database write is posted now, ahead of the flush that closes the
    // outgoing agent's worker.
    this.flushInBackground();
    this.entries.clear();
    this.written = new Map();
    this.database = undefined;
    this.attaching = undefined;
    this.touchedWhileAttaching = undefined;
    this.bindGeneration++;
    this.activeKey = nextKey;
    this.activeAgent = agentSubject ?? ANON_NAMESPACE;
    this.hydrate();

    if (this.databaseExpected) this.setHydrated(false);

    this.onChange();
  }

  /**
   * A client database is on its way (`Store.expectClientDb`). Until it is
   * attached, or known not to come, the queue may be missing entries that
   * only the database holds, so {@link hydrated} is false.
   */
  expectDatabase(): void {
    this.databaseExpected = true;
    if (!this.database) this.setHydrated(false);
  }

  /** No database will hold `agentSubject`'s queue this session: keep the
   *  localStorage queue and report the entries as complete. */
  databaseUnavailable(agentSubject: string | undefined): void {
    if ((agentSubject ?? ANON_NAMESPACE) !== this.activeAgent) return;
    if (this.database || this.attaching) return;

    this.setHydrated(true);
  }

  /**
   * Move `agentSubject`'s queue into `db`. Reads the rows the database
   * holds and merges them with the entries in memory, which include anything
   * localStorage held (hydrated at construction or {@link rebind}). Then it
   * writes the merged queue durably and only after that removes the
   * localStorage key, so a crash in between leaves both copies and the next
   * load merges them again rather than losing one. Resolves with the entries
   * the database added. A no-op for another agent or an already bound db.
   */
  async attachDatabase(
    agentSubject: string | undefined,
    db: OutboxDatabase,
  ): Promise<OutboxEntry[]> {
    const agent = agentSubject ?? ANON_NAMESPACE;

    if (agent !== this.activeAgent) return [];
    if (this.database === db || this.attaching === db) return [];

    const generation = this.bindGeneration;
    this.attaching = db;
    this.touchedWhileAttaching = new Set();

    let rows: string[];

    try {
      rows = await db.outboxEntries(agent);
    } catch (e) {
      console.warn('[Outbox] reading the queue from the database failed:', e);

      if (generation === this.bindGeneration && this.attaching === db) {
        this.attaching = undefined;
        this.touchedWhileAttaching = undefined;
        this.setHydrated(true);
      }

      return [];
    }

    if (generation !== this.bindGeneration || this.attaching !== db) return [];

    const touched = this.touchedWhileAttaching;
    const added: OutboxEntry[] = [];
    const written = new Map<string, string>();

    for (const raw of rows) {
      let stored: OutboxEntry | undefined;

      try {
        stored = parseEntry(JSON.parse(raw));
      } catch {
        stored = undefined;
      }

      if (!stored) continue;
      written.set(stored.subject, raw);
      if (touched.has(stored.subject)) continue;

      const live = this.entries.get(stored.subject);

      if (live) {
        live.enqueuedAt = Math.min(live.enqueuedAt, stored.enqueuedAt);
        live.signedGenesis ??= stored.signedGenesis;
        live.signedDestroy ??= stored.signedDestroy;
        live.baseVersion ??= stored.baseVersion;
      } else {
        this.entries.set(stored.subject, stored);
        added.push(stored);
      }
    }

    this.written = written;
    this.database = db;
    this.attaching = undefined;
    this.touchedWhileAttaching = undefined;

    // Import: whatever only memory (and so localStorage) held goes into the
    // database now, durably, before the localStorage copy is dropped.
    const legacy = readLocalStorage(this.activeKey) !== null;

    try {
      await this.persistToDatabase(true);

      if (legacy && generation === this.bindGeneration) {
        removeLocalStorage(this.activeKey);
      }
    } catch (e) {
      console.warn('[Outbox] importing the queue into the database failed:', e);
    }

    if (generation === this.bindGeneration) {
      this.setHydrated(true);
      this.onChange();
    }

    return added;
  }

  /** Whether `db` is the database the queue is stored in. */
  isStoredIn(db: unknown): boolean {
    return !!db && this.database === db;
  }

  /** Whether the entries are complete; see {@link expectDatabase}. */
  get hydrated(): boolean {
    return this._hydrated;
  }

  /** Resolves once {@link hydrated}. */
  whenHydrated(): Promise<void> {
    if (this._hydrated) return Promise.resolve();

    return new Promise(resolve => this.hydratedWaiters.push(resolve));
  }

  /** {@link hasPending}, but also true while the entries are incomplete: for
   *  decisions that would destroy an unsynced local edit if they guessed
   *  wrong (replacing a doc with the server's copy). */
  mayHavePending(subject: string): boolean {
    return !this._hydrated || this.entries.has(subject);
  }

  private setHydrated(hydrated: boolean): void {
    const was = this._hydrated;
    this._hydrated = hydrated;
    if (!hydrated) return;

    const waiters = this.hydratedWaiters;
    this.hydratedWaiters = [];
    for (const resolve of waiters) resolve();

    // What waited to know whether an entry exists can go on.
    if (!was) this.onChange();
  }

  /** Record a mutation of `subject`'s entry: persist it and tell the store. */
  private changed(subject: string): void {
    this.touchedWhileAttaching?.add(subject);
    this.schedulePersist();
    this.onChange();
  }

  /**
   * Queue an offline save of `subject` together with its snapshot. `persist`
   * writes the snapshot and gets the outbox row to write with it, when the
   * queue lives in the same database; it resolves `true` if it wrote that
   * row. Only then does the entry change in memory, so `pendingDirtyCount`
   * rising still means the edit is durable, and a reload finds the snapshot
   * and its entry together.
   *
   * `baseVersion` is the last-synced save cursor (see
   * {@link OutboxEntry.baseVersion}); `dirty` marks the subject for the drain.
   */
  async recordOfflineSave(
    subject: string,
    opts: { baseVersion?: string; dirty: boolean },
    persist: (outbox: ClientDbOutboxWrite | undefined) => Promise<boolean>,
  ): Promise<void> {
    const existing = this.entries.get(subject);
    const willExist =
      !isCommitSubject(subject) &&
      (!!existing || opts.dirty || opts.baseVersion !== undefined);
    const staged: OutboxEntry | undefined = willExist
      ? {
          ...(existing ?? { subject, enqueuedAt: Date.now() }),
          baseVersion: existing?.baseVersion ?? opts.baseVersion,
        }
      : undefined;
    const db = this.database;
    const value = staged ? serializeEntry(staged) : undefined;
    const write =
      db && value !== undefined
        ? { agent: this.activeAgent, puts: [{ subject, value }], deletes: [] }
        : undefined;

    const wrote = await persist(write);

    // Apply through the public mutators, so a wrapped `markDirty` (the AI
    // review hold) still decides whether the subject is queued.
    if (
      staged &&
      !this.entries.has(subject) &&
      opts.baseVersion !== undefined
    ) {
      this.entries.set(subject, { subject, enqueuedAt: staged.enqueuedAt });
    }

    if (opts.baseVersion !== undefined) {
      this.setBaseVersion(subject, opts.baseVersion);
    }

    if (opts.dirty) this.markDirty(subject);

    if (wrote && value !== undefined && this.database === db) {
      this.written.set(subject, value);
    }
  }

  /** Mark a subject as having local Loro edits that need to drain.
   *  Idempotent; called once per Loro local-updates fire. */
  markDirty(subject: string): void {
    if (isCommitSubject(subject)) return;

    const existing = this.entries.get(subject);

    if (existing) {
      // Already dirty; bump enqueuedAt only if it was never set (recovery).
      // A fresh edit re-arms a blocked entry: clear the block and the failure
      // streak so the next drain re-attempts (rights may now be granted).
      if (existing.blocked) {
        existing.blocked = false;
        existing.failures = 0;
        existing.rearmedAfterResync = false;
      }

      this.changed(subject);

      return;
    }

    this.entries.set(subject, {
      subject,
      enqueuedAt: Date.now(),
    });
    this.changed(subject);
  }

  /**
   * Re-arm the entries parked because the server lacked their parent, for the
   * subjects `inDrive` accepts. A drive resync is what delivers a parent the
   * server never received (a drive root, after switching a drive to a node),
   * so once one has finished the same commit can succeed. Each entry is
   * re-armed once: a resync that did not deliver the parent leaves it parked
   * until the next edit. Returns how many entries were re-armed.
   */
  rearmParentBlocked(inDrive: (subject: string) => boolean): number {
    let rearmed = 0;

    for (const entry of this.entries.values()) {
      if (
        !entry.blocked ||
        entry.rearmedAfterResync ||
        !isMissingParentRefusal(
          entry.lastAttemptError ?? '',
          entry.lastAttemptCode,
        ) ||
        !inDrive(entry.subject)
      ) {
        continue;
      }

      entry.blocked = false;
      entry.failures = 0;
      entry.rearmedAfterResync = true;
      rearmed++;
      this.changed(entry.subject);
    }

    return rearmed;
  }

  /** Clear the dirty bit for a subject. Called by the drain after the
   *  Loro delta has been signed + POSTed + acked. If a `signedGenesis`
   *  or `signedDestroy` is still pending, the entry stays (use
   *  `clearGenesis` / `clearDestroy` to also remove that). */
  clearDirty(subject: string): void {
    const entry = this.entries.get(subject);
    if (!entry) return;

    if (entry.signedGenesis || entry.signedDestroy) {
      // Still holding a signed envelope — keep the entry but treat
      // it as "no incremental delta dirty"; the next drain will POST
      // the envelope and recheck.
      this.changed(subject);

      return;
    }

    this.entries.delete(subject);
    this.changed(subject);
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
    this.changed(subject);
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
    this.changed(subject);
  }

  /** Stash a pre-signed destroy commit for `subject`. Called by
   *  `Resource.destroy()` once the envelope is signed; the drain POSTs it
   *  verbatim. Any offline `baseVersion` is dropped — there is no Loro
   *  delta left to replay for a subject that is going away. Re-arms a
   *  blocked entry: the delete is a fresh user intent worth attempting. */
  setDestroyCommit(subject: string, commit: Commit): void {
    const entry: OutboxEntry = this.entries.get(subject) ?? {
      subject,
      enqueuedAt: Date.now(),
    };
    entry.signedDestroy = commit;
    entry.baseVersion = undefined;

    if (entry.blocked) {
      entry.blocked = false;
      entry.failures = 0;
    }

    this.entries.set(subject, entry);
    this.changed(subject);
  }

  /** Drop the entry once the destroy has been acked (or found to be moot).
   *  Unlike `clearGenesis` this removes the WHOLE entry: a destroyed
   *  subject has no dirty Loro ops or unposted genesis left worth
   *  syncing. No-op when the entry holds no `signedDestroy`. */
  clearDestroy(subject: string): void {
    const entry = this.entries.get(subject);
    if (!entry || !entry.signedDestroy) return;

    this.entries.delete(subject);
    this.changed(subject);
  }

  /** Forget every queued write for `subject` without POSTing anything.
   *  For a resource that never reached the server (still `new`) and is
   *  being discarded: an unposted genesis or stray dirty bit would
   *  otherwise recreate it on the next drain. */
  discard(subject: string): void {
    if (!this.entries.delete(subject)) return;

    this.changed(subject);
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
      this.changed(subject);
    }
  }

  /** Drop the offline base version once its delta has been synced. */
  clearBaseVersion(subject: string): void {
    const entry = this.entries.get(subject);
    if (!entry || entry.baseVersion === undefined) return;

    entry.baseVersion = undefined;
    this.changed(subject);
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

    const now = Date.now();

    for (const e of this.entries.values()) {
      // Blocked entries never become due on their own — they wait for a fresh
      // `markDirty`. Excluding them lets `nextDueAt` return undefined when
      // nothing is drainable, so the scheduler doesn't arm a no-op timer.
      if (e.blocked) continue;

      const due = this.dueAtOf(e, now);

      if (soonest === undefined || due < soonest) {
        soonest = due;
      }
    }

    return soonest;
  }

  /** Epoch ms from which `e` may be sent: the latest of its failure backoff,
   *  its BUSY wait and the server's commit pacing. 0 when due now. */
  private dueAtOf(e: OutboxEntry, now: number): number {
    const backoff =
      e.failures && e.lastAttemptAt !== undefined
        ? e.lastAttemptAt + drainBackoffMs(e.failures)
        : 0;

    return Math.max(backoff, e.busyUntil ?? 0, this.paceDueAt(e, now));
  }

  /** Report the `pace_ms` the server sent with a `COMMIT_OK` (or the
   *  `X-Atomic-Pace-Ms` header): the least time to leave between commits of
   *  one resource. A higher hint takes effect at once; a lower one (0 when
   *  the load is gone) only halves the current pace per report, so the
   *  interval relaxes smoothly instead of snapping back into a herd. */
  setServerPace(ms: number, now: number = Date.now()): void {
    if (!Number.isFinite(ms) || ms < 0) return;

    this.serverPaceMs =
      ms >= this.serverPaceMs
        ? ms
        : Math.max(ms, Math.floor(this.serverPaceMs / 2));
    this.paceReportedAt = now;
  }

  /** The commit interval the server currently asks for, in ms. Forgotten
   *  after {@link PACE_QUIET_MS} without a report. */
  paceMs(now: number = Date.now()): number {
    return now - this.paceReportedAt > PACE_QUIET_MS ? 0 : this.serverPaceMs;
  }

  /** Exempt `subject` from the soft pace while an explicit (non-background)
   *  save of it runs. BUSY waits still apply. Returns the release function. */
  holdExplicit(subject: string): () => void {
    this.explicit.set(subject, (this.explicit.get(subject) ?? 0) + 1);
    let released = false;

    return () => {
      if (released) return;
      released = true;
      const left = (this.explicit.get(subject) ?? 1) - 1;

      if (left > 0) this.explicit.set(subject, left);
      else this.explicit.delete(subject);
    };
  }

  /** Record that a commit of `subject` was acknowledged, which starts its
   *  pacing interval. */
  noteCommitted(subject: string, now: number = Date.now()): void {
    this.lastCommitAt.delete(subject);
    this.lastCommitAt.set(subject, now);

    // Oldest first (Map keeps insertion order): drop what pacing no longer
    // needs, and bound the map regardless.
    for (const [key, at] of this.lastCommitAt) {
      if (
        this.lastCommitAt.size <= LAST_COMMIT_MAX &&
        now - at <= PACE_QUIET_MS
      ) {
        break;
      }

      this.lastCommitAt.delete(key);
    }
  }

  /** When pacing lets `e` go out again. Creations and deletions are not
   *  stretched: callers wait on them, and they carry no accumulated edits. */
  private paceDueAt(e: OutboxEntry, now: number): number {
    if (e.signedGenesis || e.signedDestroy) return 0;
    // An explicit save is in progress for it: the user is waiting.
    if (this.explicit.has(e.subject)) return 0;

    const pace = this.paceMs(now);
    const last = this.lastCommitAt.get(e.subject);

    return pace > 0 && last !== undefined ? last + pace : 0;
  }

  /** True while a drain is in flight. Mirrors `drainInFlight` for
   * external read access (status displays). */
  get isDraining(): boolean {
    return this.drainInFlight !== undefined;
  }

  /**
   * Idempotent drain. A pass iterates a snapshot of the entries taken when
   * IT started — entries dirtied after that snapshot are invisible to it.
   * So when a call arrives while a pass is in flight, just returning the
   * in-flight promise would resolve the caller's await while its subject is
   * still dirty and un-POSTed: `Resource.save()` (markDirty → await drain)
   * would report `'persisted'` for a write the server never received —
   * silent data loss from the caller's perspective (see
   * `planning/completed/outbox-drain-data-loss-race.md`). Instead, chain ONE
   * follow-up pass that takes a fresh snapshot after the current pass
   * ends; the promise returned to late callers resolves only after that
   * follow-up, guaranteeing their at-call-time dirty entries were
   * attempted.
   */
  async drain(ctx: OutboxDrainContext): Promise<void> {
    if (this.drainInFlight) {
      if (!this.drainFollowUpQueued) {
        this.drainFollowUpQueued = true;
        this.trackDrain(
          this.drainInFlight
            .catch(() => undefined)
            .then(() => {
              // Reset BEFORE the pass runs: a `drain()` arriving during the
              // follow-up itself missed its snapshot too and must be able to
              // chain the next follow-up.
              this.drainFollowUpQueued = false;

              return this.doDrain(ctx);
            }),
        );
      }

      return this.drainInFlight;
    }

    this.trackDrain(this.doDrain(ctx));

    return this.drainInFlight;
  }

  /** Point `drainInFlight` at `pass`, clearing it on settle — but only if a
   *  later follow-up hasn't replaced it (owner check). */
  private trackDrain(pass: Promise<void>): void {
    const tracked = pass.finally(() => {
      if (this.drainInFlight === tracked) this.drainInFlight = undefined;
    });
    this.drainInFlight = tracked;
  }

  private async doDrain(ctx: OutboxDrainContext): Promise<void> {
    if (this.entries.size === 0) return;

    // Snapshot subjects at start. Newly-dirtied subjects mid-drain
    // get picked up by the next drain trigger (microtask onChange).
    const sorted = ctx.sort([...this.entries.values()]);

    for (const tier of groupTiers(sorted, ctx.tierOf)) {
      await runBounded(
        tier,
        ctx.tierOf ? (ctx.concurrency ?? DEFAULT_DRAIN_CONCURRENCY) : 1,
        entry => this.drainOne(entry, ctx),
      );
    }
  }

  /** Attempt one entry: skip it if blocked or backing off, otherwise run
   *  `ctx.drainSubject` and record the outcome on the entry. Never throws. */
  private async drainOne(
    entry: OutboxEntry,
    ctx: OutboxDrainContext,
  ): Promise<void> {
    {
      const live = this.entries.get(entry.subject);
      if (!live) return;

      // Blocked: an unrecoverable failure (e.g. 401) parked this entry. It
      // waits for a fresh `markDirty` to re-arm — never retried on its own.
      if (live.blocked) return;

      // Not due yet: still inside its post-failure backoff, a BUSY wait, or
      // the commit pace since this subject's last commit. The next drain
      // (scheduled at `nextDueAt`) picks it up; edits keep accumulating in
      // the Loro doc and go out as one merged delta.
      const now = Date.now();

      if (now < this.dueAtOf(live, now)) return;

      live.busyUntil = undefined;
      live.lastAttemptAt = now;

      try {
        await ctx.drainSubject(live.subject);
        live.lastAttemptFailure = undefined;
        live.lastAttemptError = undefined;
        live.lastAttemptCode = undefined;
        // Success — clear the failure counter. The entry itself is usually
        // already removed by `drainSubject`; this handles the genesis-acked-
        // but-still-dirty leftover case.
        const stillLive = this.entries.get(entry.subject);
        if (stillLive) stillLive.failures = 0;
      } catch (e) {
        // "Busy, come back in N ms": the server did not look at the commit.
        // Wait, keep every edit queued, and do not count a failure or
        // report it. The node is overloaded, so also slow the other
        // subjects down to at least that interval.
        const busyMs = busyDelayMs(e);

        if (busyMs !== undefined) {
          const jitter =
            Math.random() *
            Math.min(BUSY_JITTER_MAX_MS, busyMs * BUSY_JITTER_FRACTION);
          live.busyUntil = Date.now() + busyMs + jitter;
          this.setServerPace(busyMs);
          this.changed(entry.subject);

          return;
        }

        live.lastAttemptFailure = { cause: e };
        // Explicit disconnect cancels the attempt, not the durable write.
        // Keep it queued for reconnect without escalating retry failures.
        if (e instanceof RequestCancelledError) return;
        live.lastAttemptError = e instanceof Error ? e.message : String(e);
        live.lastAttemptCode = e instanceof AtomicError ? e.code : undefined;
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

          if (live.failures === REPORT_AFTER_FAILURES) {
            ctx.onRepeatedFailure?.(live, e);
          }

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

      this.changed(entry.subject);
    }
  }

  /**
   * Coalesce multiple mutations into one write per microtask. The
   * microtask flush keeps durability semantics in practice (any await
   * yields to the microtask queue and persists) without the per-call CPU
   * spike.
   */
  private schedulePersist(): void {
    if (this.persistScheduled) return;
    this.persistScheduled = true;
    queueMicrotask(() => {
      this.persistScheduled = false;
      void this.persist(false).catch(() => undefined);
    });
  }

  /** Write the current state to wherever the queue lives. */
  private persist(durable: boolean): Promise<void> {
    this.persistScheduled = false;

    if (this.database) return this.persistToDatabase(durable);

    this.persistToLocalStorage();

    return Promise.resolve();
  }

  /**
   * Send the rows that differ from what the database holds: changed entries
   * as puts, dropped ones as deletes. Durable when asked, or when a row
   * carries something a reload cannot rebuild from the snapshot: a signed
   * genesis or destroy, or an offline cursor. A plain dirty bit rides the
   * worker's periodic flush.
   */
  private persistToDatabase(durable: boolean): Promise<void> {
    const db = this.database;
    if (!db) return Promise.resolve();

    const agent = this.activeAgent;
    const puts: ClientDbOutboxWrite['puts'] = [];
    const deletes: string[] = [];

    for (const entry of this.entries.values()) {
      const value = serializeEntry(entry);
      if (this.written.get(entry.subject) === value) continue;

      puts.push({ subject: entry.subject, value });
      durable ||=
        !!entry.signedGenesis ||
        !!entry.signedDestroy ||
        entry.baseVersion !== undefined;
    }

    for (const subject of this.written.keys()) {
      if (!this.entries.has(subject)) deletes.push(subject);
    }

    if (puts.length === 0 && deletes.length === 0) {
      if (!durable) return this.writeChain;

      // Nothing new, but the caller wants what was written made durable.
      const flushed = this.writeChain.then(() =>
        db.outboxWrite({ agent, puts, deletes }, true),
      );
      this.writeChain = flushed.catch(() => undefined);

      return flushed;
    }

    for (const { subject, value } of puts) this.written.set(subject, value);
    for (const subject of deletes) this.written.delete(subject);

    const write = db.outboxWrite({ agent, puts, deletes }, durable).catch(e => {
      console.warn('[Outbox] persist failed:', e);

      // Unknown what landed: forget it, so the next write repeats these
      // rows (and the deletes) instead of assuming they are stored.
      if (this.database === db) {
        for (const { subject } of puts) this.written.delete(subject);
        for (const subject of deletes) this.written.set(subject, '');
      }

      throw e;
    });
    this.writeChain = write.catch(() => undefined);

    return write;
  }

  /** Synchronously write the whole queue to its localStorage key. */
  private persistToLocalStorage(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      if (this.entries.size === 0) {
        localStorage.removeItem(this.activeKey);

        return;
      }

      const out = [...this.entries.values()].map(toPersisted);
      localStorage.setItem(this.activeKey, JSON.stringify(out));
    } catch (e) {
      console.warn('[Outbox] persist failed:', e);
    }
  }

  /**
   * Write the current state now. With a database, resolves once the rows
   * are durable (rejects if they could not be written); in localStorage the
   * write is synchronous.
   */
  public flush(): Promise<void> {
    return this.persist(true);
  }

  /** {@link flush} without waiting; a failure is already logged. */
  private flushInBackground(): void {
    this.flush().catch(() => undefined);
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
      this.persistToLocalStorage();
    } catch (e) {
      console.warn('[Outbox] legacy migration failed:', e);
    }
  }

  private hydrateEntry(p: unknown): void {
    const entry = parseEntry(p);
    if (entry) this.entries.set(entry.subject, entry);
  }
}

/** The stored form of an entry: the fields a reload needs. Failure counts
 *  and backoff are per session. */
function toPersisted(e: OutboxEntry): PersistedEntry {
  return {
    subject: e.subject,
    enqueuedAt: e.enqueuedAt,
    signedGenesis: e.signedGenesis
      ? commitToJsonADObject(e.signedGenesis)
      : undefined,
    signedDestroy: e.signedDestroy
      ? commitToJsonADObject(e.signedDestroy)
      : undefined,
    baseVersion: e.baseVersion,
  };
}

/** One database row: the same shape as an element of the localStorage blob,
 *  so both parse with {@link parseEntry}. */
function serializeEntry(e: OutboxEntry): string {
  return JSON.stringify(toPersisted(e));
}

/** An entry from its stored form; `undefined` for garbage. */
function parseEntry(p: unknown): OutboxEntry | undefined {
  if (typeof p !== 'object' || p === null) return undefined;
  const obj = p as Record<string, unknown>;
  if (typeof obj.subject !== 'string') return undefined;
  // Queued by an older build that let commit pages mark themselves dirty.
  if (isCommitSubject(obj.subject)) return undefined;

  let signedGenesis: Commit | undefined;

  if (obj.signedGenesis) {
    try {
      signedGenesis = parseCommitJSON(JSON.stringify(obj.signedGenesis));
    } catch {
      // skip — entry stays dirty without a pre-signed genesis,
      // which means the drain will try to sign a fresh delta.
    }
  }

  let signedDestroy: Commit | undefined;

  if (obj.signedDestroy) {
    try {
      signedDestroy = parseCommitJSON(JSON.stringify(obj.signedDestroy));
    } catch {
      // skip — an unparseable destroy envelope can't be re-signed (the
      // resource is already gone locally), so the delete is lost; the
      // entry stays dirty-only and the drain clears it as a no-op.
    }
  }

  // Backcompat: old persisted entries had `commits: Commit[]`. We
  // no longer store signed envelopes here (the Loro state is the
  // source of truth), so the array is discarded — the next drain
  // re-signs from Loro. Empty commits arrays from clean shutdowns
  // are also discarded silently.
  const enqueuedAt =
    typeof obj.enqueuedAt === 'number' ? obj.enqueuedAt : Date.now();

  return {
    subject: obj.subject,
    enqueuedAt,
    signedGenesis,
    signedDestroy,
    baseVersion:
      typeof obj.baseVersion === 'string' ? obj.baseVersion : undefined,
  };
}

function readLocalStorage(key: string): string | null {
  if (typeof localStorage === 'undefined') return null;

  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function removeLocalStorage(key: string): void {
  if (typeof localStorage === 'undefined') return;

  try {
    localStorage.removeItem(key);
  } catch {
    // Private mode or blocked storage: nothing was stored there either.
  }
}

/** Split sorted entries into runs of equal `tierOf` key. Without `tierOf`
 *  every entry is its own run, which keeps the drain strictly sequential. */
export function groupTiers(
  sorted: readonly OutboxEntry[],
  tierOf?: (entry: OutboxEntry) => string,
): OutboxEntry[][] {
  if (!tierOf) return sorted.map(e => [e]);

  const tiers: OutboxEntry[][] = [];
  let currentKey: string | undefined;

  for (const entry of sorted) {
    const key = tierOf(entry);

    if (tiers.length === 0 || key !== currentKey) {
      tiers.push([entry]);
      currentKey = key;
    } else {
      tiers[tiers.length - 1].push(entry);
    }
  }

  return tiers;
}

/** Run `task` over `items` with at most `limit` in flight, in order of
 *  start. Resolves once every task settled; tasks are expected not to throw
 *  (`drainOne` records failures on the entry instead). */
export async function runBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;

  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];

      try {
        await task(item);
      } catch {
        // `task` handles its own failures; a throw here would only strand
        // the remaining items of the tier.
      }
    }
  };

  await Promise.all(Array.from({ length: width }, worker));
}

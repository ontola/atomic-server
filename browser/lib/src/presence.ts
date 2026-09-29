import type { EphemeralStore } from 'loro-crdt';
import { LoroLoader } from './loro-loader.js';
import type { Store } from './store.js';

/** What a session announces about itself on a drive's presence channel. */
export interface PresenceEntry<T = unknown> {
  /** Subject of the agent behind this session. */
  agent: string;
  /** Subject of the resource the session is currently viewing. */
  resource?: string;
  /** Subject of the agent this session is following (follow mode). */
  following?: string;
  /** Subject of the ChatRoom logging this agent's follow session, when
   *  they're being followed. Followers use it to open the session chat. */
  session?: string;
  /** When `false`, other sessions should not follow this one's agent.
   *  Absent means followable. */
  allowFollow?: boolean;
  /** View-specific payload (e.g. canvas XY, table cell, document cursor). */
  data?: T;
  /** Subject of the comment thread / chatroom this session is currently
   *  composing a message in, if any. Consumers show a "typing…" hint to the
   *  other sessions keyed on the same subject. Cleared when the composer goes
   *  idle, blurs, sends, or unmounts. Its own dedicated field (not `data`) so
   *  it never clobbers a view's cursor payload. */
  typing?: string;
  /** Milliseconds since epoch of this entry's last local write. Lets
   *  consumers prefer an agent's freshest session when several linger
   *  (e.g. a stale pre-reload session that hasn't hit its TTL yet). */
  updatedAt?: number;
}

/** A remote session's presence, as exposed to consumers. */
export interface PresenceItem<T = unknown> extends PresenceEntry<T> {
  /** Unique id of the browsing session (tab). One agent can have many. */
  sessionId: string;
}

/** Keys expire on all peers when not refreshed within this window. */
const PRESENCE_TTL_MS = 30_000;
/** Re-set the local entry well inside the TTL so it never expires while
 *  the tab is alive. */
const HEARTBEAT_MS = 10_000;

/**
 * Copy an announcement, refusing anything Loro cannot store.
 *
 * Handing the ephemeral store a value it cannot convert does not come back as
 * an error: `LoroValue`'s conversion *panics*, which in a browser surfaces as
 * a bare `RuntimeError: unreachable` and leaves the wasm module unusable
 * afterwards. Functions, bigints, symbols and a getter that throws all do it,
 * and a cyclic object corrupts the wasm heap instead. Since an entry is
 * retained and re-sent by the heartbeat, one such write becomes an unhandled
 * error every {@link HEARTBEAT_MS} for as long as the tab stays open. That is
 * what a whole family of `RuntimeError: unreachable` reports turned out to be,
 * all of them from `setInterval`, none naming a cause.
 *
 * `data` is the reason this can happen at all: it is the view's own payload
 * and typed as whatever the view likes, so nothing stops a callback or a class
 * instance travelling in it. Checking here, before the value reaches wasm,
 * keeps the failure a named field in the console instead of a poisoned tab.
 *
 * `undefined` passes through, since Loro accepts it and the entry type uses it
 * to mean "unset".
 */
const plainCopy = (value: unknown, path: string): unknown => {
  if (value === null || value === undefined) {
    return value;
  }

  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
      return value;
    case 'object':
      break;
    default:
      throw new Error(`${path} is a ${typeof value}`);
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => plainCopy(item, `${path}[${index}]`));
  }

  const copy: Record<string, unknown> = {};

  // Reading the properties here is deliberate: a getter that throws should
  // throw on this side of the boundary, where it is catchable.
  for (const [key, item] of Object.entries(value as object)) {
    copy[key] = plainCopy(item, `${path}.${key}`);
  }

  return copy;
};

/**
 * Ephemeral "who is where" state for one drive (issue #1229).
 *
 * Wraps a Loro {@link EphemeralStore} in which every participating session
 * writes exactly one key — its own `sessionId` — holding a
 * {@link PresenceEntry}. Updates travel as opaque bytes through the
 * `PRESENCE_*` websocket frames; the server relays them per drive and
 * replays each connection's latest payload to late joiners. Loro's
 * per-key LWW timestamps make replays and reordering harmless, and its
 * TTL cleanup removes sessions that stop heartbeating (closed tab,
 * dropped connection) without any explicit leave message.
 *
 * Loro WASM loads lazily ({@link LoroLoader}); until it's ready, local
 * state and remote bytes are buffered and applied on init.
 *
 * Obtain instances via `store.getPresence(drive)` — the store keeps one
 * manager per drive and drops it when its last subscriber leaves.
 */
export class DrivePresenceManager {
  public readonly sessionId: string;

  private ephemeral?: EphemeralStore;
  /** Remote payloads received before the WASM module finished loading. */
  private pendingRemote: Uint8Array[] = [];
  /** Injected synthetic entries buffered until the WASM module loads. */
  private pendingInjected = new Map<string, PresenceEntry>();
  private local?: PresenceEntry;
  private listeners = new Set<() => void>();
  private snapshot: PresenceItem[] = [];
  private unsubTransport?: () => void;
  private unsubLoroReady?: () => void;
  private heartbeat?: ReturnType<typeof setInterval>;

  public constructor(
    private store: Store,
    private drive: string,
  ) {
    this.sessionId = crypto.randomUUID();
  }

  /**
   * Register a change listener (React: `useSyncExternalStore`). The first
   * subscriber opens the websocket subscription; when the last one leaves
   * the manager shuts down (transport + heartbeat), but stays registered
   * in the store: consumers memoize the instance across renders, and a
   * manager that replaced itself would leave them patching a dead object.
   */
  public subscribe(callback: () => void): () => void {
    if (this.listeners.size === 0) {
      this.start();
    }

    this.listeners.add(callback);

    return () => {
      this.listeners.delete(callback);

      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  }

  /** Current presence of all sessions on the drive, including our own.
   *  Stable reference between changes (safe for `useSyncExternalStore`). */
  public getSnapshot(): PresenceItem[] {
    return this.snapshot;
  }

  /**
   * Announce (or update) this session's presence. Pass `undefined` to go
   * invisible (e.g. on sign-out). No-op broadcast-wise until the store's
   * agent is known — anonymous sessions don't announce.
   */
  public setLocal(entry: Omit<PresenceEntry, 'agent'> | undefined): void {
    const agent = this.store.getAgent()?.subject;

    if (!entry || !agent) {
      this.local = undefined;
      this.onEphemeral('clearing the local entry', e =>
        e.delete(this.sessionId),
      );

      return;
    }

    const next = this.storable({ ...entry, agent, updatedAt: Date.now() });

    if (!next) {
      return;
    }

    this.local = next;
    this.writeLocal();
  }

  /**
   * Merge fields into this session's presence entry. Different features
   * own different fields (the resource announcement, follow mode, view
   * payloads) — patching lets them write concurrently without wiping each
   * other. Set a field to `undefined` to clear it.
   */
  public patchLocal(patch: Partial<Omit<PresenceEntry, 'agent'>>): void {
    const agent = this.store.getAgent()?.subject;

    if (!agent) {
      return;
    }

    const next = this.storable({
      ...this.local,
      ...patch,
      agent,
      updatedAt: Date.now(),
    });

    if (!next) {
      return;
    }

    this.local = next;
    this.writeLocal();
  }

  /**
   * The entry as Loro can hold it, or `undefined` when it cannot hold it at
   * all. A refused announcement leaves the last good one in place: the tab
   * keeps its presence and the heartbeat keeps working, which is the point of
   * refusing rather than storing and finding out ten seconds later.
   */
  private storable(entry: PresenceEntry): PresenceEntry | undefined {
    try {
      return plainCopy(entry, 'presence') as PresenceEntry;
    } catch (e) {
      console.error(
        '[Presence] ignoring an announcement Loro cannot store:',
        e instanceof Error ? e.message : e,
      );

      return undefined;
    }
  }

  /**
   * Write a synthetic remote session into the drive's presence store —
   * the seam for scripted "teammates" (demo workspace, tests). The
   * entry renders exactly like a real remote session: any key that is
   * not our own `sessionId` is a peer. Subject to the normal TTL —
   * refresh within 30s or the session reads as departed (which a
   * scripted leave can also do explicitly via {@link removeEntry}).
   *
   * On a local-only drive the write stays in this tab (the store's
   * transport guard drops the broadcast). On a synced drive it WOULD
   * go out over the websocket like any local write — injectors should
   * stick to local-only drives.
   */
  public injectEntry(sessionId: string, entry: PresenceEntry): void {
    const stamped = this.storable({ ...entry, updatedAt: Date.now() });

    if (!stamped) {
      return;
    }

    if (this.ephemeral) {
      this.onEphemeral('injecting an entry', e =>
        e.set(sessionId, stamped as never),
      );
    } else {
      this.pendingInjected.set(sessionId, stamped);
    }
  }

  /** Remove a synthetic session immediately — an explicit "leave",
   *  faster than waiting out the TTL. */
  public removeEntry(sessionId: string): void {
    if (this.ephemeral) {
      this.onEphemeral('removing an entry', e => e.delete(sessionId));
    } else {
      this.pendingInjected.delete(sessionId);
    }
  }

  /** Re-send the local entry, bumping its LWW timestamp. Called by the
   *  heartbeat and after websocket reconnects (the server's per-connection
   *  cache starts empty on a fresh connection). */
  public rebroadcast(): void {
    if (!this.local) {
      return;
    }

    const local = this.local;

    this.onEphemeral('broadcast', ephemeral => {
      // Bump our entry's LWW timestamp so peers' TTL cleanup keeps it alive…
      ephemeral.set(this.sessionId, local as never);
      // …and put the encoded entry on the wire ourselves. Relying on
      // `subscribeLocalUpdates` alone is fragile here: a value-identical
      // `set` may not emit one, and the very first broadcast can be dropped
      // while the websocket is still authenticating — this direct send makes
      // the heartbeat self-healing (it also repopulates the server's
      // per-connection cache for late-joiner replay).
      this.store.broadcastPresenceUpdate(
        this.drive,
        ephemeral.encode(this.sessionId),
      );
    });
  }

  /** Write the current local entry, if the store is up. */
  private writeLocal(): void {
    const local = this.local;

    if (!local) {
      return;
    }

    this.onEphemeral('announcing', e => e.set(this.sessionId, local as never));
  }

  /**
   * Run one operation against the ephemeral store, and give up presence for
   * this tab if it throws.
   *
   * Every call here crosses into wasm, and {@link plainCopy} should make a
   * throw impossible for values we write. What it cannot vet is a peer's bytes
   * or a module another part of the app has already panicked in: the wasm
   * instance is shared, so one panic anywhere leaves every later call
   * trapping with a bare `RuntimeError: unreachable`. There is nothing to
   * retry after that, and retrying is the whole problem — see
   * {@link giveUp}.
   */
  private onEphemeral<T>(
    what: string,
    operation: (ephemeral: EphemeralStore) => T,
  ): T | undefined {
    const ephemeral = this.ephemeral;

    if (!ephemeral) {
      return undefined;
    }

    try {
      return operation(ephemeral);
    } catch (e) {
      this.giveUp(what, e);

      return undefined;
    }
  }

  /**
   * Stop being present on this drive, for good, after a wasm failure.
   *
   * Peers TTL this session out on their own, so dropping the store costs a
   * name in a list and buys an end to the errors. `destroy()` is the part that
   * matters: Loro's own expiry timer lives in the JS wrapper, not in wasm, and
   * calls `removeOutdated()` every TTL/2 for as long as the store holds a key.
   * Dropping our reference does not stop that timer, so a store abandoned
   * after a panic went on throwing from `setInterval` for the life of the tab.
   * `destroy()` only clears the interval, which is safe on a poisoned module.
   */
  private giveUp(what: string, cause: unknown): void {
    const ephemeral = this.ephemeral;

    console.error(`[Presence] ${what} failed, dropping presence:`, cause);
    this.stopHeartbeat();
    this.ephemeral = undefined;

    try {
      ephemeral?.destroy();
    } catch (e) {
      console.error('[Presence] could not stop the expiry timer:', e);
    }
  }

  private stopHeartbeat(): void {
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = undefined;
    }
  }

  private start(): void {
    this.unsubTransport = this.store.subscribePresenceUpdates(
      this.drive,
      bytes => {
        if (this.ephemeral) {
          // A peer's bytes are the one input `plainCopy` cannot vet.
          this.onEphemeral('applying a peer update', e => e.apply(bytes));
        } else {
          this.pendingRemote.push(bytes);
        }
      },
    );

    this.unsubLoroReady = LoroLoader.onReady(() => this.init());
  }

  private init(): void {
    const ephemeral = new LoroLoader.Loro.EphemeralStore(PRESENCE_TTL_MS);
    this.ephemeral = ephemeral;

    ephemeral.subscribeLocalUpdates(bytes => {
      this.store.broadcastPresenceUpdate(this.drive, bytes);
    });

    // Fires for local sets, applied remote bytes, and TTL expiry alike.
    ephemeral.subscribe(() => this.emit());

    for (const bytes of this.pendingRemote) {
      this.onEphemeral('applying a buffered peer update', e => e.apply(bytes));
    }

    this.pendingRemote = [];

    for (const [sessionId, entry] of this.pendingInjected) {
      this.onEphemeral('injecting a buffered entry', e =>
        e.set(sessionId, entry as never),
      );
    }

    this.pendingInjected.clear();

    this.writeLocal();

    this.heartbeat = setInterval(() => this.rebroadcast(), HEARTBEAT_MS);
  }

  private stop(): void {
    this.stopHeartbeat();
    this.unsubLoroReady?.();
    // Announce the departure so peers don't wait out the TTL. Must happen
    // while still subscribed: the server only relays updates from current
    // subscribers, so a delete sent after PRESENCE_UNSUBSCRIBE is dropped.
    // Through the helper, so a throw here still leaves by the route below
    // rather than skipping `destroy()` and leaking Loro's expiry timer.
    this.onEphemeral('announcing the departure', e => e.delete(this.sessionId));
    this.unsubTransport?.();

    try {
      this.ephemeral?.destroy();
    } catch (e) {
      console.error('[Presence] could not stop the expiry timer:', e);
    }

    this.ephemeral = undefined;
    this.pendingRemote = [];
    this.pendingInjected.clear();
    this.snapshot = [];
  }

  private emit(): void {
    const next = this.computeSnapshot();

    // Heartbeats (ours and every peer's) fire ephemeral events without
    // changing anything visible; keep the snapshot reference stable so
    // `useSyncExternalStore` consumers don't re-render every few seconds.
    if (JSON.stringify(next) === JSON.stringify(this.snapshot)) {
      return;
    }

    this.snapshot = next;

    for (const listener of this.listeners) {
      try {
        listener();
      } catch (e) {
        console.error('[Presence] listener threw:', e);
      }
    }
  }

  private computeSnapshot(): PresenceItem[] {
    const states = this.onEphemeral(
      'reading the peer list',
      e => e.getAllStates() as Record<string, PresenceEntry | undefined>,
    );

    if (!states) {
      return [];
    }

    return Object.entries(states)
      .filter(
        (pair): pair is [string, PresenceEntry] =>
          typeof pair[1]?.agent === 'string',
      )
      .map(([sessionId, entry]) => ({ sessionId, ...entry }))
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  }
}

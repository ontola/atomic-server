import { LoroLoader } from './loro-loader.js';
import type { Resource } from './resource.js';
import {
  attachmentManifestKey,
  type AttachmentManifest,
} from './attachment-manifest.js';
import type { ReplicaIdentity } from './peer-receipts.js';
import {
  parseSerializedReceipt,
  type Receipt,
  type ResourceSyncEvidence,
} from './resource-receipts.js';

export type CopyState =
  | 'confirmed'
  | 'pending'
  | 'unknown'
  | 'unavailable'
  | 'error'
  | 'not-configured';
export type Copy = Readonly<{
  state: CopyState;
  confirmedAt?: number;
  error?: string;
}>;
/** What one destination proves: the resource document, and its file contents. */
export type DestinationCopy = Copy & { readonly contents: Copy };
export type PeerCopy = DestinationCopy & {
  readonly connectionId: string;
  readonly peerAgent: string;
  readonly storageId?: string;
  readonly generation?: string;
};

/** Evidence for this resource's current CRDT state and attachment contents, per
 * destination. Never a drive-wide guess: a receipt covers one resource.
 * Peer counts do not imply physical independence, continued retention or a
 * recoverable backup.
 */
export interface ResourceCopies {
  /** The resource has files whose contents must be proven too. */
  readonly required: boolean;
  readonly manifest?: AttachmentManifest;
  readonly local: DestinationCopy;
  readonly server: DestinationCopy & { readonly url?: string };
  readonly vault: DestinationCopy;
  readonly peers: Readonly<{
    state: 'unknown' | 'pending' | 'confirmed';
    /** Authenticated sessions, which can share the same underlying storage. */
    connectedCount: number;
    /** Distinct remote storage identities covering this resource's current VV. */
    confirmedCount: number;
    peers: readonly PeerCopy[];
  }>;
}

export interface ResourceCopiesInput {
  subject: string;
  /** The drive holding the resource; peers and Vault are scoped to it. */
  drive?: string;
  serverUrl?: string;
  localAvailable: boolean;
  hasDb: boolean;
  localError?: string;
  manifest?: AttachmentManifest;
  required: boolean;
}

type Stored = {
  version: Record<string, number>;
  manifest?: AttachmentManifest;
  confirmedAt?: number;
  replica?: ReplicaIdentity;
};
type Slot = { resource?: Stored; contents?: Stored };
type Session = {
  drive: string;
  peerAgent: string;
  source?: ReplicaIdentity;
  replica?: ReplicaIdentity;
};
type LocalWrites = { pending: number; sequence: number; error?: string };

const PEER_CONTENTS_TTL = 30_000;
const isPeer = (destination: string) => /^(peer|native):/.test(destination);
const matches = (destination: string, prefix: string) =>
  !prefix || destination === prefix || destination.startsWith(`${prefix}:`);
const message = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/** Parse the version actually carried by bytes, never a later live document. */
export function carriedVersion(
  bytes: Uint8Array | undefined,
): Record<string, number> | undefined {
  if (!bytes || !LoroLoader.isLoaded()) return undefined;

  try {
    return Object.fromEntries(
      LoroLoader.Loro.decodeImportBlobMeta(
        bytes,
        true,
      ).partialEndVersionVector.toJSON(),
    );
  } catch {
    // Diagnostic evidence must never change the outcome of a save.
    return undefined;
  }
}

/** The one coverage rule: the receipt has seen every op of the current document. */
function covers(version: Record<string, number>, resource: Resource): boolean {
  if (!resource.hasLoroDoc()) return false;
  const doc = resource.getLoroDoc();
  if (!doc || doc.getPendingTxnLength() > 0) return false;
  const current = doc.oplogVersion().toJSON();

  return (
    current.size > 0 &&
    [...current].every(([peer, count]) => (version[peer] ?? 0) >= count)
  );
}

/** Receipts by (destination, subject), with one coverage rule, one subscription
 * path and resets fenced per destination. Store owns scopes and transports.
 */
export class ResourceCopiesTracker {
  private slots = new Map<string, Map<string, Slot>>();
  private sessions = new Map<string, Session>();
  private writes = new Map<string, LocalWrites>();
  private generations = new Map<string, number>();
  private removals = new Map<string, number>();
  private snapshots = new WeakMap<Resource, ResourceCopies>();
  private listeners = new Set<{
    subject: () => string;
    callback: () => void;
  }>();

  /** Follow the Resource object through legacy genesis subject renaming. */
  subscribe(subject: () => string, callback: () => void): () => void {
    const listener = { subject, callback };
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  changed(subject?: string): void {
    for (const listener of this.listeners) {
      if (subject && listener.subject() !== subject) continue;

      try {
        listener.callback();
      } catch (error) {
        console.error('[ResourceCopies] subscriber failed:', error);
      }
    }
  }

  /** Capture before an asynchronous proof is gathered; hand it back when
   * delivering. A reset of the destination or removal of the subject since
   * then makes it stale.
   */
  fence(destination: string, subject = ''): string {
    let resets = 0;

    for (const [prefix, count] of this.generations)
      if (matches(destination, prefix)) resets += count;

    return `${resets}:${this.removals.get(subject) ?? 0}`;
  }

  /** Forget everything a destination (or all of them) proved, and fence off
   * acknowledgements still in flight. Destinations match by prefix.
   */
  reset(...prefixes: string[]): void {
    for (const prefix of prefixes.length ? prefixes : ['']) {
      this.generations.set(prefix, (this.generations.get(prefix) ?? 0) + 1);

      for (const key of [...this.slots.keys(), ...this.sessions.keys()]) {
        if (!matches(key, prefix)) continue;
        this.slots.delete(key);
        this.sessions.delete(key);
      }

      if (matches('local', prefix)) this.writes.clear();
    }

    this.changed();
  }

  /** Forget one subject everywhere, including roots whose contents proof lists it. */
  remove(subject: string): void {
    this.removals.set(subject, (this.removals.get(subject) ?? 0) + 1);
    this.writes.delete(subject);

    for (const rows of this.slots.values()) {
      rows.delete(subject);

      for (const [root, slot] of rows) {
        if (!slot.contents?.manifest?.files.some(f => f.subject === subject))
          continue;
        this.removals.set(root, (this.removals.get(root) ?? 0) + 1);
        rows.delete(root);
      }
    }

    this.changed();
  }

  /** Drop what destinations under a prefix proved about one subject. */
  drop(prefix: string, subject: string): void {
    for (const [destination, rows] of this.slots)
      if (matches(destination, prefix) && rows.delete(subject))
        this.changed(subject);
  }

  /** A live authenticated peer connection; it counts even before any receipt. */
  open(destination: string, drive: string, peerAgent: string): () => void {
    const session: Session = { drive, peerAgent };
    this.sessions.set(destination, session);
    this.changed();

    return () => {
      if (this.sessions.get(destination) !== session) return;
      this.close(destination);
    };
  }

  /** Replace the sessions under a prefix with the host's current list. */
  setSessions(
    prefix: string,
    live: { destination: string; drive: string; peerAgent: string }[],
  ): void {
    const keep = new Set(live.map(session => session.destination));

    for (const destination of [...this.sessions.keys()])
      if (matches(destination, prefix) && !keep.has(destination))
        this.close(destination);

    for (const { destination, drive, peerAgent } of live) {
      const old = this.sessions.get(destination);
      if (old?.drive !== drive || old.peerAgent !== peerAgent)
        this.sessions.set(destination, { drive, peerAgent });
    }

    this.changed();
  }

  private close(destination: string): void {
    this.sessions.delete(destination);
    this.slots.delete(destination);
    this.changed();
  }

  /** The connection observed replacement of its backing storage. */
  invalidate(destination: string): void {
    const session = this.sessions.get(destination);
    if (!session) return;
    this.slots.delete(destination);
    session.source = session.replica = undefined;
    this.changed();
  }

  /** The proof a destination holds for the resource document itself. */
  receipt(destination: string, subject: string): Receipt | undefined {
    const stored = this.slots.get(destination)?.get(subject)?.resource;

    return stored && { ...stored, destination, subject };
  }

  /** Record a receipt. Proof only grows: versions merge and an older one never
   * replaces a newer one. The `local` destination alone is replaced outright.
   * Peers must hold an open session that names the same drive and agent.
   */
  acknowledge(receipt: Receipt, fence?: string): boolean {
    const { destination, subject } = receipt;
    const session = this.sessions.get(destination);
    const peer = isPeer(destination);

    if (
      (fence !== undefined && fence !== this.fence(destination, subject)) ||
      (peer &&
        (!session ||
          session.drive !== receipt.session?.drive ||
          session.peerAgent !== receipt.session?.peerAgent))
    )
      return false;

    const contents = !!receipt.manifest;
    const replica = receipt.session?.replica;

    // New backing storage proves nothing the old one did. File-contents
    // proof is judged against the replica it names, not the session's.
    if (
      peer &&
      !contents &&
      replica &&
      (session!.replica?.storageId !== replica.storageId ||
        session!.replica?.generation !== replica.generation)
    ) {
      for (const slot of this.slots.get(destination)?.values() ?? [])
        slot.resource = undefined;
    }

    if (session && peer && !contents) {
      session.source = receipt.session?.source;
      session.replica = replica;
    }

    let rows = this.slots.get(destination);
    if (!rows) this.slots.set(destination, (rows = new Map()));
    const slot = rows.get(subject) ?? {};
    const prior = slot[contents ? 'contents' : 'resource'];

    if (contents) {
      if ((prior?.confirmedAt ?? 0) > (receipt.confirmedAt ?? 0)) return true;
      slot.contents = {
        version: receipt.version,
        manifest: receipt.manifest,
        confirmedAt: receipt.confirmedAt,
        replica,
      };
    } else {
      const version = destination === 'local' ? {} : { ...prior?.version };

      for (const [peerId, count] of Object.entries(receipt.version))
        version[peerId] = Math.max(version[peerId] ?? 0, count);
      slot.resource = {
        version,
        replica,
        confirmedAt:
          receipt.confirmedAt === undefined && prior?.confirmedAt === undefined
            ? undefined
            : Math.max(prior?.confirmedAt ?? 0, receipt.confirmedAt ?? 0),
      };
    }

    rows.set(subject, slot);
    this.changed(subject);

    return true;
  }

  /** A snapshot is authoritative only for the subjects it covered: whatever a
   * destination under the prefix proved about them before is gone unless
   * repeated. With `contents`, resource-document proof is left alone.
   */
  replace(
    prefix: string,
    subjects: string[],
    receipts: Receipt[],
    contents = false,
  ): void {
    for (const [destination, rows] of this.slots) {
      if (!matches(destination, prefix)) continue;

      for (const subject of subjects) {
        const slot = rows.get(subject);
        if (!slot) continue;
        slot.contents = undefined;
        if (!contents) slot.resource = undefined;
      }
    }

    for (const receipt of receipts) this.acknowledge(receipt);
    for (const subject of subjects) this.changed(subject);
  }

  /** Call before the durable write; the returned callback settles it. */
  localWrite(subject: string, bytes: Uint8Array | undefined) {
    const fence = this.fence('local', subject);
    const version = carriedVersion(bytes);
    let writes = this.writes.get(subject);
    if (!writes)
      this.writes.set(subject, (writes = { pending: 0, sequence: 0 }));
    const sequence = ++writes.sequence;
    writes.pending++;
    writes.error = undefined;
    this.changed(subject);

    return (error?: unknown) => {
      if (fence !== this.fence('local', subject)) return;
      writes.pending--;

      // A slower completion cannot replace evidence for a newer write.
      if (sequence === writes.sequence) {
        writes.error = error === undefined ? undefined : message(error);

        if (error === undefined) {
          const slot = this.slots.get('local')?.get(subject);
          if (slot) slot.resource = undefined;
          if (version)
            this.acknowledge({
              destination: 'local',
              subject,
              version,
              confirmedAt: Date.now(),
            });
        }
      }

      this.changed(subject);
    };
  }

  /** Bind a durable read to the scope and local-write generation before its RPC.
   * The database provides proof only after its flush barrier. Reading an old
   * snapshot must not replace a newer completed local write or its error.
   */
  restore(
    subject: string,
  ): (row?: ResourceSyncEvidence, error?: unknown) => void {
    const fences = () => [
      this.fence('local', subject),
      this.fence('server', subject),
    ];
    const bound = fences().join();
    let writes = this.writes.get(subject);
    if (!writes)
      this.writes.set(subject, (writes = { pending: 0, sequence: 0 }));
    const sequence = writes.sequence;

    return (row, error) => {
      if (fences().join() !== bound) return;
      const version = carriedVersion(row?.snapshot ?? undefined);

      if (sequence === writes.sequence && writes.pending === 0) {
        if (error !== undefined) {
          writes.error = message(error);
        } else if (version) {
          // A fresh verification of stored bytes, not knowledge of when they
          // were originally saved.
          writes.error = undefined;
          this.acknowledge({ destination: 'local', subject, version });
        }
      }

      const server = version
        ? parseSerializedReceipt(row?.serverReceipt)
        : undefined;
      if (server?.subject === subject)
        this.acknowledge({ ...server, destination: 'server' });
      this.changed(subject);
    };
  }

  get(resource: Resource, input: ResourceCopiesInput): ResourceCopies {
    const { subject, drive, manifest } = input;
    const slot = (destination: string) =>
      this.slots.get(destination)?.get(subject);
    const state = (proof?: Stored): 'confirmed' | 'pending' | 'unknown' =>
      !proof
        ? 'unknown'
        : covers(proof.version, resource)
          ? 'confirmed'
          : 'pending';
    const contentsOf = (proof?: Stored, valid = true): Copy => ({
      state:
        !proof || !valid
          ? 'unknown'
          : manifest &&
              attachmentManifestKey(proof.manifest!) ===
                attachmentManifestKey(manifest)
            ? 'confirmed'
            : 'pending',
      confirmedAt: valid ? proof?.confirmedAt : undefined,
    });
    const copy = (found?: Slot): DestinationCopy => ({
      state: state(found?.resource),
      confirmedAt: found?.resource?.confirmedAt,
      contents: contentsOf(found?.contents),
    });
    const writes = this.writes.get(subject);
    const local = slot('local');
    const localError = input.localError ?? writes?.error;
    const unconfigured: Copy = { state: 'not-configured' };
    const serverCopy = copy(slot('server'));
    let connectedCount = 0;
    const best = new Map<string, PeerCopy>();

    for (const [destination, session] of this.sessions) {
      if (!isPeer(destination) || !drive || session.drive !== drive) continue;
      connectedCount++;
      const { replica, source } = session;
      // A second tab or a byte-cloned DB is not another independent copy.
      if (replica && replica.storageId === source?.storageId) continue;
      const found = slot(destination);
      const proof = found?.contents;
      const fresh =
        proof?.replica?.storageId === replica?.storageId &&
        proof?.replica?.generation === replica?.generation &&
        (proof?.confirmedAt ?? 0) <= Date.now() &&
        Date.now() - (proof?.confirmedAt ?? 0) < PEER_CONTENTS_TTL;
      const peer: PeerCopy = Object.freeze({
        ...copy(found),
        contents: contentsOf(proof, !!replica && fresh),
        connectionId: destination.replace(/^\w+:/, ''),
        peerAgent: session.peerAgent,
        ...replica,
      });
      const key = replica
        ? `${replica.storageId}:${replica.generation}`
        : destination;
      const prior = best.get(key);

      if (
        !prior ||
        (peer.state === 'confirmed' && prior.state !== 'confirmed') ||
        (peer.state === prior.state &&
          (peer.confirmedAt ?? 0) > (prior.confirmedAt ?? 0)) ||
        (peer.state === 'pending' && prior.state === 'unknown')
      )
        best.set(key, peer);
    }

    const peers = Object.freeze([...best.values()]);
    const confirmedCount = peers.filter(p => p.state === 'confirmed').length;
    const next: ResourceCopies = {
      required: input.required,
      manifest,
      local: {
        state: localError
          ? 'error'
          : !input.localAvailable
            ? 'unavailable'
            : state(local?.resource) === 'confirmed'
              ? 'confirmed'
              : writes?.pending || local?.resource
                ? 'pending'
                : 'unknown',
        confirmedAt: local?.resource?.confirmedAt,
        error: localError,
        contents: input.hasDb
          ? contentsOf(local?.contents)
          : { state: 'unavailable' },
      },
      server: input.serverUrl
        ? { ...serverCopy, url: input.serverUrl }
        : {
            ...serverCopy,
            state: 'not-configured',
            url: undefined,
            contents: unconfigured,
          },
      vault: copy(drive ? slot(`vault:${drive}`) : undefined),
      peers: Object.freeze({
        state: confirmedCount
          ? 'confirmed'
          : peers.some(p => p.state === 'pending')
            ? 'pending'
            : 'unknown',
        connectedCount,
        confirmedCount,
        peers,
      }),
    };
    const previous = this.snapshots.get(resource);

    if (previous && JSON.stringify(previous) === JSON.stringify(next))
      return previous;
    this.snapshots.set(resource, Object.freeze(next));

    return next;
  }
}

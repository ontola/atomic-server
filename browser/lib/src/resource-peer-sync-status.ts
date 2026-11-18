import type { ResourcePeerEvidence } from './resource-peer-evidence.js';
import { decodeB64 } from './base64.js';
import { LoroLoader } from './loro-loader.js';
import type {
  BrowserReplicaReceipt,
  ReplicaIdentity,
} from './peer-receipts.js';
import type { Resource } from './resource.js';

export interface ResourcePeerCopy {
  readonly connectionId: string;
  readonly peerAgent: string;
  readonly state: 'unknown' | 'pending' | 'confirmed';
  readonly confirmedAt?: number;
  readonly storageId?: string;
  readonly generation?: string;
}

/** Live browser or native peer connections only. Counts never imply physical independence,
 * attachment coverage, continued retention, or a recoverable backup.
 */
export interface ResourcePeerSyncStatus {
  readonly state: 'unknown' | 'pending' | 'confirmed';
  /** Authenticated sessions, which can share the same underlying storage. */
  readonly connectedCount: number;
  /** Distinct remote storage identities covering this resource's current VV. */
  readonly confirmedCount: number;
  readonly peers: readonly ResourcePeerCopy[];
}

type Receipt = { version: Map<string, number>; confirmedAt: number };
type Connection = {
  drive: string;
  peerAgent: string;
  source?: ReplicaIdentity;
  replica?: ReplicaIdentity;
  receipts: Map<string, Receipt>;
};

function covers(receipt: Receipt, resource: Resource): boolean {
  if (!resource.hasLoroDoc()) return false;
  const doc = resource.getLoroDoc();
  if (!doc || doc.getPendingTxnLength() > 0) return false;
  const current = doc.oplogVersion().toJSON();

  return (
    current.size > 0 &&
    [...current].every(
      ([peer, counter]) => (receipt.version.get(peer) ?? 0) >= counter,
    )
  );
}

/** Store owns identity/database epochs and resource change subscriptions. */
export class ResourcePeerSyncStatusTracker {
  private connections = new Map<string, Connection>();
  private native = new Map<string, Map<string, Connection>>();
  private listeners = new Set<{
    subject: () => string;
    drive: () => string | undefined;
    callback: () => void;
  }>();
  private snapshots = new WeakMap<Resource, ResourcePeerSyncStatus>();

  private changed(subject?: string, drive?: string): void {
    for (const listener of this.listeners) {
      if (subject && listener.subject() !== subject) continue;
      if (drive && listener.drive() !== drive) continue;

      try {
        listener.callback();
      } catch {
        // Diagnostics never change synchronization outcomes.
      }
    }
  }

  subscribe(
    subject: () => string,
    drive: () => string | undefined,
    callback: () => void,
  ): () => void {
    const listener = { subject, drive, callback };
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  reset(): void {
    this.connections.clear();
    this.native.clear();
    this.changed();
  }

  open(connectionId: string, drive: string, peerAgent: string): () => void {
    const connection: Connection = { drive, peerAgent, receipts: new Map() };
    this.connections.set(connectionId, connection);
    this.changed(undefined, drive);

    return () => {
      if (this.connections.get(connectionId) !== connection) return;
      this.connections.delete(connectionId);
      this.changed(undefined, drive);
    };
  }

  invalidate(connectionId: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    connection.receipts.clear();
    connection.source = undefined;
    connection.replica = undefined;
    this.changed(undefined, connection.drive);
  }

  remove(subject: string): void {
    this.native.delete(subject);

    for (const connection of this.connections.values()) {
      connection.receipts.delete(subject);
    }

    this.changed(subject);
  }

  /** Native snapshots are authoritative only for their requested subjects.
   * A disappeared receipt must not survive through monotonic browser merging.
   */
  replaceNative(
    subjects: string[],
    evidence: ResourcePeerEvidence | undefined,
    valid: (subject: string) => boolean = () => true,
  ): void {
    for (const subject of subjects) {
      if (!valid(subject)) continue;
      const connections = new Map<string, Connection>();

      for (const connection of evidence?.connections ?? []) {
        const receipt = connection.receipts.find(
          entry => entry.subject === subject,
        );
        const receipts = new Map<string, Receipt>();

        if (receipt) {
          receipts.set(subject, {
            version: LoroLoader.Loro.VersionVector.decode(
              decodeB64(receipt.version),
            ).toJSON(),
            confirmedAt: receipt.confirmedAt,
          });
        }

        connections.set(connection.connectionId, {
          drive: connection.drive,
          peerAgent: connection.peerAgent,
          source: receipt?.source,
          replica: receipt?.replica,
          receipts,
        });
      }

      if (connections.size) this.native.set(subject, connections);
      else this.native.delete(subject);
      this.changed(subject);
    }
  }

  clearNative(subject?: string): void {
    const subjects = subject ? [subject] : [...this.native.keys()];

    for (const key of subjects) {
      if (this.native.delete(key)) this.changed(key);
    }
  }

  acknowledge(receipt: BrowserReplicaReceipt): void {
    const connection = this.connections.get(receipt.connectionId);
    if (
      !connection ||
      connection.drive !== receipt.drive ||
      connection.peerAgent !== receipt.peerAgent
    )
      return;

    let version: Map<string, number>;

    try {
      version = LoroLoader.Loro.VersionVector.decode(
        decodeB64(receipt.version),
      ).toJSON();
      if (
        !version.size ||
        [...version.values()].some(
          count => !Number.isSafeInteger(count) || count <= 0,
        )
      )
        return;
    } catch {
      return;
    }

    const identityChanged =
      !connection.replica ||
      connection.replica.storageId !== receipt.replica.storageId ||
      connection.replica.generation !== receipt.replica.generation;
    if (identityChanged) connection.receipts.clear();
    connection.source = receipt.source;
    connection.replica = receipt.replica;
    const prior = connection.receipts.get(receipt.subject);

    if (prior) {
      for (const [peer, counter] of prior.version) {
        version.set(peer, Math.max(counter, version.get(peer) ?? 0));
      }
    }

    connection.receipts.set(receipt.subject, {
      version,
      confirmedAt: Math.max(prior?.confirmedAt ?? 0, receipt.confirmedAt),
    });
    this.changed(
      identityChanged ? undefined : receipt.subject,
      identityChanged ? connection.drive : undefined,
    );
  }

  get(
    subject: string,
    drive: string | undefined,
    resource: Resource,
  ): ResourcePeerSyncStatus {
    let connectedCount = 0;
    const copies = new Map<string, ResourcePeerCopy>();

    for (const [connectionId, connection] of [
      ...this.connections,
      ...(this.native.get(subject) ?? []),
    ]) {
      if (!drive || connection.drive !== drive) continue;
      connectedCount++;
      const { replica, source } = connection;
      // A second tab or a byte-cloned DB is not another independent copy.
      if (replica && replica.storageId === source?.storageId) continue;
      const receipt = connection.receipts.get(subject);
      const state = receipt
        ? covers(receipt, resource)
          ? 'confirmed'
          : 'pending'
        : 'unknown';
      const copy: ResourcePeerCopy = Object.freeze({
        connectionId,
        peerAgent: connection.peerAgent,
        state,
        ...(receipt ? { confirmedAt: receipt.confirmedAt } : {}),
        ...(replica ? replica : {}),
      });
      const key = replica
        ? `${replica.storageId}:${replica.generation}`
        : connectionId;
      const prior = copies.get(key);

      if (
        !prior ||
        (state === 'confirmed' && prior.state !== 'confirmed') ||
        (state === prior.state &&
          (copy.confirmedAt ?? 0) > (prior.confirmedAt ?? 0)) ||
        (state === 'pending' && prior.state === 'unknown')
      )
        copies.set(key, copy);
    }

    const peers = Object.freeze([...copies.values()]);
    const confirmedCount = peers.filter(
      peer => peer.state === 'confirmed',
    ).length;
    const state = confirmedCount
      ? 'confirmed'
      : peers.some(peer => peer.state === 'pending')
        ? 'pending'
        : 'unknown';
    const next: ResourcePeerSyncStatus = Object.freeze({
      state,
      connectedCount,
      confirmedCount,
      peers,
    });
    const previous = this.snapshots.get(resource);

    if (previous && JSON.stringify(previous) === JSON.stringify(next))
      return previous;
    this.snapshots.set(resource, next);

    return next;
  }
}

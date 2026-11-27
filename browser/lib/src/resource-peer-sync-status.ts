import type { ResourcePeerEvidence } from './resource-peer-evidence.js';
import {
  PersistenceEvidenceRegistry,
  decodePersistenceVersion,
  resourcePersistenceVersion,
  type PersistenceEvidenceScope,
} from './persistence-evidence.js';
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
  /** Reachability is separate from a historical storage receipt. */
  readonly connected?: boolean;
}

/** Historical browser receipts and current native observations. Counts never imply physical independence,
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

type Connection = {
  connected?: boolean;
  drive: string;
  peerAgent: string;
  source?: ReplicaIdentity;
  replica?: ReplicaIdentity;
  receipts: PersistenceEvidenceScope;
};

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

  constructor(private registry = new PersistenceEvidenceRegistry()) {}

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
    for (const c of this.connections.values()) c.receipts.close();
    for (const cs of this.native.values())
      for (const c of cs.values()) c.receipts.close();
    this.connections.clear();
    this.native.clear();
    this.changed();
  }

  open(connectionId: string, drive: string, peerAgent: string): () => void {
    const connection: Connection = {
      connected: true,
      drive,
      peerAgent,
      receipts: this.registry.open(`peer:${connectionId}`),
    };
    this.connections.set(connectionId, connection);
    const disconnected = [...this.connections].filter(
      ([, c]) => c.connected === false,
    );

    for (const [id, old] of disconnected.slice(
      0,
      Math.max(0, disconnected.length - 128),
    )) {
      old.receipts.close();
      this.connections.delete(id);
    }

    this.changed(undefined, drive);

    return () => {
      if (this.connections.get(connectionId) !== connection) return;
      connection.connected = false;
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
    this.clearNative(subject);

    for (const connection of this.connections.values()) {
      connection.receipts.remove(subject);
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
      this.clearNative(subject);
      const connections = new Map<string, Connection>();

      for (const connection of evidence?.connections ?? []) {
        const receipt = connection.receipts.find(
          entry => entry.subject === subject,
        );
        const receipts = this.registry.open(
          `native-peer:${subject}:${connection.connectionId}`,
          `native:${connection.connectionId}`,
        );
        const version = receipt && decodePersistenceVersion(receipt.version);

        if (receipt && version) {
          receipts.record(subject, {
            boundary: 'stored',
            version,
            confirmedAt: receipt.confirmedAt,
            barrier: 'peer-storage-flush',
            source: receipt.source,
            replica: receipt.replica,
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
      for (const c of this.native.get(key)?.values() ?? []) c.receipts.close();
      if (this.native.delete(key)) this.changed(key);
    }
  }

  isConnected(id: string): boolean {
    const browser = this.connections.get(id);
    if (browser) return browser.connected !== false;

    return [...this.native.values()].some(connections => connections.has(id));
  }

  acknowledge(receipt: BrowserReplicaReceipt): void {
    const connection = this.connections.get(receipt.connectionId);
    if (
      !connection ||
      connection.connected === false ||
      connection.drive !== receipt.drive ||
      connection.peerAgent !== receipt.peerAgent
    )
      return;

    const version = decodePersistenceVersion(receipt.version);
    if (!version || Object.values(version).some(count => count <= 0)) return;

    const identityChanged =
      !connection.replica ||
      connection.replica.storageId !== receipt.replica.storageId ||
      connection.replica.generation !== receipt.replica.generation;
    if (identityChanged) connection.receipts.clear();

    // A fresh incarnation supersedes old history for this physical store.
    for (const prior of this.connections.values()) {
      if (
        prior !== connection &&
        prior.replica?.storageId === receipt.replica.storageId &&
        prior.replica.generation !== receipt.replica.generation
      )
        prior.receipts.clear();
    }

    connection.source = receipt.source;
    connection.replica = receipt.replica;
    connection.receipts.record(receipt.subject, {
      boundary: 'stored',
      version,
      confirmedAt: receipt.confirmedAt,
      barrier: 'peer-storage-flush',
      source: receipt.source,
      replica: receipt.replica,
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
      if (connection.connected !== false) connectedCount++;
      const { replica, source } = connection;
      // A second tab or a byte-cloned DB is not another independent copy.
      if (replica && replica.storageId === source?.storageId) continue;
      const receipt = connection.receipts.latest(subject, 'stored');
      const state = receipt
        ? connection.receipts.covering(
            subject,
            'stored',
            resourcePersistenceVersion(resource),
          )
          ? 'confirmed'
          : 'pending'
        : 'unknown';
      const copy: ResourcePeerCopy = Object.freeze({
        connectionId,
        peerAgent: connection.peerAgent,
        connected: connection.connected !== false,
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
        (state === prior.state && copy.connected && !prior.connected) ||
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

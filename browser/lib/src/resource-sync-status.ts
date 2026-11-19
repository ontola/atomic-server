import { LoroLoader } from './loro-loader.js';
import type { Resource } from './resource.js';
import {
  parseSerializedServerReceipt,
  type ResourceSyncEvidence,
  type SerializedServerReceipt,
} from './resource-sync-evidence.js';

/** Evidence for this resource's current CRDT state, not a drive-wide guess.
 * Receipts cover observed CRDT versions, not attachment bytes or other resources.
 */
export interface ResourceSyncStatus {
  readonly local: Readonly<{
    state: 'confirmed' | 'pending' | 'unknown' | 'unavailable' | 'error';
    confirmedAt?: number;
    error?: string;
  }>;
  readonly server: Readonly<{
    state: 'confirmed' | 'pending' | 'unknown' | 'not-configured';
    url?: string;
    confirmedAt?: number;
  }>;
}

type Version = Map<string, number>;
type Receipt = { version: Version; confirmedAt?: number };
type Evidence = {
  local?: Receipt;
  server?: Receipt;
  pendingWrites: number;
  writeSequence: number;
  localError?: string;
};

/** Parse the version actually carried by bytes, never a later live document. */
function carriedVersion(bytes: Uint8Array | undefined): Version | undefined {
  if (!bytes || !LoroLoader.isLoaded()) return undefined;

  try {
    return LoroLoader.Loro.decodeImportBlobMeta(
      bytes,
      true,
    ).partialEndVersionVector.toJSON();
  } catch {
    // Diagnostic evidence must never change the outcome of a save.
    return undefined;
  }
}

function covers(receipt: Receipt | undefined, resource: Resource): boolean {
  if (!receipt || !resource.hasLoroDoc()) return false;
  const doc = resource.getLoroDoc();
  if (!doc || doc.getPendingTxnLength() > 0) return false;
  const current = doc.oplogVersion().toJSON();

  return (
    current.size > 0 &&
    [...current].every(
      ([peer, count]) => (receipt.version.get(peer) ?? 0) >= count,
    )
  );
}

/** Internal receipt ledger. Store owns scope, normalization and subscriptions. */
export class ResourceSyncStatusTracker {
  private evidence = new Map<string, Evidence>();
  private snapshots = new WeakMap<Resource, ResourceSyncStatus>();
  private listeners = new Set<{
    subject: () => string;
    callback: () => void;
  }>();
  private epoch = 0;

  private entry(subject: string): Evidence {
    let entry = this.evidence.get(subject);

    if (!entry) {
      entry = { pendingWrites: 0, writeSequence: 0 };
      this.evidence.set(subject, entry);
    }

    return entry;
  }

  private changed(subject: string): void {
    for (const listener of this.listeners) {
      if (listener.subject() === subject) this.notify(listener.callback);
    }
  }

  private notify(callback: () => void): void {
    try {
      callback();
    } catch (error) {
      console.error('[ResourceSyncStatus] subscriber failed:', error);
    }
  }

  /** Identity/destination changes invalidate in-flight acknowledgements too. */
  reset(): void {
    this.epoch++;
    this.evidence.clear();
    for (const listener of this.listeners) this.notify(listener.callback);
  }

  remove(subject: string): void {
    this.evidence.delete(subject);
    this.changed(subject);
  }

  subscribe(subject: () => string, callback: () => void): () => void {
    // Follow the Resource object through legacy genesis subject renaming.
    const listener = { subject, callback };
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Call before sending; the returned acknowledgement cannot include newer ops. */
  serverWrite(
    subject: string,
    bytes: Uint8Array | undefined,
  ): () => SerializedServerReceipt | undefined {
    const epoch = this.epoch;
    const version = carriedVersion(bytes);
    const entry = this.entry(subject);

    return () => {
      if (
        epoch !== this.epoch ||
        !version ||
        this.evidence.get(subject) !== entry
      )
        return;
      const merged = new Map(entry.server?.version);

      for (const [peer, count] of version) {
        merged.set(peer, Math.max(merged.get(peer) ?? 0, count));
      }

      entry.server = { version: merged, confirmedAt: Date.now() };
      const receipt = this.serverReceipt(subject);
      this.changed(subject);

      return receipt;
    };
  }

  /** A copy of proven server coverage, never the live resource's version. */
  serverReceipt(subject: string): SerializedServerReceipt | undefined {
    const receipt = this.evidence.get(subject)?.server;
    if (!receipt || receipt.confirmedAt === undefined) return undefined;

    return {
      subject,
      version: Object.fromEntries(receipt.version),
      confirmedAt: receipt.confirmedAt,
    };
  }

  /** Bind a durable read to the scope and local-write generation before its RPC.
   * The database provides proof only after its flush barrier. Reading an old
   * snapshot must not replace a newer completed local write or its error.
   */
  restore(
    subject: string,
  ): (row?: ResourceSyncEvidence, error?: unknown) => void {
    const epoch = this.epoch;
    const entry = this.entry(subject);
    const sequence = entry.writeSequence;

    return (row, error) => {
      if (epoch !== this.epoch || this.evidence.get(subject) !== entry) return;

      const restoredVersion = carriedVersion(row?.snapshot ?? undefined);

      if (sequence === entry.writeSequence && entry.pendingWrites === 0) {
        if (error !== undefined) {
          entry.localError =
            error instanceof Error ? error.message : String(error);
        } else if (restoredVersion) {
          // This is a fresh verification of stored bytes, not knowledge of
          // when they were originally saved.
          entry.local = { version: restoredVersion };
          entry.localError = undefined;
        }
      }

      const server = restoredVersion
        ? parseSerializedServerReceipt(row?.serverReceipt)
        : undefined;

      if (server && server.subject === subject) {
        const version = new Map(entry.server?.version);

        for (const [peer, count] of Object.entries(server.version)) {
          version.set(peer, Math.max(version.get(peer) ?? 0, count));
        }

        entry.server = {
          version,
          confirmedAt: Math.max(
            entry.server?.confirmedAt ?? 0,
            server.confirmedAt,
          ),
        };
      }

      this.changed(subject);
    };
  }

  /** The database RPC resolves only after its durable write barrier. */
  localWrite(subject: string, bytes: Uint8Array | undefined) {
    const epoch = this.epoch;
    const version = carriedVersion(bytes);
    const entry = this.entry(subject);
    const sequence = ++entry.writeSequence;
    entry.pendingWrites++;
    entry.localError = undefined;
    this.changed(subject);

    return (error?: unknown) => {
      if (epoch !== this.epoch || this.evidence.get(subject) !== entry) return;
      entry.pendingWrites--;

      // A slower completion cannot replace evidence for a newer write.
      if (sequence === entry.writeSequence) {
        if (error !== undefined) {
          entry.localError =
            error instanceof Error ? error.message : String(error);
        } else {
          entry.localError = undefined;
          entry.local = version
            ? { version, confirmedAt: Date.now() }
            : undefined;
        }
      }

      this.changed(subject);
    };
  }

  get(
    subject: string,
    resource: Resource,
    input: { localAvailable: boolean; localError?: string; serverUrl?: string },
  ): ResourceSyncStatus {
    const entry = this.evidence.get(subject);
    const localError = input.localError ?? entry?.localError;
    const local: ResourceSyncStatus['local'] = {
      state: localError
        ? 'error'
        : !input.localAvailable
          ? 'unavailable'
          : covers(entry?.local, resource)
            ? 'confirmed'
            : entry?.pendingWrites || entry?.local
              ? 'pending'
              : 'unknown',
      confirmedAt: entry?.local?.confirmedAt,
      error: localError,
    };
    const server: ResourceSyncStatus['server'] = {
      state: !input.serverUrl
        ? 'not-configured'
        : covers(entry?.server, resource)
          ? 'confirmed'
          : entry?.server
            ? 'pending'
            : 'unknown',
      url: input.serverUrl,
      confirmedAt: entry?.server?.confirmedAt,
    };
    const previous = this.snapshots.get(resource);

    if (
      previous &&
      JSON.stringify(previous) === JSON.stringify({ local, server })
    ) {
      return previous;
    }

    const status = Object.freeze({
      local: Object.freeze(local),
      server: Object.freeze(server),
    });
    this.snapshots.set(resource, status);

    return status;
  }
}

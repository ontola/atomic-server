import {
  PersistenceEvidenceRegistry,
  decodePersistenceVersion,
  persistenceVersion,
  resourcePersistenceVersion,
  type PersistenceEvidenceScope,
} from './persistence-evidence.js';
import { LoroLoader } from './loro-loader.js';
import type { Resource } from './resource.js';
import {
  parseSerializedServerReceipt,
  type ResourceSyncEvidence,
  type SerializedServerReceipt,
  type StoredServerReceipt,
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
    /** Transport acceptance (legacy). Use stored for a durable copy. */
    state: 'confirmed' | 'pending' | 'unknown' | 'not-configured';
    url?: string;
    confirmedAt?: number;
    /** Acceptance and persistent storage are independent boundaries. */
    accepted?: 'confirmed' | 'pending' | 'unknown';
    stored?: 'confirmed' | 'pending' | 'unknown';
    storageId?: string;
    generation?: string;
  }>;
}

type Version = Map<string, number>;
type Evidence = {
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

/** Internal receipt ledger. Store owns scope, normalization and subscriptions. */
export class ResourceSyncStatusTracker {
  private evidence = new Map<string, Evidence>();
  private snapshots = new WeakMap<Resource, ResourceSyncStatus>();
  private listeners = new Set<{
    subject: () => string;
    callback: () => void;
  }>();
  private epoch = 0;
  private local: PersistenceEvidenceScope;
  private server: PersistenceEvidenceScope;
  private serverStores = new Map<
    string,
    {
      scope: PersistenceEvidenceScope;
      replica: Pick<StoredServerReceipt, 'storageId' | 'generation'>;
    }
  >();
  private serverSubjects = new Map<string, string>();

  constructor(private registry = new PersistenceEvidenceRegistry()) {
    this.local = registry.open('local');
    this.server = registry.open('server');
  }

  private serverStore(
    drive: string,
    replica: Pick<StoredServerReceipt, 'storageId' | 'generation'>,
    replace: boolean,
  ) {
    let store = this.serverStores.get(drive);

    if (
      !store ||
      (replace &&
        (store.replica.storageId !== replica.storageId ||
          store.replica.generation !== replica.generation))
    ) {
      store = {
        scope: this.registry.open(`server-stored:${drive}`),
        replica: Object.freeze({
          storageId: replica.storageId,
          generation: replica.generation,
        }),
      };
      this.serverStores.set(drive, store);
    }

    return store;
  }

  storedServer(
    subject: string,
    version: string,
    barrier: string,
    replica: Pick<StoredServerReceipt, 'storageId' | 'generation'>,
    drive: string,
  ): void {
    const decoded = decodePersistenceVersion(version);
    if (!decoded || !drive) return;
    const { scope } = this.serverStore(drive, replica, true);
    this.serverSubjects.set(subject, drive);
    this.server.record(subject, 'accepted', {
      version: decoded,
      confirmedAt: Date.now(),
    });
    scope.record(subject, 'stored', {
      version: decoded,
      barrier,
      confirmedAt: Date.now(),
    });
    // A generation change can invalidate other subjects in this drive too.
    for (const listener of this.listeners) this.notify(listener.callback);
  }

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
    this.local = this.registry.open('local');
    this.server = this.registry.open('server');
    for (const store of this.serverStores.values()) store.scope.close();
    this.serverStores.clear();
    this.serverSubjects.clear();
    for (const listener of this.listeners) this.notify(listener.callback);
  }

  remove(subject: string): void {
    this.evidence.delete(subject);
    this.local.remove(subject);
    this.server.remove(subject);
    this.serverStores
      .get(this.serverSubjects.get(subject) ?? '')
      ?.scope.remove(subject);
    this.serverSubjects.delete(subject);
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
      // Acceptance concerns operations: successive authenticated UPDATE
      // deltas may carry disjoint peers. Accumulate accepted operations only;
      // persistent snapshot barriers remain distinct observations.
      const accepted = { ...persistenceVersion(version)! };
      for (const prior of this.server.receipts(subject, 'accepted'))
        for (const [peer, count] of Object.entries(prior.version))
          accepted[peer] = Math.max(accepted[peer] ?? 0, count);
      this.server.record(subject, 'accepted', {
        version: accepted,
        confirmedAt: Date.now(),
      });
      const receipt = this.serverReceipt(subject);
      this.changed(subject);

      return receipt;
    };
  }

  /** A copy of proven server coverage, never the live resource's version. */
  serverReceipt(subject: string): SerializedServerReceipt | undefined {
    const receipt = this.server.latest(subject, 'accepted');
    if (!receipt || receipt.confirmedAt === undefined) return undefined;

    const drive = this.serverSubjects.get(subject);
    const store = drive ? this.serverStores.get(drive) : undefined;
    const stored = store?.scope.latest(subject, 'stored');

    return {
      subject,
      version: { ...receipt.version },
      confirmedAt: receipt.confirmedAt,
      ...(stored?.confirmedAt !== undefined && stored.barrier && store && drive
        ? {
            stored: {
              version: { ...stored.version },
              confirmedAt: stored.confirmedAt,
              barrier: stored.barrier,
              drive,
              ...store.replica,
            },
          }
        : {}),
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
          this.local.record(subject, 'stored', {
            version: persistenceVersion(restoredVersion)!,
            barrier: 'local-storage-flush',
          });
          entry.localError = undefined;
        }
      }

      const server = restoredVersion
        ? parseSerializedServerReceipt(row?.serverReceipt)
        : undefined;

      if (server && server.subject === subject) {
        this.server.record(subject, 'accepted', {
          version: server.version,
          confirmedAt: server.confirmedAt,
        });

        if (server.stored) {
          const stored = server.stored;
          const store = this.serverStore(stored.drive, stored, false);

          if (
            store.replica.storageId === stored.storageId &&
            store.replica.generation === stored.generation
          ) {
            this.serverSubjects.set(subject, stored.drive);
            store.scope.record(subject, 'stored', stored);
          }
        }
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
          if (version)
            this.local.record(subject, 'stored', {
              version: persistenceVersion(version)!,
              barrier: 'local-storage-flush',
              confirmedAt: Date.now(),
            });
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
    const target = resourcePersistenceVersion(resource);
    const localReceipt = this.local.latest(subject, 'stored');
    const acceptedReceipt = this.server.latest(subject, 'accepted');
    const serverStore = this.serverStores.get(
      this.serverSubjects.get(subject) ?? '',
    );
    const storedReceipt = serverStore?.scope.latest(subject, 'stored');
    const accepted = this.server.covering(subject, 'accepted', target)
      ? 'confirmed'
      : acceptedReceipt
        ? 'pending'
        : 'unknown';
    const stored = serverStore?.scope.covering(subject, 'stored', target)
      ? 'confirmed'
      : storedReceipt
        ? 'pending'
        : 'unknown';
    const local: ResourceSyncStatus['local'] = {
      state: localError
        ? 'error'
        : !input.localAvailable
          ? 'unavailable'
          : this.local.covering(subject, 'stored', target)
            ? 'confirmed'
            : entry?.pendingWrites || localReceipt
              ? 'pending'
              : 'unknown',
      confirmedAt: localReceipt?.confirmedAt,
      error: localError,
    };
    const server: ResourceSyncStatus['server'] = {
      state: !input.serverUrl ? 'not-configured' : accepted,
      url: input.serverUrl,
      confirmedAt: storedReceipt?.confirmedAt ?? acceptedReceipt?.confirmedAt,
      accepted,
      stored,
      ...serverStore?.replica,
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

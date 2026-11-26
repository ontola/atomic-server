import { canonicalizeScheme } from '@tomic/lib';
import { restoreDriveBlobs, type VaultCapableDb } from './vault';
import {
  recoveryAwait,
  recoveryDelay,
  scanMissingReferenced,
} from './fileRecoveryRuntime';

export type FileRepairProgress = {
  stage: 'scanning' | 'peers' | 'vault' | 'complete';
  done: number;
  total: number;
};

export type FileRepairOutcome = {
  /** Initially missing hashes that the drive still references at completion. */
  total: number;
  repaired: number;
  /** Verified against the current local inventory, independently of Vault counts. */
  missing: string[];
  unreadable: number;
  error?: string;
};

type FileRepairDb = VaultCapableDb &
  Required<
    Pick<
      VaultCapableDb,
      'vaultFileHashes' | 'vaultBlobPresent' | 'vaultBlobRestore'
    >
  >;

export function canRepairDriveFiles(
  db: VaultCapableDb | null,
): db is FileRepairDb {
  return Boolean(
    db?.vaultFileHashes && db.vaultBlobPresent && db.vaultBlobRestore,
  );
}

type FileRepairArgs = {
  db: VaultCapableDb;
  driveSubject: string;
  drivePseudonym: string;
  driveKey: Uint8Array;
  keyEpoch?: number;
  /** Limit this operation to the requested hashes that are still referenced. */
  hashes?: string[];
  /** Automatic recovery has already given connected peers an opportunity. */
  peerWaitMs?: number;
  signal?: AbortSignal;
  throwIfStale?: () => void | Promise<void>;
  /** Issue requests on available connections. The core bounds the waiting time. */
  tryPeers: (hashes: string[], signal: AbortSignal) => Promise<void>;
  onProgress?: (progress: FileRepairProgress) => void;
};

const activeRepairs = new WeakMap<VaultCapableDb, Set<string>>();

/** Recover exact file bytes. Resource history is never imported by this path. */
export async function repairDriveFiles(
  args: FileRepairArgs,
): Promise<FileRepairOutcome> {
  const drive = canonicalizeScheme(args.driveSubject.split(/[?#]/)[0]);
  const active = activeRepairs.get(args.db) ?? new Set<string>();

  if (active.has(drive)) {
    throw new Error('File recovery is already running for this drive.');
  }

  active.add(drive);
  activeRepairs.set(args.db, active);

  try {
    return await repairDriveFilesOnce(args);
  } finally {
    active.delete(drive);
  }
}

async function repairDriveFilesOnce({
  db,
  driveSubject,
  drivePseudonym,
  driveKey,
  keyEpoch = 1,
  hashes: requestedHashes,
  peerWaitMs = 5_000,
  signal,
  throwIfStale,
  tryPeers,
  onProgress,
}: FileRepairArgs): Promise<FileRepairOutcome> {
  if (!canRepairDriveFiles(db)) {
    throw new Error(
      'Recovering file contents is not available on this device.',
    );
  }

  const guarded = <T>(operation: Promise<T> | T) =>
    recoveryAwait(operation, signal, throwIfStale);
  const guard = () => guarded(undefined);
  const currentWanted = (
    candidates?: Iterable<string>,
    onResolved?: (hash: string, present: boolean) => void,
  ) =>
    guarded(
      scanMissingReferenced(db, driveSubject, candidates, guard, onResolved),
    );

  onProgress?.({ stage: 'scanning', done: 0, total: 0 });
  const original = new Set(await currentWanted(requestedHashes));
  let wanted = [...original];

  if (wanted.length > 0 && peerWaitMs > 0) {
    onProgress?.({ stage: 'peers', done: 0, total: wanted.length });
    const peerController = new AbortController();
    const stopPeers = () => peerController.abort();
    signal?.addEventListener('abort', stopPeers, { once: true });
    // A failed peer attempt still allows the authorized backup to supply bytes.
    const attempt = Promise.resolve().then(() =>
      tryPeers(wanted, peerController.signal),
    );
    void attempt.catch(() => {});
    const deadline = Date.now() + peerWaitMs;

    try {
      while (wanted.length > 0 && Date.now() < deadline) {
        await recoveryDelay(250, signal);
        wanted = await currentWanted(wanted);
        onProgress?.({
          stage: 'peers',
          done: original.size - wanted.length,
          total: original.size,
        });
      }
    } finally {
      stopPeers();
      signal?.removeEventListener('abort', stopPeers);
    }
  }

  let unreadable = 0;
  let error: string | undefined;
  wanted = await currentWanted(wanted);

  if (wanted.length > 0) {
    onProgress?.({ stage: 'vault', done: 0, total: 0 });

    try {
      const restored = await guarded(
        restoreDriveBlobs({
          db,
          driveSubject,
          drivePseudonym,
          driveKey,
          keyEpoch,
          hashes: wanted,
          repairOnly: true,
          signal,
          beforeRestore: currentWanted,
          onProgress: (done, total) =>
            onProgress?.({ stage: 'vault', done, total }),
        }),
      );
      unreadable = restored?.unreadable ?? 0;
    } catch (failure) {
      await guard();
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }

  let total = original.size;
  const unresolved = await currentWanted(original, (_hash, present) => {
    if (!present) total--;
  });
  const result: FileRepairOutcome = {
    total,
    repaired: total - unresolved.length,
    missing: unresolved,
    unreadable,
    ...(error ? { error } : {}),
  };
  onProgress?.({
    stage: 'complete',
    done: result.repaired,
    total: result.total,
  });

  return result;
}

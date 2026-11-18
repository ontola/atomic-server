import { canonicalizeScheme } from '@tomic/lib';
import { restoreDriveBlobs, type VaultCapableDb } from './vault';

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

  const guard = async () => {
    signal?.throwIfAborted();
    await throwIfStale?.();
    signal?.throwIfAborted();
  };

  const referenced = async () => {
    await guard();
    const hashes = await db.vaultFileHashes(driveSubject);
    await guard();

    return [...new Set(hashes.map(hash => hash.toLowerCase()))];
  };

  const missing = async (hashes: string[]) => {
    const absent: string[] = [];

    for (const hash of hashes) {
      await guard();
      if (!(await db.vaultBlobPresent(hash))) absent.push(hash);
    }

    await guard();

    return absent;
  };

  onProgress?.({ stage: 'scanning', done: 0, total: 0 });
  const requested = requestedHashes
    ? new Set(requestedHashes.map(hash => hash.toLowerCase()))
    : undefined;
  const original = new Set(
    await missing(
      (await referenced()).filter(hash => !requested || requested.has(hash)),
    ),
  );
  let wanted = [...original];

  const currentWanted = async (candidates: string[]) => {
    const current = new Set(await referenced());

    return missing(candidates.filter(hash => current.has(hash)));
  };

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
        await pause(250, signal);
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
      const restored = await restoreDriveBlobs({
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
      });
      unreadable = restored?.unreadable ?? 0;
    } catch (failure) {
      await guard();
      error = failure instanceof Error ? failure.message : String(failure);
    }
  }

  const current = (await referenced()).filter(hash => original.has(hash));
  const unresolved = await missing(current);
  const result: FileRepairOutcome = {
    total: current.length,
    repaired: current.length - unresolved.length,
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

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();

  return new Promise((resolve, reject) => {
    const cancel = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };

    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

// @wc-ignore-file
import { canonicalIdentifier, StoreEvents, type Store } from '@tomic/lib';
import { isRunningInTauri } from '../tauri';
import {
  nodeVault,
  onNodeFileContents,
  requestNodeFileContents,
} from './nodeVault';
import {
  getManagedAccount,
  onManagedLogout,
  onManagedSessionChanged,
} from './session';
import {
  agentVaultProof,
  listVaultDrives,
  recoverDriveKey,
  type DriveKeyHandle,
  type VaultCapableDb,
} from './vault';
import { canRepairDriveFiles, repairDriveFiles } from './vaultFileRepair';
import { loadVaultKeyOps } from './vaultKeyOps';
import { onVaultChanged } from './vaultAutoBackup';
import {
  recoveryAwait,
  recoveryDelay,
  scanMissingReferenced,
} from './fileRecoveryRuntime';

type Credentials = DriveKeyHandle & { drivePseudonym: string };
type RecoveryDeps = {
  db: (store: Store) => VaultCapableDb | null;
  peers: (
    store: Store,
    drive: string,
    hashes: string[],
    signal: AbortSignal,
  ) => Promise<void>;
  account: (fresh?: boolean) => Promise<string | null>;
  credentials: (
    store: Store,
    drive: string,
    signal: AbortSignal,
  ) => Promise<Credentials | null>;
  repair: typeof repairDriveFiles;
  onFilesStored?: (callback: (hash: string | null) => void) => () => void;
};

const defaults: RecoveryDeps = {
  db: store => (isRunningInTauri() ? nodeVault : (store.getClientDb() ?? null)),
  peers: (store, drive, hashes, signal) =>
    isRunningInTauri()
      ? requestNodeFileContents(drive, hashes, signal)
      : store.requestMissingFileContents(drive, hashes, signal),
  account: async fresh => (await getManagedAccount({ fresh }))?.email ?? null,
  credentials: async (store, drive, signal) => {
    const listed = await listVaultDrives();
    signal.throwIfAborted();
    const enrollment = listed.find(
      item => canonicalIdentifier(item.drive_subject) === drive,
    );
    const agent = store.getAgent();
    if (!enrollment || !agent) return null;
    const keys = await loadVaultKeyOps();
    signal.throwIfAborted();
    const proof = await agentVaultProof(agent, keys.proofMessage);
    signal.throwIfAborted();
    const key = await recoverDriveKey({
      keys,
      drivePseudonym: enrollment.drive_pseudonym,
      agentSecret: proof,
    });
    signal.throwIfAborted();

    return { ...key, drivePseudonym: enrollment.drive_pseudonym };
  },
  repair: repairDriveFiles,
  onFilesStored: onNodeFileContents,
};

type Pending = {
  promise: Promise<boolean>;
  resolve: (present: boolean) => void;
};
type DriveJob = {
  pending: Map<string, Pending>;
  running: boolean;
  timer?: ReturnType<typeof setTimeout>;
  retryAfter: Map<string, number>;
};

/** One session owns the queue, so mounting several images shares one recovery. */
export function startAutomaticFileRecovery(
  store: Store,
  deps: RecoveryDeps = defaults,
): () => void {
  const drives = new Map<string, DriveJob>();
  const credentials = new Map<string, Credentials | null>();
  let controller = new AbortController();
  let knownDb = deps.db(store);
  let knownAgent = store.getAgent();
  let knownDrive = store.getDrive();
  let disposed = false;

  const reset = () => {
    controller.abort();

    for (const job of drives.values()) {
      clearTimeout(job.timer);
      for (const pending of job.pending.values()) pending.resolve(false);
    }

    drives.clear();
    credentials.clear();
    knownDb = deps.db(store);
    knownAgent = store.getAgent();
    knownDrive = store.getDrive();
    controller = new AbortController();
    store.retryFileContentRecovery();
  };

  // A stored file must not wait behind a different file's slow Vault request.
  const probePresent = async (
    drive: string,
    job: DriveJob,
    hash: string,
    pending: Pending,
  ) => {
    const scope = controller;
    const db = deps.db(store);
    const agent = store.getAgent();
    const selected = store.getDrive();
    const current = () =>
      !disposed &&
      !scope.signal.aborted &&
      controller === scope &&
      deps.db(store) === db &&
      store.getAgent() === agent &&
      store.getDrive() === selected &&
      drives.get(drive) === job &&
      job.pending.get(hash) === pending;

    if (!canRepairDriveFiles(db) || !agent) return;

    try {
      const guard = () => {
        if (!current())
          throw new DOMException('The recovery changed.', 'AbortError');
      };

      let resolved: boolean | undefined;
      await recoveryAwait(
        scanMissingReferenced(db, drive, [hash], guard, (_hash, present) => {
          resolved = present;
        }),
        scope.signal,
        guard,
      );
      if (resolved === undefined) return;
      pending.resolve(resolved);
      job.pending.delete(hash);
    } catch {
      // The ordinary bounded job remains responsible for failures.
    }
  };

  const run = async (drive: string, job: DriveJob) => {
    const db = deps.db(store);
    const agent = store.getAgent();
    const selected = store.getDrive();
    const scope = controller;
    const work = new AbortController();
    const { signal } = work;
    const abortScope = () => work.abort(scope.signal.reason);
    scope.signal.addEventListener('abort', abortScope, { once: true });
    const timeout = setTimeout(
      () =>
        work.abort(
          new DOMException('File recovery timed out.', 'TimeoutError'),
        ),
      30_000,
    );

    const assertCurrent = () => {
      signal.throwIfAborted();

      if (
        disposed ||
        deps.db(store) !== db ||
        store.getAgent() !== agent ||
        store.getDrive() !== selected
      ) {
        throw new DOMException('The account or drive changed.', 'AbortError');
      }
    };

    const settle = (hash: string, present: boolean) => {
      job.pending.get(hash)?.resolve(present);
      job.pending.delete(hash);
    };

    const guarded = <T>(operation: Promise<T> | T) =>
      recoveryAwait(operation, signal, assertCurrent);

    let attempted = [...job.pending.keys()];

    try {
      if (!canRepairDriveFiles(db) || !agent) return;

      const missing = () =>
        guarded(
          scanMissingReferenced(
            db,
            drive,
            job.pending.keys(),
            assertCurrent,
            settle,
          ),
        );

      const asked = new Set<string>();
      const deadline = Date.now() + 5_000;
      let hashes = await missing();

      while (hashes.length > 0 && Date.now() < deadline) {
        const next = hashes.filter(hash => !asked.has(hash));
        next.forEach(hash => asked.add(hash));
        if (next.length)
          void deps.peers(store, drive, next, signal).catch(() => {});
        await recoveryDelay(250, signal);
        hashes = await missing();
      }

      if (hashes.length === 0) return;
      attempted = hashes;
      const account = await guarded(deps.account(true));
      if (!account) return;
      const cacheKey = `${account}|${drive}`;

      if (!credentials.has(cacheKey)) {
        const recovered = await guarded(deps.credentials(store, drive, signal));
        credentials.set(cacheKey, recovered);
      }

      const key = credentials.get(cacheKey);
      if (!key) return;

      const throwIfStale = async () => {
        assertCurrent();
        if ((await guarded(deps.account())) !== account)
          throw new DOMException('The account changed.', 'AbortError');
      };

      await throwIfStale();
      await guarded(
        deps.repair({
          db,
          driveSubject: drive,
          ...key,
          hashes,
          peerWaitMs: 0,
          signal,
          throwIfStale,
          tryPeers: async () => {},
        }),
      );
      await throwIfStale();
      await missing();
      if (attempted.some(hash => job.pending.has(hash)))
        credentials.delete(cacheKey);
    } catch {
      credentials.clear();
      // The awaiting preview keeps its fallback. A later retry can try again.
    } finally {
      clearTimeout(timeout);
      scope.signal.removeEventListener('abort', abortScope);
      work.abort();
      job.running = false;

      if (!scope.signal.aborted && !disposed) {
        for (const hash of attempted) {
          if (job.pending.has(hash)) {
            settle(hash, false);
            job.retryAfter.set(hash, Date.now() + 60_000);
          }
        }

        if (job.pending.size > 0) schedule(drive, job);
      }
    }
  };

  const schedule = (drive: string, job: DriveJob) => {
    if (job.running || job.timer) return;

    job.timer = setTimeout(() => {
      job.timer = undefined;
      job.running = true;
      void run(drive, job);
    }, 100);
  };

  const removeHandler = store.setFileContentRecovery((hash, hint) => {
    if (disposed || !/^[0-9a-f]{64}$/i.test(hash))
      return Promise.resolve(false);
    if (
      deps.db(store) !== knownDb ||
      store.getAgent() !== knownAgent ||
      store.getDrive() !== knownDrive
    )
      reset();
    const drive = canonicalIdentifier(hint ?? store.getDrive() ?? '');
    if (!drive || !canRepairDriveFiles(deps.db(store)))
      return Promise.resolve(false);
    let job = drives.get(drive);

    if (!job) {
      job = { pending: new Map(), running: false, retryAfter: new Map() };
      drives.set(drive, job);
    }

    hash = hash.toLowerCase();
    if (Date.now() < (job.retryAfter.get(hash) ?? 0))
      return Promise.resolve(false);
    const existing = job.pending.get(hash);
    if (existing) return existing.promise;
    let resolve!: Pending['resolve'];
    const promise = new Promise<boolean>(settle => {
      resolve = settle;
    });
    const pending = { promise, resolve };
    job.pending.set(hash, pending);
    if (job.running) void probePresent(drive, job, hash, pending);
    schedule(drive, job);

    return promise;
  });
  const offAgent = store.on(StoreEvents.AgentChanged, reset);
  const offDrive = store.on(StoreEvents.DriveChanged, reset);
  const offDb = store.on(StoreEvents.SyncStatusChanged, () => {
    if (deps.db(store) !== knownDb) reset();
  });
  const offSession = onManagedSessionChanged(reset);
  const offLogout = onManagedLogout(reset);
  const offVault = onVaultChanged(changed => {
    credentials.clear();
    const job = drives.get(canonicalIdentifier(changed));

    if (job && !job.running) {
      job.retryAfter.clear();
      store.retryFileContentRecovery();
    }
  });
  const offFilesStored = deps.onFilesStored?.(hash => {
    if (disposed) return;

    if (
      deps.db(store) !== knownDb ||
      store.getAgent() !== knownAgent ||
      store.getDrive() !== knownDrive
    ) {
      reset();

      return;
    }

    for (const [drive, job] of drives) {
      if (hash === null) job.retryAfter.clear();
      else job.retryAfter.delete(hash);

      for (const [pendingHash, pending] of job.pending) {
        if (hash === null || hash === pendingHash)
          void probePresent(drive, job, pendingHash, pending);
      }
    }

    store.retryFileContentRecovery(hash ?? undefined);
  });
  window.addEventListener('online', reset);
  window.addEventListener('pagehide', reset);

  return () => {
    disposed = true;
    reset();
    removeHandler();
    offAgent();
    offDrive();
    offDb();
    offSession();
    offLogout();
    offVault();
    offFilesStored?.();
    window.removeEventListener('online', reset);
    window.removeEventListener('pagehide', reset);
  };
}

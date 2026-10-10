import { resolveDriveOrigins } from '@tomic/lib';
import { probeServer } from './probeServer';
import { serverURLStorage } from './serverURLStorage';
import { isRunningInTauri } from './tauri';

/** Resolving (6 s) and probing (5 s) are bounded by one deadline. */
const DISCOVERY_DEADLINE_MS = 12_000;

type DiscoveryStore = {
  getServerUrl(): string | undefined;
  setServerUrl(url: string): void;
  unregisterLocalOnlyDrive(drive: string): void;
  waitForServerConnected(timeoutMs: number): Promise<boolean>;
};

/** The parts that touch the network or the device, replaceable in a test. */
export type DiscoveryDeps = {
  /** The server was picked by the person, never inferred. */
  wasExplicitlyChosen: () => boolean;
  /** The app runs in the desktop shell with a node of its own. */
  hasEmbeddedNode: () => boolean;
  /** Whether the server in use already serves this drive. */
  hasDriveData: (drive: string) => Promise<boolean>;
  resolveOrigins: (drive: string) => Promise<string[]>;
  probe: (origin: string) => Promise<'node' | 'not-node' | 'unreachable'>;
};

const defaultDeps = (
  hasDriveData: DiscoveryDeps['hasDriveData'],
): DiscoveryDeps => ({
  wasExplicitlyChosen: () => serverURLStorage.wasExplicitlyChosen(),
  hasEmbeddedNode: () => isRunningInTauri(),
  hasDriveData,
  resolveOrigins: drive => resolveDriveOrigins(drive),
  probe: origin => probeServer(origin),
});

function sameOrigin(a: string | undefined, b: string): boolean {
  try {
    return !!a && new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

/**
 * After a secret sign-in on a device that knows no server for the person's
 * drive, ask pkarr which servers announced it and move the app to the first
 * one that really is a node. No account and no typed address are involved:
 * the drive DID is enough to find the record.
 *
 * Does nothing (returns `false`) when
 *  - the person chose a server themselves, or the desktop shell runs its own,
 *  - the server in use already has the drive (an already restored session
 *    must not be switched),
 *  - pkarr names no origin that answers like an AtomicServer,
 *  - or anything fails or takes longer than the deadline.
 *
 * It never throws and never connects after the deadline has passed, so a slow
 * lookup cannot move a session that carried on without it.
 */
export async function discoverHomeServer(
  store: DiscoveryStore,
  drive: string,
  persistServer: (url: string) => void,
  deps: DiscoveryDeps,
  deadlineMs = DISCOVERY_DEADLINE_MS,
): Promise<boolean> {
  if (deps.wasExplicitlyChosen() || deps.hasEmbeddedNode()) return false;

  let expired = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const lookup = async (): Promise<string | undefined> => {
    if (await deps.hasDriveData(drive)) return undefined;

    const origins = (await deps.resolveOrigins(drive)).filter(
      origin => !sameOrigin(store.getServerUrl(), origin),
    );

    // Probe together so one dead origin does not eat the whole deadline, but
    // keep the announced order when several answer.
    const probes = await Promise.all(origins.map(origin => deps.probe(origin)));

    return origins.find((_, i) => probes[i] === 'node');
  };

  try {
    const origin = await Promise.race([
      lookup().catch(() => undefined),
      new Promise<undefined>(resolve => {
        timer = setTimeout(() => {
          expired = true;
          resolve(undefined);
        }, deadlineMs);
      }),
    ]);

    // Re-check: the person may have chosen a server while we were asking.
    if (!origin || expired || deps.wasExplicitlyChosen()) return false;

    store.unregisterLocalOnlyDrive(drive);
    store.setServerUrl(origin);
    persistServer(origin);
    await store.waitForServerConnected(3_000);

    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
    expired = true;
  }
}

/** {@link discoverHomeServer} with the real network and device behind it. */
export function discoverHomeServerForApp(
  store: DiscoveryStore,
  drive: string,
  persistServer: (url: string) => void,
  hasDriveData: DiscoveryDeps['hasDriveData'],
): Promise<boolean> {
  return discoverHomeServer(
    store,
    drive,
    persistServer,
    defaultDeps(hasDriveData),
  );
}

import { signRequest, type Agent, type Store } from '@tomic/lib';

/** Compare the local drive hash and verify its file contents on the server. */
export async function confirmDriveCopy(
  store: Store,
  drive: string,
  server: string,
  agent: Agent,
  signal: AbortSignal,
  eligible: () => boolean,
): Promise<boolean | undefined> {
  const db = store.getClientDb();
  if (
    !db?.isReady ||
    db.initError ||
    typeof db.flush !== 'function' ||
    typeof db.getVersionVectorsForDrive !== 'function'
  )
    return;
  const current = () =>
    !signal.aborted &&
    store.getClientDb() === db &&
    db.isReady &&
    !db.initError &&
    eligible();
  if (!current()) return;

  const normalized = store.normalizeSubject(drive);
  await db.flush();
  if (!current()) return;
  const state = await store.computeDriveSyncState(normalized, { sparse: true });
  if (
    !current() ||
    state.hashVersion !== 2 ||
    !state.vvs ||
    !/^[0-9a-f]{64}$/.test(state.driveHash)
  )
    return;
  const url = new URL('/drive-sync-confirmation', server);
  url.searchParams.set('subject', normalized);
  url.searchParams.set('hash', state.driveHash);
  url.searchParams.set('hashVersion', '2');
  const headers = await signRequest(url.toString(), agent, {
    Accept: 'application/json',
  });
  if (!current()) return;
  const response = await fetch(url.toString(), {
    headers,
    cache: 'no-store',
    redirect: 'error',
    signal,
  });
  // A concurrent server mutation deliberately provides no proof or JSON body.
  if (response.status === 204 || !response.ok || !current()) return;
  const data: unknown = await response.json();
  if (!current() || !data || typeof data !== 'object') return;
  const result = data as Record<string, unknown>;
  if (
    result.version !== 1 ||
    result.drive !== normalized ||
    result.hashVersion !== 2 ||
    typeof result.driveHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(result.driveHash) ||
    !Number.isSafeInteger(result.checkedBlobs) ||
    (result.checkedBlobs as number) < 0 ||
    typeof result.confirmed !== 'boolean'
  )
    return;

  if (!result.confirmed) return false;

  return result.driveHash === state.driveHash ? true : undefined;
}

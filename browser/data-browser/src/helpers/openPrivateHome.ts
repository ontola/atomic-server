import type { Store } from '@tomic/lib';
import { deviceHasDriveData } from './driveData';
import { isOriginWithoutNode } from './originNode';
import { restoreFromVault } from './managed/vaultAutoBackup';
import { withDeadline } from './withDeadline';

const pending = new WeakMap<
  Store,
  Map<string, Promise<'existing' | 'created' | undefined>>
>();

/** Recover before creating; only the current identity's own home may be created. */
export function openPrivateHome(
  store: Store,
  subject: string,
  recoveryAttempted = false,
): Promise<'existing' | 'created' | undefined> {
  let homes = pending.get(store);

  if (!homes) {
    homes = new Map();
    pending.set(store, homes);
  }

  const key = `${store.getAgent()?.subject}:${subject}`;
  const existing = homes.get(key);
  if (existing) return existing;
  const opening = prepare(store, subject, recoveryAttempted).finally(() =>
    homes.delete(key),
  );
  homes.set(key, opening);

  return opening;
}

async function prepare(
  store: Store,
  subject: string,
  recoveryAttempted: boolean,
): Promise<'existing' | 'created' | undefined> {
  const agent = store.getAgent();
  if (!agent || (await store.privateDriveSubject()) !== subject) return;
  if (await deviceHasDriveData(store, subject)) return 'existing';

  if (!recoveryAttempted) {
    await withDeadline(
      restoreFromVault(store, subject),
      8_000,
      undefined,
    ).catch(() => undefined);
    if (await deviceHasDriveData(store, subject)) return 'existing';
  }

  // A sign-out or another sign-in during recovery must not create that
  // identity's home on behalf of the new session.
  if (store.getAgent() !== agent) return;
  await store.ensurePrivateDrive('My drive', {
    localOnly: isOriginWithoutNode(store.getServerUrl()),
  });

  return 'created';
}

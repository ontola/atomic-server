import { core, type Resource, type Store } from '@tomic/lib';
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

  const name = agent.subject
    ? await ownerName(store, agent.subject)
    : undefined;

  // A sign-out or another sign-in during recovery must not create that
  // identity's home on behalf of the new session.
  if (store.getAgent() !== agent) return;
  // No literal for the unnamed case: `ensurePrivateDrive` already defaults it,
  // inside the library, where the i18n extractor cannot turn a plain string
  // into an injected hook in this non-component function. `undefined` is how a
  // default parameter is asked for, so the title stays one call. `InvitePage`
  // leaves the name out for the same reason.
  await store.ensurePrivateDrive(name ? `${name}'s Drive` : undefined, {
    localOnly: isOriginWithoutNode(store.getServerUrl()),
  });

  return 'created';
}

/**
 * The owner's own name, as the Agent resource carries it.
 *
 * A title only lands while the drive is being created: `ensurePrivateDrive`
 * returns an existing home untouched, so a name that arrives a moment later
 * never reaches it. A returning session may not have read its Agent yet, so
 * this is worth a fetch, but not worth holding the user out of their
 * workspace for, hence the budget and the silent fallback to the default.
 */
async function ownerName(
  store: Store,
  agentSubject: string,
): Promise<string | undefined> {
  // Everything inside the guard, not just the promise: `withDeadline` swallows
  // a rejection, but `getResource` can also throw before there is a promise to
  // swallow. A name is a nicety and creating the home is not, so nothing here
  // may be the reason someone is left without one.
  try {
    const agentResource = await withDeadline<Resource | undefined>(
      store.getResource(agentSubject),
      2_000,
      undefined,
    );

    const name = agentResource?.get(core.properties.name);

    return typeof name === 'string' && name.trim() ? name.trim() : undefined;
  } catch {
    return undefined;
  }
}

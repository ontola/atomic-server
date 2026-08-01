import { Agent, Store, core } from '@tomic/react';

/**
 * Resolves the agent's personal home drive: `personalDrive` on the Agent
 * resource when present, else `initialDrive` from the secret.
 *
 * Deliberately does NOT fall back to the first entry of `drives`. That list is
 * every drive the user owns, in no meaningful order, and on a pre-DID account
 * the server synthesises the DID Agent from the legacy one — so `drives` is
 * populated while `personalDrive` is not. Taking `drives[0]` then promotes an
 * arbitrary drive to "Private drive" and redirects sign-in into it, which is
 * both wrong and destructive-looking: the user is dropped somewhere unexpected
 * and their real list appears to have collapsed to one entry.
 *
 * Returning undefined is the honest answer, and it is handled: the caller
 * falls through to whatever lives at `/`, and `adoptLegacyDriveList`
 * provisions a real private drive on sign-in.
 *
 * Always fetches the agent resource fresh from the server. Signing in on a
 * device that has none of the account's data resolves the agent to a
 * synthesized stub (derived from the DID's public key) that carries no
 * `personalDrive` — and that stub gets cached. When the drive later lands on
 * the server (a paired device pushed the real agent resource with it), a
 * cached read would keep returning the stub, so the workspace would never be
 * found. A forced read sees the real one.
 *
 * Skip that forced fetch for local-only agents (e.g. the demo's guest
 * identity, see `chunks/Demo/guestAgent.ts`): they never exist on any
 * server, so the fetch is a guaranteed failure. Worse, `fetchResourceFromServer`
 * writes straight into the store's shared resource cache — every OTHER
 * consumer of `useResource(agent.subject)` (message authors, avatars) reads
 * that same entry, so this call's failure flashes "Error loading resource"
 * everywhere that subject is displayed, not just here.
 */
export async function fetchPersonalDriveSubject(
  store: Store,
  agent: Agent,
): Promise<string | undefined> {
  if (!agent.subject) {
    return agent.initialDrive;
  }

  if (store.isLocalOnlySubject(agent.subject)) {
    return agent.initialDrive;
  }

  try {
    const r = await store.fetchResourceFromServer(agent.subject, {
      noWebSocket: true,
    });

    if (r.error) {
      return agent.initialDrive;
    }

    const personal = r.get(core.properties.personalDrive);

    if (typeof personal === 'string' && personal.length > 0) {
      return personal;
    }
  } catch {
    // ignore fetch errors; fall back below
  }

  return agent.initialDrive;
}

import { Agent, Store } from '@tomic/react';

/**
 * Resolves the agent's personal home drive: the DID derived from the Agent
 * key. Same secret → same subject on every device. The Agent's
 * `personalDrive` pointer is not identity.
 *
 * Local-only / unsigned agents still fall back to `initialDrive`.
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
    return await agent.personalDriveSubject();
  } catch {
    // `initialDrive` travels with an old secret and is usually an http(s) URL
    // on the server the account is migrating away from. Handing that to
    // `setDrive` does not open a drive — it is read as a SERVER ORIGIN and
    // repoints the whole app at that server, which then cannot authenticate
    // this agent or serve any of its `did:ad:` resources. Signing in must not
    // be able to move the app's server as a side effect of a failed
    // derivation, so only a same-origin fallback is usable here.
    if (!agent.initialDrive) return undefined;

    if (!/^https?:\/\//.test(agent.initialDrive)) return agent.initialDrive;

    try {
      const sameServer =
        new URL(agent.initialDrive).origin ===
        new URL(store.getServerUrl()).origin;

      return sameServer ? agent.initialDrive : undefined;
    } catch {
      return undefined;
    }
  }
}

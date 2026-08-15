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
    return agent.initialDrive;
  }
}

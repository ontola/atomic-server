import { Agent, Store } from '@tomic/react';

/**
 * Resolves the agent's personal home drive: the DID derived from the Agent
 * key. Same secret → same subject on every device. The Agent's
 * `personalDrive` pointer is not identity.
 *
 * Materializes it as well as deriving it. Deriving cannot fail — it is
 * arithmetic on the key, and it answers for a drive that has never existed —
 * so returning the bare subject let callers link somewhere the store had
 * nothing for, and the drive rendered as "Resource not found ... not found
 * locally". The subject is a fact about the identity; the resource is not, and
 * only one of the two comes for free.
 *
 * `ensurePersonalDrive` is idempotent and merges a repeat genesis, so this
 * writes once per account and then returns what is already there.
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
    const drive = await store.ensurePersonalDrive();

    if (!drive.error) {
      return drive.subject;
    }

    // Materializing failed (offline, or the server refused the write). The
    // derived subject is still the right answer — a later read can resolve it
    // once the drive exists — so fall back to it rather than to a stale
    // pointer.
    return await agent.personalDriveSubject();
  } catch {
    return agent.initialDrive;
  }
}

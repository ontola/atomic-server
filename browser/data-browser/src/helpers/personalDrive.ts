import { Agent, Store, core, server } from '@tomic/react';

/**
 * Resolves the agent's personal home drive: `personalDrive` on the Agent resource
 * when present, else first entry in `drives`, else `initialDrive` from the secret.
 *
 * Always fetches the agent resource fresh from the server. Signing in on a
 * device that has none of the account's data resolves the agent to a
 * synthesized stub (derived from the DID's public key) that carries no
 * `personalDrive` — and that stub gets cached. When the drive later lands on
 * the server (a paired device pushed the real agent resource with it), a
 * cached read would keep returning the stub, so the workspace would never be
 * found. A forced read sees the real one.
 */
export async function fetchPersonalDriveSubject(
  store: Store,
  agent: Agent,
): Promise<string | undefined> {
  if (!agent.subject) {
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

    const drives = r.getSubjects(server.properties.drives);

    if (drives.length > 0) {
      return drives[0];
    }
  } catch {
    // ignore fetch errors; fall back below
  }

  return agent.initialDrive;
}

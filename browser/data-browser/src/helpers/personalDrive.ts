import { Agent, Store, core, server } from '@tomic/react';

/**
 * Resolves the agent's personal home drive: `personalDrive` on the Agent resource
 * when present, else first entry in `drives`, else `initialDrive` from the secret.
 */
export async function fetchPersonalDriveSubject(
  store: Store,
  agent: Agent,
): Promise<string | undefined> {
  if (!agent.subject) {
    return agent.initialDrive;
  }

  try {
    await store.fetchResourceFromServer(agent.subject);
    const r = store.getResourceLoading(agent.subject);

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

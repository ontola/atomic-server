import { core, useArray, type Resource } from '@tomic/react';
import type { ShareRole } from './RoleSelect';

export interface DirectRight {
  agentSubject: string;
  role: ShareRole;
}

/**
 * The read and write rights set directly on `resource`, one entry per agent,
 * and a setter that saves right away. The Share dialog has no Save button:
 * every change there is a single, deliberate pick from a menu.
 */
export function useShareRights(
  resource: Resource,
): [
  rights: DirectRight[],
  setRole: (agent: string, role: ShareRole | 'remove') => Promise<void>,
] {
  const valueOpts = { commit: false };
  const [writers] = useArray(resource, core.properties.write, valueOpts);
  const [readers] = useArray(resource, core.properties.read, valueOpts);

  const rights: DirectRight[] = [];

  for (const agent of new Set([...writers, ...readers])) {
    rights.push({
      agentSubject: agent,
      role: writers.includes(agent) ? 'write' : 'read',
    });
  }

  const setRole = async (agent: string, role: ShareRole | 'remove') => {
    const nextWriters = writers.filter(a => a !== agent);
    const nextReaders = readers.filter(a => a !== agent);

    if (role === 'write') {
      nextWriters.push(agent);
    }

    // Writers are listed as readers too, so no server has to infer read
    // access from write access.
    if (role !== 'remove') {
      nextReaders.push(agent);
    }

    await resource.set(core.properties.write, nextWriters);
    await resource.set(core.properties.read, nextReaders);
    await resource.save();
  };

  return [rights, setRole];
}

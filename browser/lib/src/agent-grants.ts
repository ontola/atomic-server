import { core } from './ontologies/core.js';
import type { Store } from './store.js';

/**
 * Rights a person gives an Agent that holds its own key (an app that made a
 * keypair and asked to be allowed, like the Atomic MCP server).
 *
 * Only an agent may edit its own Agent resource, so nothing about the grant
 * can be written there. The ACLs on the shared resources are the record:
 * both sides find the grants by searching for resources whose `read` or
 * `write` lists the agent. Search only returns what the searcher may read,
 * so the app sees what it was given and the person sees what they gave.
 */

export interface AgentGrant {
  subject: string;
  /** Granted by the person. Without it, the key holds `write` only because
   * it created the resource (the server adds a creator to `write`). */
  read: boolean;
  write: boolean;
}

/** Add `agent` to `read` (and `write`) on each target. */
export async function grantAgent(
  store: Store,
  agent: string,
  targets: string[],
  write: boolean,
): Promise<void> {
  for (const target of targets) {
    const resource = await store.getResource(target);

    if (resource.error) {
      throw resource.error;
    }

    resource.push(core.properties.read, [agent], true);

    if (write) {
      resource.push(core.properties.write, [agent], true);
    }

    await resource.save();
  }
}

/** The resources whose ACL names `agent`, as far as the store's agent can see. */
export async function grantsTo(
  store: Store,
  agent: string,
): Promise<AgentGrant[]> {
  const [readable, writable] = await Promise.all(
    [core.properties.read, core.properties.write].map(property =>
      store.search('', { filters: { [property]: agent }, limit: 500 }),
    ),
  );

  return [...new Set([...readable, ...writable])].map(subject => ({
    subject,
    read: readable.includes(subject),
    write: writable.includes(subject),
  }));
}

/**
 * Take `agent` off every resource that grants it, including what it created
 * itself. Reports what failed, so a caller never says "revoked" while access
 * remains.
 */
export async function revokeAgent(
  store: Store,
  agent: string,
): Promise<{
  revoked: string[];
  failed: { subject: string; reason: string }[];
}> {
  const revoked: string[] = [];
  const failed: { subject: string; reason: string }[] = [];

  for (const { subject } of await grantsTo(store, agent)) {
    try {
      const resource = await store.getResource(subject);

      for (const property of [core.properties.read, core.properties.write]) {
        const current = (resource.get(property) as string[] | undefined) ?? [];

        if (current.includes(agent)) {
          await resource.set(
            property,
            current.filter(s => s !== agent),
          );
        }
      }

      await resource.save();
      revoked.push(subject);
    } catch (e) {
      failed.push({
        subject,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { revoked, failed };
}

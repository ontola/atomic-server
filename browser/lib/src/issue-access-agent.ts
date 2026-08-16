import { Agent } from './agent.js';
import { core } from './ontologies/core.js';
import type { Store } from './store.js';
import { instances } from './urls.js';

export const REVOKED_NAME_SUFFIX = ' (revoked)';

export interface IssueAccessAgentOpts {
  /** Shown in the App keys list and on the public Agent resource. */
  name: string;
  description?: string;
  /** When true, the new agent is added to `write` as well as `read`. */
  write: boolean;
  /** Workspace (or other ACL-bearing resource) subjects to grant. */
  targets: string[];
  /** App keys folder — or any private parent that should own the registry row. */
  parent?: string;
}

export interface IssuedAccessAgent {
  subject: string;
  secret: string;
}

/**
 * Mint a new Agent, publish its public resource, and grant it rights on the
 * given targets — without switching the store's current agent.
 *
 * The new secret is returned once and is not stored. The caller shows it;
 * lost secrets are rotated by minting again and revoking this one.
 */
export async function issueAccessAgent(
  store: Store,
  opts: IssueAccessAgentOpts,
): Promise<IssuedAccessAgent> {
  const current = store.getAgent();

  if (!current?.subject) {
    throw new Error('Cannot issue an app key while signed out');
  }

  const name = opts.name.trim();

  if (!name) {
    throw new Error('App keys need a name');
  }

  if (opts.targets.length === 0) {
    throw new Error('Choose at least one workspace');
  }

  const keys = await Agent.generateKeyPair();
  const subject = `did:ad:agent:${keys.publicKey}`;

  const resource = await store.newResource({
    subject,
    parent: opts.parent,
    noParent: !opts.parent,
    isA: core.classes.agent,
    propVals: {
      [core.properties.publicKey]: keys.publicKey,
      [core.properties.name]: name,
      [core.properties.read]: [instances.publicAgent],
      ...(opts.description
        ? { [core.properties.description]: opts.description }
        : {}),
    },
  });
  await resource.save();
  await store.notifyResourceManuallyCreated(resource);

  await grantAccessAgent(store, subject, opts.targets, opts.write);

  return {
    subject,
    secret: Agent.buildSecret(keys.privateKey, subject),
  };
}

/**
 * Add an existing issued agent to more workspaces. Does not mint a secret.
 */
export async function grantAccessAgent(
  store: Store,
  agentSubject: string,
  targets: string[],
  write: boolean,
): Promise<void> {
  for (const target of targets) {
    const resource = await store.getResource(target);
    resource.push(core.properties.read, [agentSubject], true);

    if (write) {
      resource.push(core.properties.write, [agentSubject], true);
    }

    await resource.save();
  }
}

/** What a revocation actually managed to do. */
export interface RevokeReport {
  /** Targets this key was removed from, confirmed by re-reading the ACL. */
  revoked: string[];
  /** Targets checked that did not grant this key in the first place. */
  untouched: string[];
  /** Targets still granting this key, and why. ACCESS PERSISTS on these. */
  failed: { target: string; reason: string }[];
}

/**
 * Remove an issued agent from the given targets' ACLs and mark its profile
 * revoked. The Agent resource is kept — old commits still need the public key.
 *
 * Returns what it managed to do rather than succeeding silently. A revoke that
 * quietly leaves access behind is worse than one that fails loudly: the user
 * reads "Key revoked", stops worrying, and the secret still opens their
 * workspaces. So every target is verified by re-reading its ACL after the
 * save, an unreachable target is reported instead of aborting the rest, and
 * the profile is only marked revoked when nothing was left behind.
 *
 * Note the ceiling on what this can promise: `targets` is supplied by the
 * caller, and grants live on each workspace rather than on the key. A grant on
 * a workspace outside that list survives and cannot be seen from here — the
 * caller must pass every target it knows of, and say what it checked.
 */
export async function revokeAccessAgent(
  store: Store,
  agentSubject: string,
  targets: string[],
): Promise<RevokeReport> {
  const report: RevokeReport = { revoked: [], untouched: [], failed: [] };

  for (const target of targets) {
    try {
      const resource = await store.getResource(target);

      if (resource.error) {
        throw resource.error;
      }

      if (!grantsAgent(resource, agentSubject)) {
        report.untouched.push(target);
        continue;
      }

      await removeFromRights(resource, core.properties.read, agentSubject);
      await removeFromRights(resource, core.properties.write, agentSubject);
      await resource.save();

      // Confirm rather than assume: a save can be rejected by rights or fail
      // to reach the server, and the in-memory resource would still look
      // edited.
      const after = await store.getResource(target);

      if (after.error || grantsAgent(after, agentSubject)) {
        throw new Error('the workspace still grants this key after saving');
      }

      report.revoked.push(target);
    } catch (e) {
      report.failed.push({
        target,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // Only claim the key is dead when it is. A "(revoked)" label on a key that
  // still opens a workspace is exactly the lie this function exists to avoid.
  if (report.failed.length === 0) {
    const agentResource = await store.getResource(agentSubject);
    const name = (
      agentResource.get(core.properties.name) as string | undefined
    )?.trim();

    if (name && !isRevokedAccessAgentName(name)) {
      await agentResource.set(
        core.properties.name,
        `${name}${REVOKED_NAME_SUFFIX}`,
      );
      await agentResource.save();
    }
  }

  return report;
}

/** Whether `resource` currently lists `agentSubject` in read or write. */
function grantsAgent(
  resource: Awaited<ReturnType<Store['getResource']>>,
  agentSubject: string,
): boolean {
  return [core.properties.read, core.properties.write].some(property =>
    ((resource.get(property) as string[] | undefined) ?? []).includes(
      agentSubject,
    ),
  );
}

export function isRevokedAccessAgentName(name: string): boolean {
  return name.endsWith(REVOKED_NAME_SUFFIX);
}

async function removeFromRights(
  resource: Awaited<ReturnType<Store['getResource']>>,
  property: string,
  agentSubject: string,
): Promise<void> {
  const current = (resource.get(property) as string[] | undefined) ?? [];

  if (!current.includes(agentSubject)) {
    return;
  }

  await resource.set(
    property,
    current.filter(subject => subject !== agentSubject),
  );
}

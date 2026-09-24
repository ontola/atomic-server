// @wc-ignore-file
/**
 * Registering an Installation's runtimes with the integration proxy
 * (#1700, answers 1 and 2; ontola/atomic-plugins#54 decision 10).
 *
 * An Installation carries a keyless app id (`integrationAppAgent`). Nobody
 * signs as it: delegations and frame capabilities name it. Each node that
 * activates the Installation mints its own agent and publishes it on an
 * `InstallationRuntime` child. The proxy only lets such an agent use the
 * app's delegations once the owner has registered it as a runtime of the app
 * (`POST /runtimes {app, agent, label}`), which is what this does, signed with
 * the user key. `DELETE /runtimes/{agent}` undoes it when the Installation is
 * revoked or uninstalled.
 *
 * Everything here is idempotent and best effort: the proxy upserts runtimes,
 * a runtime already listed for the same app and label is not posted again,
 * and callers never wait on it before updating the UI.
 */
import {
  agentSubject,
  CollectionBuilder,
  core,
  server,
  type Resource,
  type Store,
} from '@tomic/react';
import { canonicalAgent, type ProxyConnections } from './proxyConnections';

/** A node's agent, as published on an `InstallationRuntime` child. */
export interface InstallationRuntime {
  subject: string;
  /** Canonical `atomic:agent:…`. */
  agent: string;
  /** The node's name, which becomes the runtime's label at the proxy. */
  label?: string;
}

function canonicalOrUndefined(id: unknown): string | undefined {
  if (typeof id !== 'string') return undefined;

  try {
    return canonicalAgent(id);
  } catch {
    return undefined;
  }
}

/** The Installation's app id (canonical), if it has one. */
export function installationAppId(resource: Resource): string | undefined {
  return canonicalOrUndefined(
    resource.get(server.properties.integrationAppAgent),
  );
}

/**
 * Reads `child` as a runtime of `installation`, or `undefined` when it is
 * not one. A runtime counts only when its genesis was signed by the agent it
 * names, as the node publishes it: an agent may only publish itself.
 */
export function asRuntime(
  child: Resource,
  installation: string,
): InstallationRuntime | undefined {
  if (!child.hasClasses(server.classes.installationRuntime)) return undefined;
  if (child.get(core.properties.parent) !== installation) return undefined;
  const agent = canonicalOrUndefined(
    child.get(server.properties.integrationRuntimeAgent),
  );
  if (!agent || canonicalOrUndefined(child.getCreatedBy()) !== agent)
    return undefined;
  const name = child.get(core.properties.name);

  return {
    subject: child.subject,
    agent,
    label: typeof name === 'string' && name ? name : undefined,
  };
}

/**
 * The runtimes published under `installation`. `children` skips the query
 * when the caller already has them (e.g. from `useChildren`).
 */
export async function readInstallationRuntimes(
  store: Store,
  installation: string,
  children?: readonly string[],
): Promise<InstallationRuntime[]> {
  const subjects =
    children ??
    (await new CollectionBuilder(store)
      .setProperty(core.properties.parent)
      .setValue(installation)
      .setPageSize(100)
      .build()
      .getAllMembers());
  const found: InstallationRuntime[] = [];

  for (const subject of subjects) {
    try {
      const runtime = asRuntime(await store.getResource(subject), installation);
      if (runtime) found.push(runtime);
    } catch {
      // A child that does not load is not a runtime we can register.
    }
  }

  return found;
}

/**
 * Registrations this page already made (or is making), keyed by proxy, owner,
 * app, agent and label, so reopening an Installation does not ask the proxy
 * again. A failed registration is forgotten, so the next trigger retries.
 */
const registered = new Map<string, { agent: string; done: Promise<void> }>();

const registrationKey = (
  connections: ProxyConnections,
  owner: string,
  app: string,
  runtime: InstallationRuntime,
) =>
  JSON.stringify([
    connections.origin,
    owner,
    app,
    runtime.agent,
    runtime.label ?? null,
  ]);

/** For tests. */
export function forgetRegisteredRuntimes() {
  registered.clear();
}

/**
 * Registers every runtime in `runtimes` as a runtime of `app` for the user
 * `owner`, skipping those the proxy already lists for the same app and label.
 * Returns the agents it posted. Rejects with the first proxy error.
 */
export async function registerRuntimes(
  connections: ProxyConnections,
  owner: string,
  app: string,
  runtimes: readonly InstallationRuntime[],
): Promise<string[]> {
  const appId = canonicalAgent(app);
  const ownerId = canonicalOrUndefined(owner);
  // The proxy refuses a runtime that is the app or the owner.
  const todo = runtimes.filter(
    r =>
      r.agent !== appId &&
      r.agent !== ownerId &&
      !registered.has(registrationKey(connections, owner, appId, r)),
  );
  if (todo.length === 0) return [];

  const listed = await connections.runtimes();
  const posted: string[] = [];

  await Promise.all(
    todo.map(runtime => {
      const key = registrationKey(connections, owner, appId, runtime);
      const inFlight = registered.get(key);
      if (inFlight) return inFlight.done;

      const known = listed.find(
        row => canonicalOrUndefined(row.agent) === runtime.agent,
      );
      const current =
        !!known &&
        canonicalOrUndefined(known.app) === appId &&
        (known.label ?? undefined) === runtime.label;
      const done = current
        ? Promise.resolve()
        : connections
            .registerRuntime(appId, runtime.agent, runtime.label)
            .then(() => {
              posted.push(runtime.agent);
            });
      registered.set(key, { agent: runtime.agent, done });
      done.catch(() => registered.delete(key));

      return done;
    }),
  );

  return posted;
}

/**
 * Removes each runtime at the proxy (`DELETE /runtimes/{agent}`). Tries them
 * all, then rejects with the first error.
 */
export async function unregisterRuntimes(
  connections: ProxyConnections,
  runtimes: readonly InstallationRuntime[],
): Promise<void> {
  const agents = new Set(runtimes.map(r => r.agent));

  for (const [key, entry] of registered) {
    if (agents.has(entry.agent)) registered.delete(key);
  }

  const results = await Promise.allSettled(
    [...agents].map(agent => connections.unregisterRuntime(agent)),
  );
  const failed = results.find(
    (r): r is PromiseRejectedResult => r.status === 'rejected',
  );
  if (failed) throw failed.reason;
}

/**
 * Registers `installation`'s runtimes with its app id. A no-op for anything
 * that is not an Installation with an app id (a `createApp` app, or an
 * Installation from before app ids), and when signed out.
 */
export async function registerInstallationRuntimes(
  store: Store,
  connections: ProxyConnections,
  installation: string,
  children?: readonly string[],
): Promise<string[]> {
  const agent = store.getAgent();
  if (!agent) return [];
  const resource = await store.getResource(installation);
  const app = installationAppId(resource);
  if (!app) return [];
  const runtimes = await readInstallationRuntimes(
    store,
    installation,
    children,
  );
  if (runtimes.length === 0) return [];
  const owner = agentSubject(await agent.getPublicKey());

  return registerRuntimes(connections, owner, app, runtimes);
}

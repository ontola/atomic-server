/**
 * The route grant: what an installer approves when a release's public
 * endpoints store what other servers send (design 2.6, D4; server side in
 * `server/src/plugins/manifest_http.rs` and `route_writes.rs`).
 *
 * Two things make a route write possible, and the install review does both:
 *
 * - The Installation's `grants` carries `{"route-writes": [write targets]}`,
 *   the release's `writeTargets` exactly as declared. `check_grants` accepts
 *   it next to the capability names, and activation refuses a release whose
 *   targets it does not list unchanged.
 * - The installation's agent may `write` each target's parent. The route
 *   applier checks `write` (not `append`) on the parent before it creates a
 *   child, and on the child before it changes or destroys one, so `write` on
 *   the parent is the narrowest right that works. It is a commit signed by
 *   the installer, and revoking or uninstalling takes it back.
 */
import { core } from './ontologies/core.js';
import { server } from './ontologies/server.js';
import type { DeclaredWriteTarget } from './plugin-manifest-http.js';
import type { Store } from './store.js';
import type { JSONValue } from './value.js';

/** The key of the route grant, as the server's `ROUTE_WRITES_GRANT`. */
export const ROUTE_WRITES_GRANT = 'route-writes';

/** One element of `Installation.grants`: a capability name or the route grant. */
export type InstallationGrant =
  | string
  | { [ROUTE_WRITES_GRANT]: DeclaredWriteTarget[] };

function isRouteGrantElement(
  item: unknown,
): item is { [ROUTE_WRITES_GRANT]: unknown } {
  return (
    !!item &&
    typeof item === 'object' &&
    !Array.isArray(item) &&
    Object.keys(item).length === 1 &&
    ROUTE_WRITES_GRANT in item
  );
}

function parseGrants(grants: unknown): unknown {
  if (typeof grants !== 'string') return grants;

  try {
    return JSON.parse(grants);
  } catch {
    return undefined;
  }
}

function asTargets(value: unknown): DeclaredWriteTarget[] | undefined {
  if (!Array.isArray(value)) return undefined;

  return value.filter(
    (t): t is DeclaredWriteTarget =>
      !!t &&
      typeof t === 'object' &&
      typeof (t as DeclaredWriteTarget).id === 'string' &&
      typeof (t as DeclaredWriteTarget).parent === 'string' &&
      Array.isArray((t as DeclaredWriteTarget).classes),
  );
}

/**
 * The write targets an Installation's `grants` approve, in either form the
 * server accepts (an object element of the array, or a key of the object).
 * Undefined when there is no route grant.
 */
export function routeGrantOf(
  grants: unknown,
): DeclaredWriteTarget[] | undefined {
  const parsed = parseGrants(grants);

  if (Array.isArray(parsed)) {
    const element = parsed.find(isRouteGrantElement);

    return element ? asTargets(element[ROUTE_WRITES_GRANT]) : undefined;
  }

  if (parsed && typeof parsed === 'object') {
    const value = (parsed as Record<string, unknown>)[ROUTE_WRITES_GRANT];

    return value === undefined ? undefined : asTargets(value);
  }

  return undefined;
}

/** The capability names in `grants`, without the route grant. */
export function capabilityGrantNames(grants: unknown): string[] {
  const parsed = parseGrants(grants);

  if (Array.isArray(parsed)) {
    return parsed.filter((g): g is string => typeof g === 'string');
  }

  if (parsed && typeof parsed === 'object') {
    return Object.keys(parsed).filter(k => k !== ROUTE_WRITES_GRANT);
  }

  return [];
}

/**
 * `grants` in the array form: the capability names, and the route grant when
 * the installer approved the write targets.
 */
export function grantsWithRouteWrites(
  names: string[],
  routeWrites?: DeclaredWriteTarget[],
): InstallationGrant[] {
  if (!routeWrites || routeWrites.length === 0) return [...names];

  return [
    ...names,
    {
      [ROUTE_WRITES_GRANT]: routeWrites.map(t => ({
        id: t.id,
        parent: t.parent,
        classes: [...t.classes],
      })),
    },
  ];
}

function sameTarget(a: DeclaredWriteTarget, b: DeclaredWriteTarget): boolean {
  return (
    a.id === b.id &&
    a.parent === b.parent &&
    a.classes.length === b.classes.length &&
    a.classes.every((c, i) => c === b.classes[i])
  );
}

/**
 * The declared targets an earlier approval does not cover unchanged: what an
 * upgrade review must show for approval. The server compares the same way
 * (`WriteTarget`'s equality), so a known id with another parent or more
 * classes counts as new.
 */
export function newWriteTargets(
  declared: DeclaredWriteTarget[],
  approved: DeclaredWriteTarget[] | undefined,
): DeclaredWriteTarget[] {
  return declared.filter(t => !(approved ?? []).some(a => sameTarget(a, t)));
}

/** A write target whose parent names a config key the config doesn't set. */
export class UnresolvedWriteTargetError extends Error {
  public constructor(
    public readonly target: DeclaredWriteTarget,
    public readonly key: string,
  ) {
    super(
      `The write target "${target.id}" stores under the resource in the config key "${key}", which is not set. Set "${key}" in the config to the resource that should receive these items.`,
    );
    this.name = 'UnresolvedWriteTargetError';
  }
}

/**
 * The resource a target's `parent` names: `config:<key>` is looked up in the
 * config (a non-empty string), anything else is a URL. The same rule as the
 * server's `allowed_targets`. Throws {@link UnresolvedWriteTargetError}.
 */
export function resolveWriteTargetParent(
  target: DeclaredWriteTarget,
  config: JSONValue | undefined,
): string {
  if (!target.parent.startsWith('config:')) return target.parent;
  const key = target.parent.slice('config:'.length);
  const value =
    config && typeof config === 'object' && !Array.isArray(config)
      ? (config as Record<string, JSONValue>)[key]
      : undefined;

  if (typeof value !== 'string' || value.length === 0) {
    throw new UnresolvedWriteTargetError(target, key);
  }

  return value;
}

/** Every distinct parent the targets store under. Throws when one can't be resolved. */
export function resolveWriteTargetParents(
  targets: DeclaredWriteTarget[],
  config: JSONValue | undefined,
): string[] {
  return [...new Set(targets.map(t => resolveWriteTargetParent(t, config)))];
}

/** Like {@link resolveWriteTargetParents}, skipping targets that don't resolve. */
function resolvableParents(
  targets: DeclaredWriteTarget[],
  config: JSONValue | undefined,
): string[] {
  return [
    ...new Set(
      targets.flatMap(t => {
        try {
          return [resolveWriteTargetParent(t, config)];
        } catch {
          return [];
        }
      }),
    ),
  ];
}

function writersOf(resource: { get: (p: string) => unknown }): string[] {
  const value = resource.get(core.properties.write);

  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * Lets `agent` write each parent: one commit per parent, signed by the
 * signed-in agent, adding `agent` to its `write` list. A parent that already
 * lists it is left alone.
 */
export async function giveRouteWriteRights(
  store: Store,
  agent: string,
  parents: string[],
): Promise<void> {
  for (const subject of parents) {
    const parent = await store.getResource(subject);

    if (parent.error) {
      throw new Error(
        `Could not open ${subject} to let the plugin write there: ${parent.error.message}`,
      );
    }

    if (writersOf(parent).includes(agent)) continue;
    parent.push(core.properties.write, [agent], true);
    await parent.save();
  }
}

/** Takes back what {@link giveRouteWriteRights} gave. */
export async function removeRouteWriteRights(
  store: Store,
  agent: string,
  parents: string[],
): Promise<void> {
  for (const subject of parents) {
    const parent = await store.getResource(subject);
    if (parent.error) continue;
    const writers = writersOf(parent);
    if (!writers.includes(agent)) continue;
    await parent.set(
      core.properties.write,
      writers.filter(w => w !== agent),
      false,
    );
    await parent.save();
  }
}

/**
 * The agent the server made for an Installation. The server adds it when it
 * serves the Installation (it is not in the resource's own state), and only
 * while the plugin is installed, so this asks the server, retrying briefly
 * while activation catches up.
 */
export async function fetchPluginAgent(
  store: Store,
  installation: string,
  {
    attempts = 10,
    delayMs = 300,
  }: { attempts?: number; delayMs?: number } = {},
): Promise<string> {
  let lastError: unknown;

  for (let i = 0; i < attempts; i++) {
    try {
      const resource = await store.fetchResourceFromServer(installation, {
        noWebSocket: true,
      });
      const agent = resource.get(server.properties.pluginAgent);
      if (typeof agent === 'string' && agent.length > 0) return agent;
    } catch (e) {
      lastError = e;
    }

    if (i < attempts - 1) await new Promise(r => setTimeout(r, delayMs));
  }

  throw new Error(
    `The server did not report an agent for ${installation}, so the plugin could not be given write rights${
      lastError ? `: ${lastError}` : ''
    }. Check that the installation is active.`,
  );
}

/** The parents an Installation's route grant covers, with its current config. */
export function routeWriteParentsOf(
  grants: unknown,
  config: unknown,
): string[] {
  const targets = routeGrantOf(grants);
  if (!targets) return [];
  const parsed = parseGrants(config) as JSONValue | undefined;

  return resolvableParents(targets, parsed);
}

/**
 * The rights to change when an Installation's route grant or config changes:
 * give the parents only the new state covers, take back the ones only the old
 * state covered.
 */
export function routeWriteRightsDiff(
  before: string[],
  after: string[],
): { give: string[]; remove: string[] } {
  return {
    give: after.filter(p => !before.includes(p)),
    remove: before.filter(p => !after.includes(p)),
  };
}

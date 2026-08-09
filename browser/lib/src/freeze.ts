import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

import { jcsCanonicalize } from './jcs.js';

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FrozenId = `did:ad:frozen:${string}`;

const FROZEN_PREFIX = 'did:ad:frozen:';

/**
 * Placeholder for an intra-cycle reference, by the referent's canonical index.
 * Part of the frozen-unit format: a materializer rewires `did:ad:frozen:self:{i}`
 * to the i-th member of the unit.
 */
export const SELF_PREFIX = 'did:ad:frozen:self:';

/** Reserved key carrying the ordered members of a cycle's frozen unit object. */
export const UNIT_MEMBERS_KEY = 'urn:atomic-freeze:unit';

export interface FreezableResource {
  /**
   * Temporary, unique id. It is used both as this resource's bookkeeping key and
   * as the token other resources put inside their `content` to reference it. Any
   * string value anywhere in another resource's `content` that equals this
   * `localId` is treated as a reference and rewritten to the computed
   * {@link FrozenId}. `content` must NOT contain a self-identifier — the subject
   * IS the hash, so it is excluded from the hashed bytes.
   */
  localId: string;
  /** The resource body to freeze. References to other resources are localIds. */
  content: JsonValue;
}

export interface FrozenResource {
  frozenId: FrozenId;
  /**
   * JSON-AD body with internal references resolved to FrozenIds. For a cycle
   * unit this is a `{ [UNIT_MEMBERS_KEY]: [...members] }` wrapper whose members
   * reference each other by canonical index.
   */
  content: JsonValue;
  /**
   * The localIds this frozen object covers: one for an ordinary resource, the
   * whole cycle for a unit. Members of a cycle are not individually addressable
   * — they share the unit's FrozenId and resolve together.
   */
  unit: string[];
}

export interface FreezeResult {
  /** One entry per distinct frozen object (ordinary resource or cycle unit). */
  resources: FrozenResource[];
  /** localId -> FrozenId for every input resource (cycle members map to the unit). */
  byLocalId: Map<string, FrozenId>;
}

/**
 * Content-addresses a set of resources that may reference each other, producing
 * a Merkle DAG of `did:ad:frozen:{blake3}` identifiers. A reference is rewritten
 * to the referent's hash before hashing, so a parent's id depends on its
 * children's ids (the whole content is hashed, including descriptions).
 *
 * Cyclic references (e.g. a `Person` class with a `friend` property whose
 * classtype is `Person`) have no leaf to start from. Each strongly-connected
 * group is therefore frozen as a single **unit** object so the id stays
 * `blake3(canonical bytes)` and remains verifiable by re-hashing. The cycle's
 * members share that unit id and resolve together.
 */
export function freezeResources(input: FreezableResource[]): FreezeResult {
  const ids = new Set(input.map(r => r.localId));

  if (ids.size !== input.length) {
    throw new Error('freezeResources: localId values must be unique');
  }

  const byId = new Map(input.map(r => [r.localId, r] as const));
  const edges = new Map<string, Set<string>>(
    input.map(r => [r.localId, collectRefs(r.content, ids)] as const),
  );

  // Tarjan emits SCCs in reverse topological order (sinks first), which is
  // exactly the bottom-up order we need: every out-edge of a component points
  // at an already-frozen component.
  const sccs = stronglyConnectedComponents([...ids], edges);
  const frozenIdByLocal = new Map<string, FrozenId>();
  const resources = new Map<FrozenId, FrozenResource>();

  for (const scc of sccs) {
    const isCycle =
      scc.length > 1 || (edges.get(scc[0])?.has(scc[0]) ?? false);

    if (isCycle) {
      freezeCycle(scc, byId, edges, frozenIdByLocal, resources);
    } else {
      freezeSingleton(scc[0], byId, edges, frozenIdByLocal, resources);
    }
  }

  return { resources: [...resources.values()], byLocalId: frozenIdByLocal };
}

function freezeSingleton(
  localId: string,
  byId: Map<string, FreezableResource>,
  edges: Map<string, Set<string>>,
  frozenIdByLocal: Map<string, FrozenId>,
  out: Map<FrozenId, FrozenResource>,
): void {
  // All references point at earlier (already-frozen) components.
  const content = substitute(
    byId.get(localId)!.content,
    resolvedRefMap(edges.get(localId), frozenIdByLocal),
  );
  const frozenId = frozenIdFor(content);

  frozenIdByLocal.set(localId, frozenId);

  const existing = out.get(frozenId);

  if (existing) {
    existing.unit.push(localId);
  } else {
    out.set(frozenId, { frozenId, content, unit: [localId] });
  }
}

function freezeCycle(
  scc: string[],
  byId: Map<string, FreezableResource>,
  edges: Map<string, Set<string>>,
  frozenIdByLocal: Map<string, FrozenId>,
  out: Map<FrozenId, FrozenResource>,
): void {
  const sccSet = new Set(scc);
  const order = canonicalOrder(scc, sccSet, byId, edges, frozenIdByLocal);
  const indexOf = new Map(order.map((id, i) => [id, i] as const));

  // The unit wraps its members in canonical order; intra-cycle refs become a
  // self token (by index), refs that leave the cycle become their FrozenId.
  const members = order.map(localId =>
    substitute(
      byId.get(localId)!.content,
      cycleRefMap(edges.get(localId), sccSet, indexOf, frozenIdByLocal),
    ),
  );
  const content: JsonValue = { [UNIT_MEMBERS_KEY]: members };
  const frozenId = frozenIdFor(content);

  for (const localId of order) {
    frozenIdByLocal.set(localId, frozenId);
  }

  out.set(frozenId, { frozenId, content, unit: [...order] });
}

/**
 * Deterministic ordering of a cycle's members, independent of input order, via
 * color refinement: start each member colored by its content (intra-cycle refs
 * blanked), then repeatedly recolor using neighbors' colors until the partition
 * stabilizes. Ties (true structural automorphisms — vanishingly rare for
 * schemas) are broken by localId, which makes those — and only those — cases
 * input-dependent.
 */
function canonicalOrder(
  scc: string[],
  sccSet: Set<string>,
  byId: Map<string, FreezableResource>,
  edges: Map<string, Set<string>>,
  frozenIdByLocal: Map<string, FrozenId>,
): string[] {
  let color = new Map<string, string>(
    scc.map(localId => [
      localId,
      hashCanonical(
        substitute(
          byId.get(localId)!.content,
          cycleRefMap(edges.get(localId), sccSet, undefined, frozenIdByLocal),
        ),
      ),
    ]),
  );

  for (let round = 0; round < scc.length; round++) {
    const next = new Map<string, string>(
      scc.map(localId => [
        localId,
        hashCanonical(
          substitute(
            byId.get(localId)!.content,
            neighborColorRefMap(
              edges.get(localId),
              sccSet,
              color,
              frozenIdByLocal,
            ),
          ),
        ),
      ]),
    );

    if (partitionSignature(scc, next) === partitionSignature(scc, color)) {
      color = next;
      break;
    }

    color = next;
  }

  return [...scc].sort((a, b) => {
    const ca = color.get(a)!;
    const cb = color.get(b)!;

    if (ca !== cb) {
      return ca < cb ? -1 : 1;
    }

    return a < b ? -1 : a > b ? 1 : 0;
  });
}

/** Maps every reference to its already-computed FrozenId (drops unknowns). */
function resolvedRefMap(
  refs: Set<string> | undefined,
  frozenIdByLocal: Map<string, FrozenId>,
): Map<string, string> {
  const map = new Map<string, string>();

  for (const ref of refs ?? []) {
    const frozenId = frozenIdByLocal.get(ref);

    if (frozenId) {
      map.set(ref, frozenId);
    }
  }

  return map;
}

/**
 * For hashing a cycle: intra-cycle refs become a self token (by canonical index,
 * or a constant when `indexOf` is omitted during initial coloring); refs that
 * leave the cycle become their FrozenId.
 */
function cycleRefMap(
  refs: Set<string> | undefined,
  sccSet: Set<string>,
  indexOf: Map<string, number> | undefined,
  frozenIdByLocal: Map<string, FrozenId>,
): Map<string, string> {
  const map = new Map<string, string>();

  for (const ref of refs ?? []) {
    if (sccSet.has(ref)) {
      map.set(ref, indexOf ? `${SELF_PREFIX}${indexOf.get(ref)}` : SELF_PREFIX);
    } else {
      const frozenId = frozenIdByLocal.get(ref);

      if (frozenId) {
        map.set(ref, frozenId);
      }
    }
  }

  return map;
}

/** Like {@link cycleRefMap} but intra-cycle refs carry the neighbor's color. */
function neighborColorRefMap(
  refs: Set<string> | undefined,
  sccSet: Set<string>,
  color: Map<string, string>,
  frozenIdByLocal: Map<string, FrozenId>,
): Map<string, string> {
  const map = new Map<string, string>();

  for (const ref of refs ?? []) {
    if (sccSet.has(ref)) {
      map.set(ref, `${SELF_PREFIX}${color.get(ref)}`);
    } else {
      const frozenId = frozenIdByLocal.get(ref);

      if (frozenId) {
        map.set(ref, frozenId);
      }
    }
  }

  return map;
}

/** Canonical signature of the equivalence classes induced by `color`. */
function partitionSignature(
  scc: string[],
  color: Map<string, string>,
): string {
  const groups = new Map<string, string[]>();

  for (const id of scc) {
    const key = color.get(id)!;
    const group = groups.get(key);

    if (group) {
      group.push(id);
    } else {
      groups.set(key, [id]);
    }
  }

  return [...groups.values()]
    .map(group => [...group].sort().join(','))
    .sort()
    .join('|');
}

function collectRefs(value: JsonValue, ids: Set<string>): Set<string> {
  const out = new Set<string>();

  const walk = (node: JsonValue): void => {
    if (typeof node === 'string') {
      if (ids.has(node)) {
        out.add(node);
      }
    } else if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (node !== null && typeof node === 'object') {
      Object.values(node).forEach(walk);
    }
  };

  walk(value);

  return out;
}

function substitute(value: JsonValue, map: Map<string, string>): JsonValue {
  if (typeof value === 'string') {
    return map.get(value) ?? value;
  }

  if (Array.isArray(value)) {
    return value.map(item => substitute(item, map));
  }

  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        substitute(child, map),
      ]),
    );
  }

  return value;
}

function hashCanonical(value: JsonValue): string {
  return bytesToHex(blake3(utf8ToBytes(jcsCanonicalize(value))));
}

/**
 * The canonical frozen id for a JSON-AD body: `did:ad:frozen:{blake3(JCS(content))}`.
 * The single source of truth shared by production and verification — re-hashing a
 * stored frozen object with this must reproduce its id.
 */
export function frozenIdFor(content: JsonValue): FrozenId {
  return (FROZEN_PREFIX + hashCanonical(content)) as FrozenId;
}

/**
 * Process-wide registry of frozen bodies by id. Populated whenever frozen
 * resources are computed locally (`defineSchema`, `registerFrozenSchema`,
 * `loadSchemaLock`), so the Store can lazily PUT a referenced definition to the
 * server on save without the caller ever publishing it explicitly. Bodies are
 * immutable and content-addressed, so first-write-wins is always safe.
 */
const frozenBodyRegistry = new Map<FrozenId, JsonValue>();

export function registerFrozenBodies(
  resources: ReadonlyArray<{ frozenId: FrozenId; content: JsonValue }>,
): void {
  for (const { frozenId, content } of resources) {
    if (!frozenBodyRegistry.has(frozenId)) {
      frozenBodyRegistry.set(frozenId, content);
    }
  }
}

/** The locally-known body for a frozen id, if one has been registered. */
export function getRegisteredFrozenBody(
  frozenId: string,
): JsonValue | undefined {
  return frozenBodyRegistry.get(frozenId as FrozenId);
}

function stronglyConnectedComponents(
  nodes: string[],
  edges: Map<string, Set<string>>,
): string[][] {
  let counter = 0;
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];

  const connect = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);

    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        connect(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }

    if (low.get(v) === index.get(v)) {
      const component: string[] = [];
      let w: string;

      do {
        w = stack.pop()!;
        onStack.delete(w);
        component.push(w);
      } while (w !== v);

      result.push(component);
    }
  };

  for (const v of nodes) {
    if (!index.has(v)) {
      connect(v);
    }
  }

  return result;
}

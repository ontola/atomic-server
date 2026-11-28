// @wc-ignore-file
import { canonicalValue } from './builtinSyncIdentity.js';

export type FieldEvidence =
  | { kind: 'value'; value: unknown }
  | { kind: 'null' }
  | { kind: 'absent' };
export interface DurableSyncRun {
  ruleSubject: string;
  ruleKey: string;
  runId: string;
  generation: string;
  startOrder: number;
  complete: boolean;
  entityKeys: string[];
}
export interface DurableEntityObservation {
  entityKey: string;
  raw?: Record<string, unknown>;
  ruleKey: string;
  runId: string;
  generation: string;
  representationKey: string;
  partitionKey: string;
  fields: Record<string, FieldEvidence>;
}

interface ReducedEntity {
  values: Record<string, unknown>;
  raw?: Record<string, unknown>;
  cleared: string[];
  memberships: string[];
}

interface ObservationRank {
  run: DurableSyncRun;
  rank: string;
}

interface FieldObservation extends ObservationRank {
  field: string;
  evidence: Exclude<FieldEvidence, { kind: 'absent' }>;
}

interface EntityObservations {
  memberships: Set<string>;
  ledgers: Map<string, FieldObservation>;
  raw: (ObservationRank & { raw: Record<string, unknown> })[];
}

const textOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const compare = (a: DurableSyncRun, b: DurableSyncRun) =>
  a.startOrder - b.startOrder || textOrder(a.runId, b.runId);
const fingerprint = (value: DurableSyncRun | unknown[]) =>
  JSON.stringify(canonicalValue(value));
const observationOrder = (observation: DurableEntityObservation) =>
  fingerprint([
    observation.representationKey,
    observation.partitionKey,
    observation.raw,
  ]);

// Binding evidence is reconstructed from explicit observed fields, not claimed
// as a new provider response. Immutable observations retain actual provenance;
// native selection execution still verifies identity on every detail/Link read.
function mergeRaw(
  previous: unknown,
  value: Record<string, unknown>,
): Record<string, unknown>;
function mergeRaw(previous: unknown, value: unknown): unknown;

function mergeRaw(previous: unknown, value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return canonicalValue(value);
  const merged = Object.fromEntries(
    previous && typeof previous === 'object' && !Array.isArray(previous)
      ? Object.entries(previous)
      : [],
  );
  for (const [key, item] of Object.entries(value))
    Object.defineProperty(merged, key, {
      enumerable: true,
      configurable: true,
      writable: true,
      value: mergeRaw(merged[key], item),
    });

  return merged;
}

/** Pure projection of durable per-rule runs and immutable entity observations.
 * An incomplete run only adds membership. Only the latest complete exact rule
 * scope may retract it; entity data itself is always retained.
 */
export function reduceFlatState({
  runs,
  observations,
}: {
  runs: DurableSyncRun[];
  observations: DurableEntityObservation[];
}): Record<string, ReducedEntity> {
  const acceptedRuns = new Map<string, DurableSyncRun>();
  const byRule = new Map<string, DurableSyncRun[]>();

  for (const run of runs) {
    if (
      !run ||
      typeof run.ruleSubject !== 'string' ||
      typeof run.ruleKey !== 'string' ||
      typeof run.runId !== 'string' ||
      typeof run.generation !== 'string' ||
      !Number.isSafeInteger(run.startOrder) ||
      !Array.isArray(run.entityKeys)
    )
      throw new Error('Invalid durable sync run');
    const previous = acceptedRuns.get(run.runId);
    if (previous && fingerprint(previous) !== fingerprint(run))
      throw new Error('Conflicting durable sync run');
    const accepted = { ...run, entityKeys: [...run.entityKeys] };
    acceptedRuns.set(run.runId, accepted);
    const list = byRule.get(run.ruleKey) ?? [];
    list.push(accepted);
    byRule.set(run.ruleKey, list);
  }

  const entities = new Map<string, EntityObservations>();

  const get = (key: string): EntityObservations => {
    const existing = entities.get(key);
    if (existing) return existing;
    const entity: EntityObservations = {
      memberships: new Set(),
      ledgers: new Map(),
      raw: [],
    };
    entities.set(key, entity);

    return entity;
  };

  // A cancelled frame can persist an observation before acknowledging the run's
  // accepted prefix. Its issued generation still proves that incomplete evidence.
  for (const observation of observations) {
    const run = acceptedRuns.get(observation.runId);
    if (
      run &&
      !run.complete &&
      run.generation === observation.generation &&
      run.ruleKey === observation.ruleKey &&
      !run.entityKeys.includes(observation.entityKey)
    )
      run.entityKeys.push(observation.entityKey);
  }

  for (const list of byRule.values()) {
    list.sort(compare);
    let membership = new Set<string>();

    for (const run of list) {
      if (run.complete === true) membership = new Set(run.entityKeys);
      else for (const key of run.entityKeys) membership.add(key);
    }

    for (const key of membership)
      get(key).memberships.add(list[list.length - 1].ruleSubject);
  }

  for (const observation of observations) {
    const run = acceptedRuns.get(observation.runId);
    if (
      !run ||
      run.generation !== observation.generation ||
      run.ruleKey !== observation.ruleKey ||
      !run.entityKeys.includes(observation.entityKey)
    )
      continue;
    const entity = get(observation.entityKey);
    const rank = observationOrder(observation);
    if (observation.raw) entity.raw.push({ run, rank, raw: observation.raw });

    for (const [field, evidence] of Object.entries(observation.fields)) {
      if (evidence.kind === 'absent') continue;
      if (evidence.kind !== 'value' && evidence.kind !== 'null')
        throw new Error('Invalid field evidence');
      const key = fingerprint([
        run.ruleKey,
        observation.representationKey,
        observation.partitionKey,
        field,
      ]);
      const previous = entity.ledgers.get(key);
      if (
        !previous ||
        compare(previous.run, run) < 0 ||
        (compare(previous.run, run) === 0 && previous.rank < rank)
      )
        entity.ledgers.set(key, { field, evidence, run, rank });
    }
  }

  const result: Record<string, ReducedEntity> = {};

  for (const [key, entity] of entities) {
    const values: Record<string, unknown> = {};
    const cleared = new Set<string>();
    const winners = new Map<string, FieldObservation>();

    for (const item of entity.ledgers.values()) {
      const previous = winners.get(item.field);
      if (
        !previous ||
        compare(previous.run, item.run) < 0 ||
        (compare(previous.run, item.run) === 0 && previous.rank < item.rank)
      )
        winners.set(item.field, item);
    }

    for (const [field, item] of winners) {
      if (item.evidence.kind === 'null') cleared.add(field);
      else values[field] = item.evidence.value;
    }

    let raw: Record<string, unknown> | undefined;
    for (const item of entity.raw.sort(
      (a, b) => compare(a.run, b.run) || textOrder(a.rank, b.rank),
    ))
      raw = mergeRaw(raw, item.raw);

    Object.defineProperty(result, key, {
      enumerable: true,
      value: {
        values,
        cleared: [...cleared].sort(),
        memberships: [...entity.memberships].sort(),
        ...(raw ? { raw } : {}),
      },
    });
  }

  return result;
}

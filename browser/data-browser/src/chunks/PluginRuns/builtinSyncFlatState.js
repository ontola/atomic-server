// @wc-ignore-file
import { canonicalValue } from './builtinSyncIdentity.js';

const textOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const compare = (a, b) =>
  a.startOrder - b.startOrder || textOrder(a.runId, b.runId);
const fingerprint = value => JSON.stringify(canonicalValue(value));
const observationOrder = observation =>
  fingerprint([
    observation.representationKey,
    observation.partitionKey,
    observation.raw,
  ]);

// Binding evidence is reconstructed from explicit observed fields, not claimed
// as a new provider response. Immutable observations retain actual provenance;
// native selection execution still verifies identity on every detail/Link read.
const mergeRaw = (previous, value) => {
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
};

/** Pure projection of durable per-rule runs and immutable entity observations.
 * An incomplete run only adds membership. Only the latest complete exact rule
 * scope may retract it; entity data itself is always retained.
 */
export function reduceFlatState({ runs, observations }) {
  const acceptedRuns = new Map();
  const byRule = new Map();

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

  const entities = new Map();

  const get = key => {
    if (!entities.has(key))
      entities.set(key, {
        memberships: new Set(),
        ledgers: new Map(),
        raw: [],
      });

    return entities.get(key);
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
    let membership = new Set();

    for (const run of list) {
      if (run.complete === true) membership = new Set(run.entityKeys);
      else for (const key of run.entityKeys) membership.add(key);
    }

    for (const key of membership)
      get(key).memberships.add(list.at(-1).ruleSubject);
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
      if (!['value', 'null'].includes(evidence.kind))
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

  const result = {};

  for (const [key, entity] of entities) {
    const values = {};
    const cleared = new Set();
    const winners = new Map();

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

    let raw;
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

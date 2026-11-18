/** Stable storage identity and its active incarnation, supplied by an adapter.
 * Different generations of one storageId are still the same copy. */
export interface ReplicaIdentity {
  readonly storageId: string;
  readonly generation: string;
  readonly deviceId?: string;
}

/** Choose local.version or server.version from SaveReceipt explicitly.
 * Equality is exact: this evaluator does not infer causal coverage by a later
 * version. A null or empty version cannot establish replica evidence. */
export interface ReplicaEvidenceTarget {
  readonly subject: string;
  readonly version: string | null;
  readonly source?: ReplicaIdentity;
  readonly scope: 'storage' | 'device';
}

export interface ReplicaBarrierEvidence {
  readonly name: string;
  readonly subject: string;
  readonly version: string | null;
  readonly storage: 'persistent' | 'memory' | 'unknown';
  readonly state: 'pending' | 'completed' | 'failed';
}

/** Untrusted input until a caller-owned policy authenticates its provenance.
 * Provider names, evidence IDs and replica IDs are identifiers, not proof. */
export interface ReplicaObservation {
  readonly provider: string;
  readonly capability: 'supported' | 'unsupported' | 'unknown';
  /** Opaque correlation key for the adapter's externally verified record. */
  readonly evidenceId?: string;
  readonly replica?: ReplicaIdentity;
  readonly barrier?: ReplicaBarrierEvidence;
}

export interface ReplicaEvidenceAssessment {
  readonly trust: 'trusted' | 'untrusted' | 'unknown';
  /** Both source and destination generations must still be current. */
  readonly generation: 'current' | 'stale' | 'unknown';
  /** Independence for target.scope, not merely different identifiers. */
  readonly independence: 'independent' | 'shared' | 'unknown';
}

export interface ReplicaEvidencePolicy {
  /** Trusted application/adapter code must correlate the exact observation and
   * target with authenticated, authorized evidence and active identities. Do
   * not trust an observation because it supplies a familiar provider or ID.
   * Inputs are detached immutable snapshots. Exceptions yield unknown. */
  assess(
    target: ReplicaEvidenceTarget,
    observation: ReplicaObservation,
  ): ReplicaEvidenceAssessment;
}

export type ReplicaEvidenceExclusionReason =
  | 'unsupported'
  | 'capability-unknown'
  | 'invalid-target'
  | 'invalid-observation'
  | 'identity-unknown'
  | 'policy-missing'
  | 'policy-error'
  | 'untrusted'
  | 'trust-unknown'
  | 'generation-stale'
  | 'generation-unknown'
  | 'same-storage'
  | 'shared-device'
  | 'not-independent'
  | 'independence-unknown'
  | 'no-barrier'
  | 'barrier-incomplete'
  | 'barrier-unnamed'
  | 'wrong-subject'
  | 'wrong-version'
  | 'not-persistent'
  | 'durability-unknown';

export interface ReplicaEvidenceExclusion {
  readonly observation: ReplicaObservation;
  readonly reason: ReplicaEvidenceExclusionReason;
}

export interface ReplicaEvidenceSignal {
  readonly target: ReplicaEvidenceTarget;
  /** satisfied means at least one qualifying historical completed barrier.
   * It does not establish current retention, reachability or a complete backup.
   * pending means no qualifying completed evidence, not a scheduled request. */
  readonly status: 'unsupported' | 'unknown' | 'pending' | 'satisfied';
  /** At most one observation per storageId/generation. This is not a quorum
   * or an independent-device count: different stores may share a device. */
  readonly qualifying: readonly ReplicaObservation[];
  readonly excluded: readonly ReplicaEvidenceExclusion[];
}

const text = (value: unknown): string =>
  typeof value === 'string' ? value : '';

function snapshotIdentity(
  identity: ReplicaIdentity | undefined,
): ReplicaIdentity | undefined {
  if (!identity || typeof identity !== 'object') return undefined;

  const { storageId, generation, deviceId } = identity;

  return Object.freeze({
    storageId: text(storageId),
    generation: text(generation),
    ...(typeof deviceId === 'string' ? { deviceId } : {}),
  });
}

function snapshotObservation(
  observation: ReplicaObservation,
): ReplicaObservation {
  const {
    provider,
    capability,
    evidenceId,
    replica: rawReplica,
    barrier: input,
  } = observation ?? {};
  const replica = snapshotIdentity(rawReplica);
  let barrier: ReplicaBarrierEvidence | undefined;

  if (input && typeof input === 'object') {
    const { name, subject, version, storage, state } = input;
    barrier = Object.freeze({
      name: text(name),
      subject: text(subject),
      version: typeof version === 'string' ? version : null,
      storage:
        storage === 'persistent' || storage === 'memory' ? storage : 'unknown',
      state: state === 'completed' || state === 'failed' ? state : 'pending',
    });
  }

  return Object.freeze({
    provider: text(provider),
    capability:
      capability === 'supported' || capability === 'unsupported'
        ? capability
        : 'unknown',
    ...(typeof evidenceId === 'string' ? { evidenceId } : {}),
    ...(replica ? { replica } : {}),
    ...(barrier ? { barrier } : {}),
  });
}

function knownIdentity(identity: ReplicaIdentity | undefined): boolean {
  return !!identity?.storageId.trim() && !!identity.generation.trim();
}

/** Evaluate at-least-one independent historical replica barrier. BrowserPeerSync
 * can supply authenticated storage observations; omitted providers mean
 * unsupported and independence still requires the caller's policy. Server acceptance, legacy ACKs and memory flushes are not durable
 * replica evidence. Later versions can produce conservative false negatives
 * because only exact version equality is supported. This pure function neither
 * verifies signatures nor discovers identities; the trusted policy owns that. */
export function evaluateReplicaEvidence(
  target: ReplicaEvidenceTarget,
  observations: readonly ReplicaObservation[] = [],
  policy?: ReplicaEvidencePolicy,
): ReplicaEvidenceSignal {
  const { subject, version, scope, source: rawSource } = target ?? {};
  const source = snapshotIdentity(rawSource);
  const captured: ReplicaEvidenceTarget = Object.freeze({
    subject: text(subject),
    version: typeof version === 'string' ? version : null,
    scope: scope === 'device' ? 'device' : 'storage',
    ...(source ? { source } : {}),
  });
  const validTarget =
    !!captured.subject.trim() &&
    !!captured.version?.trim() &&
    (scope === 'device' || scope === 'storage');
  const snapshots = observations.map(snapshotObservation);
  const qualifying: ReplicaObservation[] = [];
  const qualified = new Set<string>();
  const excluded: ReplicaEvidenceExclusion[] = [];
  let supported = false;
  let uncertain = false;

  const exclude = (
    observation: ReplicaObservation,
    reason: ReplicaEvidenceExclusionReason,
    unknown = false,
  ) => {
    excluded.push(Object.freeze({ observation, reason }));
    uncertain ||= unknown;
  };

  for (const observation of snapshots) {
    if (observation.capability === 'unsupported') {
      exclude(observation, 'unsupported');
      continue;
    }

    if (observation.capability !== 'supported') {
      exclude(observation, 'capability-unknown', true);
      continue;
    }

    supported = true;

    if (!validTarget) {
      exclude(observation, 'invalid-target', true);
      continue;
    }

    if (!observation.provider.trim()) {
      exclude(observation, 'invalid-observation', true);
      continue;
    }

    if (!knownIdentity(source) || !knownIdentity(observation.replica)) {
      exclude(observation, 'identity-unknown', true);
      continue;
    }

    if (!policy) {
      exclude(observation, 'policy-missing', true);
      continue;
    }

    let assessment: ReplicaEvidenceAssessment;

    try {
      const answer = policy.assess(captured, observation);
      assessment = {
        trust: answer?.trust,
        generation: answer?.generation,
        independence: answer?.independence,
      };
    } catch {
      exclude(observation, 'policy-error', true);
      continue;
    }

    if (assessment.trust !== 'trusted') {
      exclude(
        observation,
        assessment.trust === 'untrusted' ? 'untrusted' : 'trust-unknown',
        true,
      );
      continue;
    }

    if (assessment.generation !== 'current') {
      const unknown = assessment.generation !== 'stale';
      exclude(
        observation,
        unknown ? 'generation-unknown' : 'generation-stale',
        unknown,
      );
      continue;
    }

    if (source!.storageId === observation.replica!.storageId) {
      exclude(observation, 'same-storage');
      continue;
    }

    if (captured.scope === 'device') {
      if (
        source!.deviceId?.trim() &&
        source!.deviceId === observation.replica!.deviceId
      ) {
        exclude(observation, 'shared-device');
        continue;
      }
    }

    if (assessment.independence !== 'independent') {
      const unknown = assessment.independence !== 'shared';
      exclude(
        observation,
        unknown ? 'independence-unknown' : 'not-independent',
        unknown,
      );
      continue;
    }

    const barrier = observation.barrier;

    if (!barrier) {
      exclude(observation, 'no-barrier');
    } else if (barrier.subject !== captured.subject) {
      exclude(observation, 'wrong-subject');
    } else if (barrier.version !== captured.version) {
      exclude(observation, 'wrong-version');
    } else if (barrier.storage !== 'persistent') {
      const unknown = barrier.storage !== 'memory';
      exclude(
        observation,
        unknown ? 'durability-unknown' : 'not-persistent',
        unknown,
      );
    } else if (barrier.state !== 'completed') {
      exclude(observation, 'barrier-incomplete');
    } else if (!barrier.name.trim()) {
      exclude(observation, 'barrier-unnamed');
    } else {
      const key = JSON.stringify([
        observation.replica!.storageId,
        observation.replica!.generation,
      ]);

      if (!qualified.has(key)) {
        qualifying.push(observation);
        qualified.add(key);
      }
    }
  }

  return Object.freeze({
    target: captured,
    status: qualifying.length
      ? 'satisfied'
      : uncertain
        ? 'unknown'
        : supported
          ? 'pending'
          : 'unsupported',
    qualifying: Object.freeze(qualifying),
    excluded: Object.freeze(excluded),
  });
}

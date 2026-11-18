import { describe, expect, it, vi } from 'vitest';
import * as api from './index.js';
import stringify from 'fast-json-stable-stringify';
import type { SaveReceipt } from './resource.js';
import {
  evaluateReplicaEvidence,
  type ReplicaEvidenceAssessment,
  type ReplicaEvidencePolicy,
  type ReplicaEvidenceTarget,
  type ReplicaObservation,
} from './replica-evidence.js';

const target: ReplicaEvidenceTarget = {
  subject: 'atomic:document',
  version: 'encoded-version-1',
  scope: 'storage',
  source: {
    storageId: 'source-db',
    generation: 'source-generation',
    deviceId: 'laptop',
  },
};

function observation(): ReplicaObservation {
  return {
    provider: 'verified-adapter',
    evidenceId: 'authenticated-record-1',
    capability: 'supported',
    replica: {
      storageId: 'remote-db',
      generation: 'remote-generation',
      deviceId: 'server',
    },
    barrier: {
      name: 'adapter-confirmed-flush',
      subject: target.subject,
      version: target.version,
      storage: 'persistent',
      state: 'completed',
    },
  };
}

/** Stand-in for a trusted adapter's separately authenticated records and
 * configured independence knowledge. Raw observations cannot vouch for themselves. */
function policyFor(
  records: readonly ReplicaObservation[],
  overrides: Partial<ReplicaEvidenceAssessment> = {},
): ReplicaEvidencePolicy {
  const verifiedRecords = new Map(
    records.map(record => [record.evidenceId, stringify(record)]),
  );

  return {
    assess: (_target, candidate) => ({
      trust:
        verifiedRecords.get(candidate.evidenceId) === stringify(candidate)
          ? 'trusted'
          : 'untrusted',
      generation: 'current',
      independence: 'independent',
      ...overrides,
    }),
  };
}

it('exports the independent replica evidence evaluator', () => {
  expect(
    (api as unknown as Record<string, unknown>).evaluateReplicaEvidence,
  ).toBeTypeOf('function');
});

describe('independent replica evidence', () => {
  it('requires choosing one SaveReceipt version without promoting server acceptance', () => {
    const receipt: SaveReceipt = {
      status: 'persisted',
      subject: target.subject,
      local: { version: 'newer-local-version' },
      server: {
        endpoint: 'https://server.example/commit',
        commit: 'atomic:commit:x',
        version: target.version!,
      },
    };
    const serverTarget: ReplicaEvidenceTarget = {
      ...target,
      subject: receipt.subject,
      version: receipt.server!.version,
    };
    const localTarget: ReplicaEvidenceTarget = {
      ...target,
      subject: receipt.subject,
      version: receipt.local!.version,
    };
    expect(evaluateReplicaEvidence(serverTarget).status).toBe('unsupported');
    expect(evaluateReplicaEvidence(localTarget).status).toBe('unsupported');
    const remote = observation();
    const policy = policyFor([remote]);
    expect(evaluateReplicaEvidence(serverTarget, [remote], policy).status).toBe(
      'satisfied',
    );
    const result = evaluateReplicaEvidence(localTarget, [remote], policy);
    expect(result.status).toBe('pending');
    expect(result.excluded[0].reason).toBe('wrong-version');
  });

  it('defaults to unsupported without inventing a source identity', () => {
    const { source: _source, ...unspecified } = target;
    const result = evaluateReplicaEvidence(unspecified);
    expect(result.status).toBe('unsupported');
    expect(result.qualifying).toEqual([]);
    expect(result.target.source).toBeUndefined();
  });

  it('accepts an exact persistent completed barrier authenticated by a trusted adapter', () => {
    const remote = observation();
    const result = evaluateReplicaEvidence(
      target,
      [remote],
      policyFor([remote]),
    );
    expect(result.status).toBe('satisfied');
    expect(result.qualifying).toEqual([remote]);
    expect(result.excluded).toEqual([]);
  });

  it('does not infer authentication from a known provider name or evidence ID', () => {
    const verified = observation();
    const forged = {
      ...verified,
      barrier: { ...verified.barrier!, name: 'forged-flush' },
    };
    const result = evaluateReplicaEvidence(
      target,
      [forged],
      policyFor([verified]),
    );
    expect(result.status).toBe('unknown');
    expect(result.excluded[0].reason).toBe('untrusted');
  });

  it('reports supported observations without a policy as unknown', () => {
    const result = evaluateReplicaEvidence(target, [observation()]);
    expect(result.status).toBe('unknown');
    expect(result.excluded[0].reason).toBe('policy-missing');
  });

  it.each([
    ['unsupported', 'unsupported', 'unsupported'],
    ['unknown', 'unknown', 'capability-unknown'],
  ] as const)(
    'handles %s capability without consulting policy',
    (capability, status, reason) => {
      const remote = { ...observation(), capability };
      const assess = vi.fn();
      const result = evaluateReplicaEvidence(target, [remote], { assess });
      expect(result.status).toBe(status);
      expect(result.excluded[0].reason).toBe(reason);
      expect(assess).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['trust', 'unknown', 'trust-unknown', 'unknown'],
    ['generation', 'unknown', 'generation-unknown', 'unknown'],
    ['generation', 'stale', 'generation-stale', 'pending'],
    ['independence', 'unknown', 'independence-unknown', 'unknown'],
    ['independence', 'shared', 'not-independent', 'pending'],
  ] as const)('rejects %s=%s', (field, value, reason, status) => {
    const remote = observation();
    const result = evaluateReplicaEvidence(
      target,
      [remote],
      policyFor([remote], { [field]: value }),
    );
    expect(result.status).toBe(status);
    expect(result.excluded[0].reason).toBe(reason);
    expect(result.qualifying).toEqual([]);
  });

  it.each([
    undefined,
    { storageId: '', generation: 'x' },
    { storageId: 'x', generation: '' },
  ])(
    'requires complete source and destination storage identities (%j)',
    identity => {
      const remote = observation();
      const policy = policyFor([remote]);
      expect(
        evaluateReplicaEvidence(
          { ...target, source: identity },
          [remote],
          policy,
        ).status,
      ).toBe('unknown');
      expect(
        evaluateReplicaEvidence(
          target,
          [{ ...remote, replica: identity }],
          policy,
        ).excluded[0].reason,
      ).toBe('identity-unknown');
    },
  );

  it.each(['source-generation', 'new-generation'])(
    'excludes another tab on the same store, generation %s',
    generation => {
      const remote = {
        ...observation(),
        replica: { ...target.source!, generation },
      };
      const result = evaluateReplicaEvidence(
        target,
        [remote],
        policyFor([remote]),
      );
      expect(result.status).toBe('pending');
      expect(result.excluded[0].reason).toBe('same-storage');
    },
  );

  it('distinguishes separate storage from a separate device', () => {
    const remote = observation();
    const sharedDevice = {
      ...remote,
      replica: { ...remote.replica!, deviceId: target.source!.deviceId },
    };
    const policy = policyFor([sharedDevice]);
    expect(evaluateReplicaEvidence(target, [sharedDevice], policy).status).toBe(
      'satisfied',
    );
    const result = evaluateReplicaEvidence(
      { ...target, scope: 'device' },
      [sharedDevice],
      policy,
    );
    expect(result.status).toBe('pending');
    expect(result.excluded[0].reason).toBe('shared-device');
  });

  it('uses explicit trusted device independence without requiring device-label disclosure', () => {
    const remote = {
      ...observation(),
      replica: { storageId: 'remote-db', generation: 'remote-generation' },
    };
    const privateTarget: ReplicaEvidenceTarget = {
      ...target,
      scope: 'device',
      source: { storageId: 'source-db', generation: 'source-generation' },
    };
    expect(
      evaluateReplicaEvidence(privateTarget, [remote], policyFor([remote]))
        .status,
    ).toBe('satisfied');
    expect(
      evaluateReplicaEvidence(
        privateTarget,
        [remote],
        policyFor([remote], { independence: 'unknown' }),
      ).status,
    ).toBe('unknown');
  });

  it.each([
    ['subject', 'atomic:another', 'wrong-subject', 'pending'],
    ['version', 'later-version', 'wrong-version', 'pending'],
    ['version', null, 'wrong-version', 'pending'],
    ['storage', 'memory', 'not-persistent', 'pending'],
    ['storage', 'unknown', 'durability-unknown', 'unknown'],
    ['state', 'pending', 'barrier-incomplete', 'pending'],
    ['state', 'failed', 'barrier-incomplete', 'pending'],
    ['name', '', 'barrier-unnamed', 'pending'],
  ] as const)('rejects barrier %s=%s', (field, value, reason, status) => {
    const remote = observation();
    const candidate = {
      ...remote,
      barrier: { ...remote.barrier!, [field]: value },
    };
    const result = evaluateReplicaEvidence(
      target,
      [candidate],
      policyFor([candidate]),
    );
    expect(result.status).toBe(status);
    expect(result.excluded[0].reason).toBe(reason);
    expect(result.qualifying).toEqual([]);
  });

  it.each([null, '', '   '])(
    'never qualifies an unversioned target (%j)',
    version => {
      const remote = {
        ...observation(),
        barrier: { ...observation().barrier!, version },
      };
      const result = evaluateReplicaEvidence(
        { ...target, version },
        [remote],
        policyFor([remote]),
      );
      expect(result.status).toBe('unknown');
      expect(result.excluded[0].reason).toBe('invalid-target');
    },
  );

  it('does not treat ordinary server acceptance or legacy ACKs as a storage barrier', () => {
    const remote = {
      ...observation(),
      barrier: undefined,
      server: {
        endpoint: 'https://server.example/commit',
        commit: 'atomic:commit:x',
        version: target.version,
      },
      ack: true,
    };
    const { server: _server, ack: _ack, ...record } = remote;
    const result = evaluateReplicaEvidence(
      target,
      [remote],
      policyFor([record]),
    );
    expect(result.status).toBe('pending');
    expect(result.excluded[0].reason).toBe('no-barrier');
  });

  it('fails closed when policy throws or returns malformed values', () => {
    const remote = observation();
    const throwing = evaluateReplicaEvidence(target, [remote], {
      assess: () => {
        throw new Error('verification unavailable');
      },
    });
    expect(throwing.status).toBe('unknown');
    expect(throwing.excluded[0].reason).toBe('policy-error');
    const malformed = evaluateReplicaEvidence(target, [remote], {
      assess: () =>
        ({
          trust: true,
          generation: true,
          independence: true,
        }) as unknown as ReplicaEvidenceAssessment,
    });
    expect(malformed.status).toBe('unknown');
    expect(malformed.qualifying).toEqual([]);
  });

  it('captures a mutable scope getter once rather than weakening its requirement', () => {
    const remote = observation();
    let reads = 0;
    const changing = {
      ...target,
      get scope() {
        return (
          ++reads === 1 ? 'invalid' : 'device'
        ) as ReplicaEvidenceTarget['scope'];
      },
    };
    const result = evaluateReplicaEvidence(
      changing,
      [remote],
      policyFor([remote]),
    );
    expect(reads).toBe(1);
    expect(result.status).toBe('unknown');
    expect(result.excluded[0].reason).toBe('invalid-target');
  });

  it('deduplicates qualifying identities without discarding a later completed barrier', () => {
    const complete = observation();
    const waiting = {
      ...complete,
      evidenceId: 'waiting',
      barrier: { ...complete.barrier!, state: 'pending' as const },
    };
    const result = evaluateReplicaEvidence(
      target,
      [waiting, complete, complete],
      policyFor([waiting, complete]),
    );
    expect(result.status).toBe('satisfied');
    expect(result.qualifying).toEqual([complete]);
    expect(result.excluded[0].reason).toBe('barrier-incomplete');
  });

  it('detaches and freezes the complete input snapshot before invoking policy', () => {
    const first = observation();
    const second = {
      ...observation(),
      evidenceId: 'second',
      replica: { storageId: 'second-db', generation: 'second-generation' },
      barrier: { ...observation().barrier!, state: 'pending' as const },
    };
    const mutableTarget = { ...target, source: { ...target.source! } };
    const policy = policyFor([first, second]);
    const original = policy.assess;
    const result = evaluateReplicaEvidence(mutableTarget, [first, second], {
      assess: (captured, candidate) => {
        expect(Object.isFrozen(captured)).toBe(true);
        expect(Object.isFrozen(captured.source)).toBe(true);
        expect(Object.isFrozen(candidate)).toBe(true);
        expect(Object.isFrozen(candidate.replica)).toBe(true);
        expect(Object.isFrozen(candidate.barrier)).toBe(true);
        mutableTarget.subject = 'atomic:mutated';
        Object.assign(second.barrier, { state: 'completed' });

        return original(captured, candidate);
      },
    });
    expect(result.target.subject).toBe(target.subject);
    expect(result.qualifying).toEqual([first]);
    expect(result.excluded[0].reason).toBe('barrier-incomplete');
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.qualifying)).toBe(true);
    expect(Object.isFrozen(result.excluded)).toBe(true);
    expect(Object.isFrozen(result.excluded[0])).toBe(true);
    Object.assign(first.barrier!, { name: 'mutated afterwards' });
    expect(result.qualifying[0].barrier!.name).toBe('adapter-confirmed-flush');
  });
});

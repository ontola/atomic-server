import { describe, it, expect } from 'vitest';
import {
  reduceFlatState,
  type DurableSyncRun,
  type DurableEntityObservation,
} from './builtinSyncFlatState.js';
const run = (
  id: string,
  order: number,
  rule = 'a',
  complete = true,
  entityKeys = ['repo:7'],
): DurableSyncRun => ({
  ruleSubject: 'atomic:rule-' + rule,
  ruleKey: rule,
  runId: id,
  generation: 'generation-' + id,
  startOrder: order,
  complete,
  entityKeys,
});
const observation = (
  r: DurableSyncRun,
  fields: DurableEntityObservation['fields'],
  representationKey = 'full',
  entityKey = 'repo:7',
): DurableEntityObservation => ({
  runId: r.runId,
  generation: r.generation,
  ruleKey: r.ruleKey,
  entityKey,
  representationKey,
  partitionKey: r.ruleKey,
  fields,
});
describe('durable flat collection reconciliation', () => {
  it('unions overlapping root and organization memberships for the same entity', () => {
    const root = run('root', 1),
      org = run('org', 2, 'org');
    const state = reduceFlatState({
      runs: [root, org],
      observations: [
        observation(root, { name: { kind: 'value', value: 'Repository' } }),
        observation(org, { name: { kind: 'value', value: 'Repository' } }),
      ],
    });
    expect(Object.keys(state)).toEqual(['repo:7']);
    expect(state['repo:7'].memberships).toEqual([
      'atomic:rule-a',
      'atomic:rule-org',
    ]);
  });
  it('replaces only a complete exact rule membership and retains cached field evidence', () => {
    const first = run('first', 1),
      other = run('other', 2, 'other'),
      empty = run('empty', 3, 'a', true, []);
    const state = reduceFlatState({
      runs: [first, other, empty],
      observations: [
        observation(first, { name: { kind: 'value', value: 'Kept' } }),
      ],
    });
    expect(state['repo:7']).toEqual({
      values: { name: 'Kept' },
      cleared: [],
      memberships: ['atomic:rule-other'],
    });
  });
  it.each(['partial', 'unauthorized', 'cancelled', 'budget'])(
    'retains old membership and accepted new rows after %s',
    kind => {
      const first = run('first', 1),
        partial = run(kind, 2, 'a', false, ['repo:8']);
      const state = reduceFlatState({
        runs: [first, partial],
        observations: [
          observation(first, { name: { kind: 'value', value: 'Old' } }),
          observation(
            partial,
            { name: { kind: 'value', value: 'New' } },
            'full',
            'repo:8',
          ),
        ],
      });
      expect(state['repo:7'].memberships).toEqual(['atomic:rule-a']);
      expect(state['repo:8'].memberships).toEqual(['atomic:rule-a']);
    },
  );
  it('does not let absent observations erase another representation', () => {
    const full = run('full', 1),
      narrow = run('narrow', 2, 'narrow');
    const result = reduceFlatState({
      runs: [full, narrow],
      observations: [
        observation(full, {
          body: { kind: 'value', value: 'Rich detail' },
          name: { kind: 'value', value: 'Name' },
        }),
        observation(
          narrow,
          { body: { kind: 'absent' }, name: { kind: 'absent' } },
          'narrow',
        ),
      ],
    });
    expect(result['repo:7'].values).toEqual({
      body: 'Rich detail',
      name: 'Name',
    });
  });
  it('applies the latest explicit null across representations', () => {
    const full = run('full', 1),
      narrow = run('narrow', 2, 'narrow');
    const state = reduceFlatState({
      runs: [full, narrow],
      observations: [
        observation(full, { body: { kind: 'value', value: 'Old detail' } }),
        observation(narrow, { body: { kind: 'null' } }, 'narrow'),
      ],
    });
    expect(state['repo:7']).toMatchObject({ values: {}, cleared: ['body'] });
  });
  it('clears an owned property on its latest explicit null and ignores stale arrivals', () => {
    const old = run('old', 1),
      latest = run('latest', 2);
    const evidence = [
      observation(latest, { body: { kind: 'null' } }),
      observation(old, { body: { kind: 'value', value: 'Stale' } }),
    ];
    expect(
      reduceFlatState({ runs: [latest, old], observations: evidence })[
        'repo:7'
      ],
    ).toMatchObject({ values: {}, cleared: ['body'] });
  });
  it('replays a persisted accepted observation after cancellation before prefix acknowledgement', () => {
    const partial = run('cancelled', 2, 'a', false, []);
    const result = reduceFlatState({
      runs: [partial],
      observations: [
        observation(partial, { name: { kind: 'value', value: 'Recovered' } }),
      ],
    });
    expect(result['repo:7']).toEqual({
      values: { name: 'Recovered' },
      cleared: [],
      memberships: ['atomic:rule-a'],
    });
    expect(partial.entityKeys).toEqual([]);
  });

  it('retains missing raw binding evidence without replacing explicit null or mutating observations', () => {
    const old = run('old', 1),
      newer = run('new', 2, 'other');
    const first = {
      ...observation(old, { name: { kind: 'value', value: 'Name' } }),
      raw: { id: 7, owner: { id: 8, handle: 'old' }, description: 'Rich' },
    };
    const second = {
      ...observation(newer, { name: { kind: 'absent' } }),
      raw: { id: 7, owner: { handle: 'new' }, description: null },
    };
    const state = reduceFlatState({
      runs: [old, newer],
      observations: [second, first],
    });
    expect(state['repo:7'].raw).toEqual({
      id: 7,
      owner: { id: 8, handle: 'new' },
      description: null,
    });
    expect(first.raw.owner.handle).toBe('old');
    expect(
      reduceFlatState({ runs: [newer, old], observations: [first, second] }),
    ).toEqual(state);
  });

  it('uses the same Unicode codepoint order for raw and projected evidence ties', () => {
    const same = run('same-run', 1);
    const observations = ['z', 'ä'].map(name => ({
      ...observation(same, { name: { kind: 'value', value: name } }),
      raw: { name },
    }));
    const state = reduceFlatState({ runs: [same], observations })['repo:7'];
    expect(state.values.name).toBe('ä');
    expect(state.raw?.name).toBe(state.values.name);
    expect(
      reduceFlatState({
        runs: [same],
        observations: [...observations].reverse(),
      })['repo:7'],
    ).toEqual(state);
  });

  it('rejects mismatched generations and deterministically resolves overlapping field evidence', () => {
    const old = run('old', 1),
      newer = run('new', 2, 'other');
    const values = [
      observation(old, { name: { kind: 'value', value: 'Old' } }),
      observation(newer, { name: { kind: 'value', value: 'New' } }),
      {
        ...observation(newer, { name: { kind: 'value', value: 'Forged' } }),
        generation: 'stale',
      },
    ];
    const forward = reduceFlatState({
      runs: [old, newer],
      observations: values,
    });
    expect(forward['repo:7'].values).toEqual({ name: 'New' });
    expect(
      reduceFlatState({
        runs: [newer, old],
        observations: [...values].reverse(),
      }),
    ).toEqual(forward);
  });
});

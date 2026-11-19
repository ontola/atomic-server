import { describe, expect, it } from 'vitest';
import {
  parseAggregates,
  parseColumnOrder,
  parseDerivedColumnSpecs,
  parseQuickAdd,
  parseRowActions,
  filterKey,
  parseFilterKey,
} from './configuration.js';

describe('stored view configuration without a backend', () => {
  it('reads legacy running durations without requiring an end property', () => {
    expect(
      parseDerivedColumnSpecs([
        {
          id: 'elapsed',
          label: 'Elapsed',
          kind: 'elapsed',
          args: { from: 'start' },
        },
      ]),
    ).toEqual([
      {
        id: 'elapsed',
        label: 'Elapsed',
        formula: 'now() - v0',
        vars: { v0: 'start' },
        valueKind: 'duration',
      },
    ]);
  });

  it('retains saved formula formats without adding stricter validation', () => {
    const saved = {
      id: 'custom',
      label: 'Custom',
      formula: 'amount',
      vars: { amount: 'amount-property' },
      valueKind: 'future-format',
    };
    expect(parseDerivedColumnSpecs([saved])).toEqual([saved]);
    expect(
      parseDerivedColumnSpecs([{ ...saved, vars: { amount: 42 } }]),
    ).toEqual([]);
  });

  it('reads JSON actions while keeping raw configured values for the host', () => {
    const action = {
      id: 'increment',
      label: 'Add',
      kind: 'increment',
      property: 'amount',
      value: '1e',
    };
    expect(
      parseRowActions(
        JSON.stringify([null, action, { ...action, kind: 'unknown' }]),
      ),
    ).toEqual([action]);
    expect(parseRowActions('{bad-json')).toEqual([]);
  });

  it('reads quick-add presets without changing their existing draft policy', () => {
    const preset = { kind: 'setValue', property: 'status', value: 'done' };
    expect(
      parseQuickAdd(
        JSON.stringify({ label: 'Create', field: '', presets: [null, preset] }),
      ),
    ).toEqual({ label: 'Create', presets: [preset] });
    expect(parseQuickAdd('{bad-json')).toBeUndefined();
    expect(parseQuickAdd({ label: '' })).toBeUndefined();
  });

  it('keeps aggregate and column-order parsing independent of query execution', () => {
    const aggregate = {
      id: 'sum',
      function: 'sum',
      property: 'amount',
      row: 0,
    };
    expect(
      parseAggregates([null, aggregate, { ...aggregate, function: 'unknown' }]),
    ).toEqual([aggregate]);
    expect(parseColumnOrder(['name', 42, 'derived:elapsed', null])).toEqual([
      'name',
      'derived:elapsed',
    ]);
    expect(
      parseFilterKey(
        filterKey({ derived: 'elapsed', operator: 'gte', value: '1' }),
      ),
    ).toEqual({ derived: 'elapsed' });
  });
});

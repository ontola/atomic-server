// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import type { JSONSchema7 } from 'ai';
import { configFields, fieldError, onboardingSteps } from './configFormLogic';

const schema: JSONSchema7 = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
    count: { type: 'integer', minimum: 1, maximum: 5 },
    mode: { type: 'string', enum: ['a', 'b'] },
    on: { type: 'boolean' },
  },
};

describe('configFields', () => {
  it('lists flat scalar fields with their required flag', () => {
    const fields = configFields(schema)!;
    expect(fields.map(f => [f.key, f.type, f.required])).toEqual([
      ['name', 'string', true],
      ['count', 'integer', false],
      ['mode', 'string', false],
      ['on', 'boolean', false],
    ]);
  });

  it('refuses schemas the form cannot render', () => {
    expect(configFields(undefined)).toBeUndefined();
    expect(configFields({ type: 'object' })).toBeUndefined();
    expect(
      configFields({
        type: 'object',
        properties: { a: { type: 'object', properties: {} } },
      }),
    ).toBeUndefined();
    expect(
      configFields({
        type: 'object',
        properties: { a: { type: 'array', items: { type: 'string' } } },
      }),
    ).toBeUndefined();
  });
});

describe('fieldError', () => {
  const f = Object.fromEntries(configFields(schema)!.map(x => [x.key, x]));

  it('requires required fields only', () => {
    expect(fieldError(f.name, '')).toMatch(/required/);
    expect(fieldError(f.count, undefined)).toBeUndefined();
  });

  it('checks numbers, bounds and enums', () => {
    expect(fieldError(f.count, 2.5)).toMatch(/whole/);
    expect(fieldError(f.count, 0)).toMatch(/at least 1/);
    expect(fieldError(f.count, 6)).toMatch(/at most 5/);
    expect(fieldError(f.count, 3)).toBeUndefined();
    expect(fieldError(f.mode, 'c')).toBeDefined();
    expect(fieldError(f.mode, 'a')).toBeUndefined();
  });
});

describe('onboardingSteps', () => {
  it('marks access done once active', () => {
    expect(onboardingSteps({ active: false, config: {} })).toEqual([
      { id: 'access', done: false },
    ]);
  });

  it('adds a config step when the schema requires fields', () => {
    expect(onboardingSteps({ active: true, schema, config: {} })).toEqual([
      { id: 'access', done: true },
      { id: 'config', done: false },
    ]);
    expect(
      onboardingSteps({ active: true, schema, config: { name: 'x' } })[1].done,
    ).toBe(true);
  });
});

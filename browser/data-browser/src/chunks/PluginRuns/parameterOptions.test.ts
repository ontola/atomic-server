import { expect, it } from 'vitest';
import {
  PARAMETER_OPTION_LOOKUPS,
  parseParameterOptions,
} from './parameterOptions';

const lookup = PARAMETER_OPTION_LOOKUPS.moneybird.administration_id;

it('turns a Moneybird administrations response into named options', () => {
  const body = JSON.stringify([
    { id: 123, name: 'Acme BV' },
    { id: '456', name: 'Side Project' },
  ]);

  expect(parseParameterOptions(body, lookup)).toEqual([
    { value: '123', label: 'Acme BV' },
    { value: '456', label: 'Side Project' },
  ]);
});

it('falls back to the id as the label when a name is missing', () => {
  expect(parseParameterOptions(JSON.stringify([{ id: 1 }]), lookup)).toEqual([
    { value: '1', label: '1' },
  ]);
});

it('skips entries without a usable id and non-array bodies', () => {
  expect(
    parseParameterOptions(
      JSON.stringify([{ name: 'no id' }, null, 'oops']),
      lookup,
    ),
  ).toEqual([]);
  expect(parseParameterOptions(JSON.stringify({ id: 1 }), lookup)).toEqual([]);
});

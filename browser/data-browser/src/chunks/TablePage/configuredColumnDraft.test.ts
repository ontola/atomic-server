import { expect, it } from 'vitest';
import {
  mergeConfiguredColumn,
  prepareConfiguredColumn,
  effectiveConfiguredColumns,
} from './configuredColumnDraft';
it('mints one unique identity without mutating the captured configuration', () => {
  const existing = [{ id: 'done', label: 'Done', kind: 'toggle' }],
    candidate = { id: '', label: 'Done', kind: 'toggle' };
  const prepared = prepareConfiguredColumn(existing, candidate);
  expect(prepared.id).toBe('done-2');
  expect(candidate.id).toBe('');
  expect(mergeConfiguredColumn(existing, prepared)).toHaveLength(2);
  expect(existing).toHaveLength(1);
  expect(mergeConfiguredColumn([...existing, prepared], prepared)).toEqual([
    ...existing,
    prepared,
  ]);
});
it('preserves the original identity and unrelated current columns across a retry', () => {
  const original = {
    id: 'elapsed',
    label: 'Elapsed',
    formula: 'a - b',
    vars: { a: 'end', b: 'start' },
    width: 222,
  };
  const desired = prepareConfiguredColumn(
    [original],
    { ...original, id: 'wrong', label: 'Local elapsed' },
    original,
  );
  const peer = {
    id: 'another',
    label: 'Peer amount',
    formula: '1.0',
    vars: {},
    width: 100,
  };
  const sameBaseline = { ...original, vars: { b: 'start', a: 'end' } };
  const merged = mergeConfiguredColumn([sameBaseline, peer], desired, original);
  expect(desired.id).toBe('elapsed');
  expect(desired.width).toBe(222);
  expect(merged[1]).toBe(peer);
  expect(mergeConfiguredColumn(merged, desired, original)).toEqual(merged);
});
it('rejects changed or removed targets instead of overwriting another column', () => {
  const original = { id: 'action', label: 'Original' },
    desired = { id: 'action', label: 'Local' };
  expect(() =>
    mergeConfiguredColumn([{ id: 'action', label: 'Peer' }], desired, original),
  ).toThrow('changed elsewhere');
  expect(() => mergeConfiguredColumn([], desired, original)).toThrow('removed');
  expect(() => mergeConfiguredColumn([original], desired)).toThrow(
    'changed elsewhere',
  );
});

it('materializes an implicit computed list while respecting an explicit empty list', () => {
  const defaults = [{ id: 'duration', label: 'Duration' }],
    implicit = { specs: defaults, signature: 'timer-settings' };
  expect(
    effectiveConfiguredColumns([], false, 'timer-settings', implicit),
  ).toBe(defaults);
  expect(
    effectiveConfiguredColumns([], true, 'changed-settings', implicit),
  ).toEqual([]);
  expect(() =>
    effectiveConfiguredColumns([], false, 'changed-settings', implicit),
  ).toThrow('implicit column settings changed');
});

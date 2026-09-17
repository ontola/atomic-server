import { expect, it } from 'vitest';
import { columnLabel } from './columnLabel';

it('presents a shortname standing in for a missing name as a label', () => {
  // The core `name` property has no name of its own, so `useTitle` and
  // `Resource.title` both hand back its shortname.
  expect(columnLabel('name', 'name')).toBe('Name');
  expect(columnLabel(undefined, 'pet-species')).toBe('Pet species');
  expect(columnLabel('', 'last-watered')).toBe('Last watered');
});

it('leaves an authored name exactly as it was written', () => {
  expect(columnLabel('iPhone model', 'phone-model')).toBe('iPhone model');
  expect(columnLabel('Species', 'pet-species')).toBe('Species');
});

it('passes through what a title says while loading or on error', () => {
  expect(columnLabel('...', 'name')).toBe('...');
  expect(columnLabel('atomicdata.dev/proper...', 'name')).toBe(
    'atomicdata.dev/proper...',
  );
});

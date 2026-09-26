import { expect, it } from 'vitest';
import { columnLabel } from './columnLabel';

it('presents a shortname standing in for a missing name as a label', () => {
  // The core `name` property has no name of its own, so a column pointing at it
  // has nothing but its shortname to go on.
  expect(columnLabel(undefined, 'name')).toBe('Name');
  expect(columnLabel(undefined, 'pet-species')).toBe('Pet species');
  expect(columnLabel('', 'last-watered')).toBe('Last watered');
});

it('leaves an authored name exactly as it was written', () => {
  expect(columnLabel('iPhone model', 'phone-model')).toBe('iPhone model');
  expect(columnLabel('Species', 'pet-species')).toBe('Species');
  // Authored in lowercase, and authored with a dash someone meant: neither is
  // this function's to correct.
  expect(columnLabel('tagline', 'tagline')).toBe('tagline');
  expect(columnLabel('well-being', 'well-being')).toBe('well-being');
});

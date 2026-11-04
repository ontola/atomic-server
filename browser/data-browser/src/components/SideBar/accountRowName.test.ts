// @wc-ignore-file
import { expect, it } from 'vitest';
import { fallbackAccountName } from './accountRowName';

it('calls an unlinked identity a guest when there is no portal to ask', () => {
  expect(
    fallbackAccountName({
      loading: false,
      hasAccount: undefined,
      linked: false,
    }),
  ).toBe('Guest');
});

it('calls it a guest when the check settled with no account', () => {
  expect(
    fallbackAccountName({ loading: false, hasAccount: false, linked: false }),
  ).toBe('Guest');
});

it('says Signed in only with an account session or a linked identity', () => {
  expect(
    fallbackAccountName({ loading: false, hasAccount: true, linked: false }),
  ).toBe('Signed in');
  expect(
    fallbackAccountName({
      loading: false,
      hasAccount: undefined,
      linked: true,
    }),
  ).toBe('Signed in');
});

it('shows nothing while the profile loads', () => {
  expect(
    fallbackAccountName({ loading: true, hasAccount: false, linked: false }),
  ).toBe('');
});

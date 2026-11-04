// @wc-ignore-file
import { expect, it } from 'vitest';
import { fallbackAccountName, pickAccountAddress } from './accountRowName';

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

it('shows the account address for a linked identity or account session', () => {
  expect(
    fallbackAccountName({
      loading: false,
      hasAccount: true,
      linked: false,
      email: 'a@b.com',
    }),
  ).toBe('a@b.com');
  expect(
    fallbackAccountName({
      loading: false,
      hasAccount: undefined,
      linked: true,
      email: 'a@b.com',
    }),
  ).toBe('a@b.com');
});

it('says Account when a linked identity has no known address', () => {
  expect(
    fallbackAccountName({ loading: false, hasAccount: true, linked: false }),
  ).toBe('Account');
  expect(
    fallbackAccountName({
      loading: false,
      hasAccount: undefined,
      linked: true,
      email: 'acct_1234',
    }),
  ).toBe('Account');
});

it('never shows an acct_ id', () => {
  expect(pickAccountAddress('acct_1', 'me@x.io')).toBe('me@x.io');
  expect(pickAccountAddress('acct_1', undefined)).toBeUndefined();
  expect(pickAccountAddress(undefined, 'me@x.io')).toBe('me@x.io');
});

it('does not show an address to a guest', () => {
  expect(
    fallbackAccountName({
      loading: false,
      hasAccount: false,
      linked: false,
      email: 'a@b.com',
    }),
  ).toBe('Guest');
});

it('shows nothing while the profile loads', () => {
  expect(
    fallbackAccountName({ loading: true, hasAccount: false, linked: false }),
  ).toBe('');
});

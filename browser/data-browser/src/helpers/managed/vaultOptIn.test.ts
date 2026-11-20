// @vitest-environment jsdom
// @wc-ignore-file
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ cookie: true }));

vi.mock('./providerCookie', () => ({
  canHoldProviderCookie: () => state.cookie,
}));

import { isVaultOptedOut, setVaultOptOut } from './vaultAutoBackup';

const drive = 'did:ad:drive1';

beforeEach(() => {
  localStorage.clear();
  state.cookie = true;
});

it('backs up by itself on the service’s own site', () => {
  expect(isVaultOptedOut(drive)).toBe(false);
});

it('waits for a click on a self-hosted node', () => {
  state.cookie = false;
  expect(isVaultOptedOut(drive)).toBe(true);

  setVaultOptOut(drive, false);
  expect(isVaultOptedOut(drive)).toBe(false);
});

it('keeps a deliberate opt-out everywhere', () => {
  setVaultOptOut(drive, true);
  expect(isVaultOptedOut(drive)).toBe(true);

  state.cookie = false;
  expect(isVaultOptedOut(drive)).toBe(true);
});

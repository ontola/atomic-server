import { describe, it, expect } from 'vitest';
import { describeMissingVaultInputs } from './useVaultBackup';

const ready = {
  db: {},
  keys: {},
  driveSubject: 'did:ad:drive',
  agentSubject: 'did:ad:agent:x',
  signer: {},
  devicePubkey: 'abc123',
};

/**
 * The vault panel used to render nothing whenever it was not ready, which made
 * "still starting" and "will never work here" identical on screen — no panel,
 * no reason, nothing to act on. This is the text that replaced the silence, so
 * it has to name the actual blocker rather than gesture at one.
 */
describe('describeMissingVaultInputs', () => {
  it('says nothing is missing when everything is present', () => {
    expect(describeMissingVaultInputs(ready)).toEqual([]);
  });

  it('names a missing local database', () => {
    expect(describeMissingVaultInputs({ ...ready, db: null })).toEqual([
      'no local database',
    ]);
  });

  /** The Tauri case: wasm never loaded, so sealing is impossible. */
  it('names keys that failed to load', () => {
    expect(describeMissingVaultInputs({ ...ready, keys: null })).toEqual([
      'the encryption keys did not load',
    ]);
  });

  /** What staging showed: a local drive, but the page never resolved one. */
  it('names a drive that never resolved', () => {
    expect(
      describeMissingVaultInputs({ ...ready, driveSubject: null }),
    ).toEqual(['no drive is open']);
  });

  /**
   * Signing needs both halves, and either one missing means the same thing to
   * a reader — so it must not produce two near-identical complaints.
   */
  it('treats a half-present identity as simply not signed in', () => {
    expect(describeMissingVaultInputs({ ...ready, signer: null })).toEqual([
      'not signed in',
    ]);
    expect(
      describeMissingVaultInputs({ ...ready, agentSubject: null }),
    ).toEqual(['not signed in']);
  });

  it('lists every blocker at once, so one fix does not reveal another', () => {
    const missing = describeMissingVaultInputs({
      db: null,
      keys: null,
      driveSubject: null,
      agentSubject: null,
      signer: null,
      devicePubkey: null,
    });

    expect(missing).toHaveLength(5);
    expect(missing.join(', ')).toContain('no local database');
    expect(missing.join(', ')).toContain('this device has no identity yet');
  });
});

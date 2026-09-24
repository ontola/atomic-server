import { describe, expect, it } from 'vitest';
import { showSavedServer, syncSummary } from './syncPresentation';
const base = {
  missing: false,
  local: true,
  serverSync: false,
  hosting: false,
  managed: true,
  vaultOn: false,
};
describe('drive-specific sync presentation', () => {
  it('does not infer a remote copy or local protection from an unreadable drive', () => {
    const summary = syncSummary({
      ...base,
      missing: true,
      vaultOn: true,
      serverSync: true,
    });
    // A failed read establishes neither where the data is nor that a backup
    // contains it. Keep this independent of the replacement wording.
    expect(summary).not.toMatch(/device that has it|lives on this device/i);
  });
  it('does not describe a vault-enabled local drive as unprotected', () => {
    expect(syncSummary({ ...base, vaultOn: true })).toContain(
      'Cloud Vault is on',
    );
  });
  it('keeps legacy server sync visible without claiming paid hosting', () => {
    expect(syncSummary({ ...base, serverSync: true })).toContain(
      'hosting has not been confirmed',
    );
    expect(showSavedServer({ managed: true, activeForDrive: true })).toBe(true);
  });
  it('hides unrelated saved servers in SaaS but preserves standalone connections', () => {
    expect(showSavedServer({ managed: true, activeForDrive: false })).toBe(
      false,
    );
    expect(showSavedServer({ managed: false, activeForDrive: false })).toBe(
      true,
    );
  });
});

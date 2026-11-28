import { afterEach, describe, expect, it, vi } from 'vitest';
import { getVaultDriveSummary, isVaultDriveSubject } from './vault';

const genesis = 'A'.repeat(86);

describe('drive-status subjects', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('accepts only a bare drive subject', () => {
    expect(isVaultDriveSubject(`atomic:${genesis}`)).toBe(true);
    expect(isVaultDriveSubject(`did:ad:${genesis}`)).toBe(true);
    expect(isVaultDriveSubject(`atomic:agent:${genesis}`)).toBe(false);
    expect(isVaultDriveSubject(`did:ad:agent:${'B'.repeat(43)}`)).toBe(false);
    expect(isVaultDriveSubject(`atomic:${genesis}?drive=x`)).toBe(false);
    expect(isVaultDriveSubject(`atomic:${genesis}/path`)).toBe(false);
    expect(isVaultDriveSubject('https://example.com/drive/abc')).toBe(false);
    expect(isVaultDriveSubject('atomic:drive1')).toBe(false);
  });

  it('does not ask the control plane about anything else', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      getVaultDriveSummary(`atomic:agent:${'B'.repeat(43)}`),
    ).resolves.toEqual({ enabled: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

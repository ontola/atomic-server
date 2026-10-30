// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHasManagedAccount } from './useHasManagedAccount';

const mocks = vi.hoisted(() => ({
  hasManagedApi: vi.fn(),
  getManagedAccount: vi.fn(),
}));

vi.mock('../helpers/managed/api', () => ({
  hasManagedApi: mocks.hasManagedApi,
}));
vi.mock('../helpers/managed/session', () => ({
  getManagedAccount: mocks.getManagedAccount,
  onManagedSessionChanged: () => () => {},
}));

describe('useHasManagedAccount', () => {
  beforeEach(() => {
    mocks.hasManagedApi.mockReset();
    mocks.getManagedAccount.mockReset();
  });

  it('is undefined without a portal', () => {
    mocks.hasManagedApi.mockReturnValue(false);
    const { result } = renderHook(() => useHasManagedAccount());

    expect(result.current).toBeUndefined();
    expect(mocks.getManagedAccount).not.toHaveBeenCalled();
  });

  it('is false once the check settled with no account', async () => {
    mocks.hasManagedApi.mockReturnValue(true);
    mocks.getManagedAccount.mockResolvedValue(null);
    const { result } = renderHook(() => useHasManagedAccount());

    expect(result.current).toBeUndefined();
    await waitFor(() => expect(result.current).toBe(false));
  });

  it('is true with an account', async () => {
    mocks.hasManagedApi.mockReturnValue(true);
    mocks.getManagedAccount.mockResolvedValue({ email: 'a@b.c' });
    const { result } = renderHook(() => useHasManagedAccount());

    await waitFor(() => expect(result.current).toBe(true));
  });
});

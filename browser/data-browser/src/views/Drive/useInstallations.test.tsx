// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ useCollection: vi.fn() }));

vi.mock('@tomic/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@tomic/react')>()),
  useCollection: mocks.useCollection,
}));

import { useInstallations } from './useInstallations';

const fakeCollection = (members: string[]) => ({
  collection: {
    totalMembers: members.length,
    getMemberWithIndex: async (i: number) => members[i],
  },
  ready: true,
});

describe('useInstallations', () => {
  it('follows the live collection when an app is installed', async () => {
    mocks.useCollection.mockReturnValue(fakeCollection([]));
    const { result, rerender } = renderHook(() => useInstallations('drive'));

    await waitFor(() => expect(result.current).toEqual([]));

    mocks.useCollection.mockReturnValue(fakeCollection(['inst1']));
    rerender();

    await waitFor(() => expect(result.current).toEqual(['inst1']));
  });
});

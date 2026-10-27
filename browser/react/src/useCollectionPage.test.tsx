import type { Collection } from '@tomic/lib';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useCollectionPage } from './useCollectionPage.js';

const fake = (read: () => Promise<string[]>) =>
  ({ getMembersOnPage: read }) as unknown as Collection;

describe('useCollectionPage', () => {
  it('ignores a slow read for an earlier collection', async () => {
    let finishOld: (members: string[]) => void = () => undefined;
    const old = fake(
      () => new Promise<string[]>(resolve => (finishOld = resolve)),
    );
    const next = fake(async () => ['a']);

    const { result, rerender } = renderHook(
      ({ collection }) => useCollectionPage(collection, 0),
      { initialProps: { collection: old } },
    );

    rerender({ collection: next });
    await waitFor(() => expect(result.current).toEqual(['a']));

    finishOld([]);
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(result.current).toEqual(['a']);
  });
});

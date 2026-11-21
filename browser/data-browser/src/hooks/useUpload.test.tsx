// @vitest-environment jsdom
import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { StoreContext } from '@tomic/react';
import { useUpload } from '@tomic/resource-ui/hooks/useUpload';
import { buildTheme, ThemeProvider } from '../../../resource-ui/test/providers';

it('shows a failed upload and passes the optimistic option to the store', async () => {
  const failure = new Error('upload refused');
  const errorHandler = vi.fn();
  const uploadFiles = vi.fn().mockRejectedValue(failure);
  const store = { uploadFiles } as never;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <ThemeProvider
      theme={buildTheme()}
      hostOverrides={{ reportError: errorHandler }}
    >
      <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
    </ThemeProvider>
  );
  const { result } = renderHook(
    () => useUpload({ subject: 'did:ad:drive' } as never, { optimistic: true }),
    { wrapper },
  );

  let uploaded: string[] = ['x'];
  await act(async () => {
    uploaded = await result.current.upload([new File(['a'], 'a.png')]);
  });

  expect(uploaded).toEqual([]);
  expect(errorHandler).toHaveBeenCalledWith(failure);
  expect(result.current.error?.message).toBe('upload refused');
  expect(uploadFiles).toHaveBeenCalledWith(expect.any(Array), 'did:ad:drive', {
    optimistic: true,
  });
});

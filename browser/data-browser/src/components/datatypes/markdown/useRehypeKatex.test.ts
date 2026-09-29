// @vitest-environment jsdom
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useRehypeKatex } from './useRehypeKatex';

describe('useRehypeKatex', () => {
  it('does not load KaTeX for text without a dollar sign', async () => {
    const { result } = renderHook(() => useRehypeKatex('plain **bold** text'));

    await new Promise(resolve => setTimeout(resolve, 50));

    expect(result.current).toBeUndefined();
  });

  it('loads the plugin once the text can contain math', async () => {
    const { result } = renderHook(() => useRehypeKatex('Energy: $E=mc^2$'));

    await waitFor(() => expect(result.current).toBeTypeOf('function'));
  });
});

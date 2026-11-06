// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { setActionsHost } from '../../embed/hostActions';
import { useAISidebar } from './AISidebarContext';

afterEach(() => setActionsHost(undefined));

it('hands an ask to the Flutter app, where the page has no sidebar', () => {
  const call = vi.fn().mockResolvedValue(true);
  setActionsHost({ call });
  const { result } = renderHook(() => useAISidebar());

  result.current.askAI({
    prompt: 'Change the board to 4x4',
    context: [{ type: 'atomic-resource', id: '1', subject: 'atomic:app' }],
  });

  expect(call).toHaveBeenCalledWith('askAssistant', [
    'Change the board to 4x4',
    'atomic:app',
  ]);
});

// @vitest-environment jsdom
// @wc-ignore-file
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useHostedAI } from './useHostedAI';
import { getHostedAIStatus, HOSTED_AI_USAGE_EVENT } from '@helpers/managed/ai';

vi.mock('@helpers/managed/ai', () => ({
  getHostedAIStatus: vi.fn(),
  HOSTED_AI_USAGE_EVENT: 'atomic-hosted-ai-usage',
}));
vi.mock('@helpers/managed/session', () => ({
  onManagedLogout: () => () => {},
}));
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.resetAllMocks();
});

it('refreshes after usage and once more after server settlement, then stops', async () => {
  vi.useFakeTimers();
  const status = (remaining_micros: number) => ({
    enabled: true,
    consent: true,
    model: 'test',
    paid: true,
    allowance_micros: 5_000_000,
    used_micros: 0,
    remaining_micros,
    resets_at: 1790812800,
  });
  vi.mocked(getHostedAIStatus)
    .mockResolvedValueOnce(status(5_000_000))
    .mockResolvedValueOnce(status(4_950_000))
    .mockResolvedValueOnce(status(4_999_123));
  const { result } = renderHook(useHostedAI);
  await act(async () => {});
  expect(result.current.hostedAI?.remaining_micros).toBe(5_000_000);
  await act(async () => {
    window.dispatchEvent(new Event(HOSTED_AI_USAGE_EVENT));
  });
  expect(result.current.hostedAI?.remaining_micros).toBe(4_950_000);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(result.current.hostedAI?.remaining_micros).toBe(4_999_123);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
  });
  expect(getHostedAIStatus).toHaveBeenCalledTimes(3);
});

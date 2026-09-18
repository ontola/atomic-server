import type { AIModelIdentifier } from './types';
import { useAIModels } from './useAIModels';

export const FALLBACK_CONTEXT_LENGTH = 100_000;

export function getAutoCompactTokenThreshold(
  contextLength: number | undefined,
  percent: number,
): number | null {
  if (percent <= 0) {
    return null;
  }

  const ctx = contextLength ?? FALLBACK_CONTEXT_LENGTH;

  return Math.floor(ctx * (percent / 100));
}

export function useModelContextLength(
  model: AIModelIdentifier | undefined,
): number | undefined {
  const { getContextLength } = useAIModels();

  if (!model) {
    return undefined;
  }

  return getContextLength(model.id);
}

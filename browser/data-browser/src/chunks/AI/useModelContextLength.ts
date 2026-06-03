import { AIProvider } from '@components/AI/aiContstants';
import type { AIModelIdentifier } from './types';
import { useOpenRouterModels } from './useOpenRouterModels';
import { useOllamaModelContextLength } from './useOllamaModelContext';

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
  const { getORModelContextLength } = useOpenRouterModels();
  const ollamaLength = useOllamaModelContextLength(
    model?.provider === AIProvider.Ollama ? model.id : undefined,
  );

  if (!model) {
    return undefined;
  }

  if (model.provider === AIProvider.OpenRouter) {
    return getORModelContextLength(model.id);
  }

  if (model.provider === AIProvider.Ollama) {
    return ollamaLength;
  }

  return undefined;
}

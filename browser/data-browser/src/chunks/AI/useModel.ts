import { createOllama } from 'ollama-ai-provider-v2';
import type { AIModelIdentifier } from './types';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { AIProvider } from '@components/AI/aiContstants';
import { useAISettings } from '@components/AI/AISettingsContext';
import type { LanguageModel } from 'ai';

const createOpenRouterProvider = (openRouterApiKey: string) => {
  return createOpenRouter({
    apiKey: openRouterApiKey,
    compatibility: 'strict',
    extraBody: {
      transforms: ['middle-out'],
    },
  });
};

const createOllamaProvider = (ollamaUrl: string) => {
  return createOllama({
    baseURL: `${ollamaUrl}/api`,
  });
};

export function useGetModel(): (
  identifier: AIModelIdentifier,
) => LanguageModel | undefined {
  const { openRouterApiKey, ollamaUrl, isProviderEnabled } = useAISettings();

  return (identifier: AIModelIdentifier): LanguageModel | undefined => {
    if (!isProviderEnabled(identifier.provider)) {
      return undefined;
    }

    if (identifier.provider === AIProvider.OpenRouter) {
      if (!openRouterApiKey) {
        return undefined;
      }

      return createOpenRouterProvider(openRouterApiKey)(identifier.id);
    }

    if (identifier.provider === AIProvider.Ollama) {
      if (!ollamaUrl) {
        return undefined;
      }

      return createOllamaProvider(ollamaUrl)(identifier.id);
    }
  };
}

import { createOllama } from 'ollama-ai-provider-v2';
import type { AIModelIdentifier } from './types';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { AIProvider } from '@components/AI/aiContstants';
import { useAISettings } from '@components/AI/AISettingsContext';
import type { LanguageModel } from 'ai';

export const ORCAROUTER_BASE_URL = 'https://api.orcarouter.ai/v1';

const createOpenRouterProvider = (openRouterApiKey: string) => {
  return createOpenRouter({
    apiKey: openRouterApiKey,
    compatibility: 'strict',
    extraBody: {
      transforms: ['middle-out'],
    },
  });
};

const createOrcaRouterProvider = (orcarouterApiKey: string) => {
  return createOpenAICompatible({
    name: 'orcarouter',
    baseURL: ORCAROUTER_BASE_URL,
    apiKey: orcarouterApiKey,
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
  const { openRouterApiKey, orcarouterApiKey, ollamaUrl, isProviderAvailable } =
    useAISettings();

  return (identifier: AIModelIdentifier): LanguageModel | undefined => {
    if (!isProviderAvailable(identifier.provider)) {
      return undefined;
    }

    if (identifier.provider === AIProvider.OpenRouter) {
      if (!openRouterApiKey) {
        return undefined;
      }

      return createOpenRouterProvider(openRouterApiKey)(identifier.id);
    }

    if (identifier.provider === AIProvider.OrcaRouter) {
      if (!orcarouterApiKey) {
        return undefined;
      }

      return createOrcaRouterProvider(orcarouterApiKey)(identifier.id);
    }

    if (identifier.provider === AIProvider.Ollama) {
      if (!ollamaUrl) {
        return undefined;
      }

      return createOllamaProvider(ollamaUrl)(identifier.id);
    }
  };
}

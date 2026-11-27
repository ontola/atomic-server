import { createOllama } from 'ollama-ai-provider-v2';
import type { AIModelIdentifier } from './types';
import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { AIProvider } from '@components/AI/aiContstants';
import { useAISettings } from '@components/AI/AISettingsContext';
import type { LanguageModel } from 'ai';
import { createHostedModel } from './hostedModel';

const createOpenRouterProvider = (openRouterApiKey: string, zdr: boolean) => {
  return createOpenRouter({
    apiKey: openRouterApiKey,
    compatibility: 'strict',
    extraBody: {
      transforms: ['middle-out'],
      ...(zdr ? { provider: { zdr: true } } : {}),
    },
  });
};

const createOllamaProvider = (ollamaUrl: string) => {
  return createOllama({
    baseURL: `${ollamaUrl}/api`,
  });
};

export interface ModelSettings {
  openRouterApiKey: string | undefined;
  ollamaEndpoint: string | undefined;
  openRouterZdr: boolean;
  isProviderAvailable: (provider: AIProvider) => boolean;
}

/** Builds the model for an identifier from the AI settings. Not a hook. */
export function resolveModel(
  identifier: AIModelIdentifier,
  {
    openRouterApiKey,
    ollamaEndpoint,
    isProviderAvailable,
    openRouterZdr,
  }: ModelSettings,
): LanguageModel | undefined {
  if (!isProviderAvailable(identifier.provider)) {
    return undefined;
  }

  if (identifier.provider === AIProvider.Hosted)
    return createHostedModel(identifier.id);

  if (identifier.provider === AIProvider.OpenRouter) {
    if (!openRouterApiKey) {
      return undefined;
    }

    return createOpenRouterProvider(
      openRouterApiKey,
      openRouterZdr,
    )(identifier.id);
  }

  if (identifier.provider === AIProvider.Ollama) {
    if (!ollamaEndpoint) {
      return undefined;
    }

    return createOllamaProvider(ollamaEndpoint)(identifier.id);
  }
}

export function useGetModel(): (
  identifier: AIModelIdentifier,
) => LanguageModel | undefined {
  const settings = useAISettings();

  return (identifier: AIModelIdentifier): LanguageModel | undefined =>
    resolveModel(identifier, settings);
}

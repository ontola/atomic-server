import { AIProvider } from './aiContstants';
import { useIsOllamaUrlValid } from './useIsOllamaUrlValid';
import { isProviderConfigured } from '@chunks/AI/providers';

export const useProviderAvailability = (
  openRouterApiKey: string | undefined,
  ollamaUrl: string | undefined,
  openAICompatibleApiKey: string | undefined,
  openAICompatibleBaseUrl: string | undefined,
) => {
  const openRouterAvailable = Boolean(openRouterApiKey);
  const { valid: ollamaAvailable, checking: ollamaChecking } =
    useIsOllamaUrlValid(ollamaUrl);
  const openAICompatibleAvailable = isProviderConfigured(
    AIProvider.OpenAICompatible,
    {
      openAICompatibleApiKey,
      openAICompatibleBaseUrl,
    },
  );

  const credentials = {
    openRouterApiKey,
    ollamaUrl,
    openAICompatibleApiKey,
    openAICompatibleBaseUrl,
  };

  const isProviderAvailable = (provider: AIProvider) => {
    if (provider === AIProvider.OpenRouter) {
      return openRouterAvailable;
    }

    if (provider === AIProvider.Ollama) {
      return ollamaAvailable;
    }

    if (provider === AIProvider.OpenAICompatible) {
      return openAICompatibleAvailable;
    }

    return false;
  };

  const availableProviders: AIProvider[] = [];

  if (openRouterAvailable) {
    availableProviders.push(AIProvider.OpenRouter);
  }

  if (openAICompatibleAvailable) {
    availableProviders.push(AIProvider.OpenAICompatible);
  }

  if (ollamaAvailable) {
    availableProviders.push(AIProvider.Ollama);
  }

  return {
    openRouterAvailable,
    ollamaAvailable,
    ollamaChecking,
    openAICompatibleAvailable,
    isProviderAvailable,
    availableProviders,
    credentials,
  };
};

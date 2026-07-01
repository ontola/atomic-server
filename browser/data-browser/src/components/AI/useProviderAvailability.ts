import { AIProvider } from './aiContstants';
import { useIsOllamaUrlValid } from './useIsOllamaUrlValid';

export const useProviderAvailability = (
  openRouterApiKey: string | undefined,
  ollamaUrl: string | undefined,
) => {
  const openRouterAvailable = Boolean(openRouterApiKey);
  const { valid: ollamaAvailable, checking: ollamaChecking } =
    useIsOllamaUrlValid(ollamaUrl);

  const isProviderAvailable = (provider: AIProvider) => {
    if (provider === AIProvider.OpenRouter) {
      return openRouterAvailable;
    }

    if (provider === AIProvider.Ollama) {
      return ollamaAvailable;
    }

    return false;
  };

  const availableProviders: AIProvider[] = [];

  if (openRouterAvailable) {
    availableProviders.push(AIProvider.OpenRouter);
  }

  if (ollamaAvailable) {
    availableProviders.push(AIProvider.Ollama);
  }

  return {
    openRouterAvailable,
    ollamaAvailable,
    ollamaChecking,
    isProviderAvailable,
    availableProviders,
  };
};

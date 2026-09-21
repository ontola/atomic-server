import { AIProvider } from './aiContstants';
import { useIsOllamaUrlValid } from './useIsOllamaUrlValid';

export const useProviderAvailability = (
  openRouterApiKey: string | undefined,
  ollamaUrl: string | undefined,
  hostedAvailable = false,
) => {
  const openRouterAvailable = Boolean(openRouterApiKey);
  const { valid: ollamaAvailable, checking: ollamaChecking } =
    useIsOllamaUrlValid(ollamaUrl);

  const isProviderAvailable = (provider: AIProvider) => {
    if (provider === AIProvider.Hosted) return hostedAvailable;

    if (provider === AIProvider.OpenRouter) {
      return openRouterAvailable;
    }

    if (provider === AIProvider.Ollama) {
      return ollamaAvailable;
    }

    return false;
  };

  const availableProviders: AIProvider[] = [];
  if (hostedAvailable) availableProviders.push(AIProvider.Hosted);

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

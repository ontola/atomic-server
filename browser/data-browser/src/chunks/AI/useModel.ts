import type { AIModelIdentifier } from './types';
import { useAISettings } from '@components/AI/AISettingsContext';
import type { LanguageModel } from 'ai';
import { createLanguageModel } from './providers';

export function useGetModel(): (
  identifier: AIModelIdentifier,
) => LanguageModel | undefined {
  const {
    openRouterApiKey,
    ollamaUrl,
    openAICompatibleApiKey,
    openAICompatibleBaseUrl,
    isProviderAvailable,
  } = useAISettings();

  return (identifier: AIModelIdentifier): LanguageModel | undefined => {
    if (!isProviderAvailable(identifier.provider)) {
      return undefined;
    }

    return createLanguageModel({
      model: identifier,
      credentials: {
        openRouterApiKey,
        ollamaUrl,
        openAICompatibleApiKey,
        openAICompatibleBaseUrl,
      },
    });
  };
}

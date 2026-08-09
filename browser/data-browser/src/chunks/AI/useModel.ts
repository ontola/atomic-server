import type { AIModelIdentifier } from './types';
import { useAISettings } from '@components/AI/AISettingsContext';
import type { LanguageModel } from 'ai';
import { createEndpointModel, isEndpointConfigured } from './aiEndpoint';

export function useGetModel(): (
  identifier: AIModelIdentifier,
) => LanguageModel | undefined {
  const { aiBaseUrl, aiApiKey, isAIAvailable } = useAISettings();

  return (identifier: AIModelIdentifier): LanguageModel | undefined => {
    if (
      !isAIAvailable ||
      !isEndpointConfigured(aiBaseUrl, aiApiKey) ||
      !aiBaseUrl
    ) {
      return undefined;
    }

    return createEndpointModel(identifier.id, {
      baseUrl: aiBaseUrl,
      apiKey: aiApiKey,
    });
  };
}

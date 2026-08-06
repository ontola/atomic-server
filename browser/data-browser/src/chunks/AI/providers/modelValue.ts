import { AIProvider } from '@components/AI/aiContstants';
import type { AIModelIdentifier } from '../types';
import type { ProviderCredentials } from './types';

/** ComboBox / recent-models value: `providerPrefix:modelId`. */
export function serializeModelValue(model: AIModelIdentifier): string {
  return `${model.provider}:${model.id}`;
}

export function parseModelValue(value: string): AIModelIdentifier | undefined {
  const separator = value.indexOf(':');

  if (separator <= 0) {
    return undefined;
  }

  const providerStr = value.slice(0, separator);
  const id = value.slice(separator + 1);

  if (!id) {
    return undefined;
  }

  if (providerStr === AIProvider.OpenRouter) {
    return { id, provider: AIProvider.OpenRouter };
  }

  if (providerStr === AIProvider.Ollama) {
    return { id, provider: AIProvider.Ollama };
  }

  if (providerStr === AIProvider.OpenAICompatible) {
    return { id, provider: AIProvider.OpenAICompatible };
  }

  return undefined;
}

export function getProviderLabel(
  provider: AIProvider,
  credentials?: ProviderCredentials,
): string {
  if (provider === AIProvider.OpenRouter) {
    return 'OpenRouter';
  }

  if (provider === AIProvider.Ollama) {
    return credentials?.ollamaUrl
      ? `Ollama at ${credentials.ollamaUrl}`
      : 'Ollama';
  }

  if (provider === AIProvider.OpenAICompatible) {
    return credentials?.openAICompatibleBaseUrl
      ? `OpenAI-compatible (${credentials.openAICompatibleBaseUrl})`
      : 'OpenAI-compatible';
  }

  return 'the model provider';
}

export function getProviderUnavailableNotice(
  provider: AIProvider,
  credentials?: ProviderCredentials,
): string {
  if (provider === AIProvider.Ollama) {
    return `Can't reach Ollama${credentials?.ollamaUrl ? ` at ${credentials.ollamaUrl}` : ''}. Make sure it's running, or switch to a cloud model — you can keep typing in the meantime.`;
  }

  if (provider === AIProvider.OpenRouter) {
    return 'No OpenRouter API key is set. Add one or switch to another provider — you can keep typing in the meantime.';
  }

  if (provider === AIProvider.OpenAICompatible) {
    if (!credentials?.openAICompatibleBaseUrl) {
      return 'No OpenAI-compatible base URL is set. Add one in settings — you can keep typing in the meantime.';
    }

    if (!credentials?.openAICompatibleApiKey) {
      return 'No OpenAI-compatible API key is set. Add one in settings — you can keep typing in the meantime.';
    }

    return 'OpenAI-compatible provider is not available. Check the base URL and API key — you can keep typing in the meantime.';
  }

  return 'No AI model provider is available. Set one up to send — you can keep typing in the meantime.';
}

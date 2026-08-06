import { createOpenRouter } from '@openrouter/ai-sdk-provider';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createOllama } from 'ollama-ai-provider-v2';
import type { LanguageModel } from 'ai';
import { AIProvider } from '@components/AI/aiContstants';
import { normalizeOpenAICompatibleBaseUrl } from './presets';
import type { CreateLanguageModelOptions, ProviderCredentials } from './types';

export function isProviderConfigured(
  provider: AIProvider,
  credentials: ProviderCredentials,
): boolean {
  if (provider === AIProvider.OpenRouter) {
    return Boolean(credentials.openRouterApiKey);
  }

  if (provider === AIProvider.Ollama) {
    return Boolean(credentials.ollamaUrl);
  }

  if (provider === AIProvider.OpenAICompatible) {
    return Boolean(
      credentials.openAICompatibleApiKey && credentials.openAICompatibleBaseUrl,
    );
  }

  return false;
}

/**
 * Single place that turns an {@link AIModelIdentifier} + credentials into a
 * Vercel AI SDK `LanguageModel`. Used by both streaming (`ClientOnlyTransport`)
 * and non-streaming (`useGetModel`) paths so a new provider only needs one
 * factory branch.
 */
export function createLanguageModel(
  options: CreateLanguageModelOptions,
): LanguageModel | undefined {
  const { model, credentials, openRouter } = options;

  if (model.provider === AIProvider.OpenRouter) {
    if (!credentials.openRouterApiKey) {
      return undefined;
    }

    const extraBody: Record<string, unknown> = {};

    if (openRouter?.modalities) {
      extraBody.modalities = openRouter.modalities;
    }

    if (openRouter?.useContextCompression) {
      extraBody.plugins = [{ id: 'context-compression' }];
    }

    // Non-streaming generative calls historically used middle-out transforms.
    if (!openRouter?.modalities && !openRouter?.useContextCompression) {
      extraBody.transforms = ['middle-out'];
    }

    const provider = createOpenRouter({
      apiKey: credentials.openRouterApiKey,
      compatibility: 'strict',
      extraBody,
    });

    return provider(model.id);
  }

  if (model.provider === AIProvider.Ollama) {
    if (!credentials.ollamaUrl) {
      return undefined;
    }

    const provider = createOllama({
      baseURL: `${credentials.ollamaUrl}/api`,
    });

    return provider(model.id);
  }

  if (model.provider === AIProvider.OpenAICompatible) {
    if (
      !credentials.openAICompatibleApiKey ||
      !credentials.openAICompatibleBaseUrl
    ) {
      return undefined;
    }

    const baseURL = normalizeOpenAICompatibleBaseUrl(
      credentials.openAICompatibleBaseUrl,
    );

    const provider = createOpenAICompatible({
      name: 'openai-compatible',
      baseURL,
      apiKey: credentials.openAICompatibleApiKey,
    });

    return provider(model.id);
  }

  return undefined;
}

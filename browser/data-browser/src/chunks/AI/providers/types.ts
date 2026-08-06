import type { AIModelIdentifier } from '../types';

export type Modalities = 'text' | 'image';

/** Credentials needed to construct a LanguageModel for any built-in provider. */
export type ProviderCredentials = {
  openRouterApiKey?: string;
  ollamaUrl?: string;
  openAICompatibleApiKey?: string;
  openAICompatibleBaseUrl?: string;
};

export type CreateLanguageModelOptions = {
  model: AIModelIdentifier;
  credentials: ProviderCredentials;
  /** OpenRouter-only streaming extras (modalities + context-compression plugin). */
  openRouter?: {
    modalities?: Modalities[];
    useContextCompression?: boolean;
  };
};

/** Normalized OpenAI `/v1/models` entry (field names vary by gateway). */
export type OpenAICompatibleModel = {
  id: string;
  name?: string;
  context_length?: number;
};

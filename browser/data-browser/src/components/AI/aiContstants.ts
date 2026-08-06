export const DEFAULT_AICHAT_NAME = 'Untitled Chat';

/**
 * Built-in AI providers.
 *
 * Prefer extending {@link AIProvider.OpenAICompatible} (base URL + API key)
 * for new OpenAI-compatible gateways instead of adding another enum value.
 * OpenRouter and Ollama stay special-cased because their auth, model listing,
 * and streaming extras differ meaningfully.
 */
export enum AIProvider {
  OpenRouter = 'openrouter',
  Ollama = 'ollama',
  OpenAICompatible = 'openai-compatible',
}

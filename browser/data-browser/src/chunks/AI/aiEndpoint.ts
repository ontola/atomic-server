import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';
import type { AIModelIdentifier } from './types';

/** One configured OpenAI-compatible chat endpoint. */
export type AIEndpoint = {
  baseUrl: string;
  apiKey?: string;
};

export type AIEndpointPreset = {
  id: string;
  label: string;
  baseUrl: string;
  /** When false, a key is optional (e.g. local Ollama). */
  requiresApiKey: boolean;
  apiKeyPlaceholder?: string;
};

export const AI_ENDPOINT_PRESETS: AIEndpointPreset[] = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-or-...',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    baseUrl: 'http://localhost:11434/v1',
    requiresApiKey: false,
  },
  {
    id: 'orcarouter',
    label: 'OrcaRouter',
    baseUrl: 'https://api.orcarouter.ai/v1',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-orca-...',
  },
  {
    id: 'groq',
    label: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    requiresApiKey: true,
    apiKeyPlaceholder: 'gsk_...',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-...',
  },
];

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

export function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, '');
}

export function matchPreset(
  baseUrl: string | undefined,
): AIEndpointPreset | undefined {
  if (!baseUrl) {
    return undefined;
  }

  const normalized = normalizeBaseUrl(baseUrl);

  return AI_ENDPOINT_PRESETS.find(p => p.baseUrl === normalized);
}

export function isEndpointConfigured(
  baseUrl: string | undefined,
  apiKey: string | undefined,
): boolean {
  if (!baseUrl) {
    return false;
  }

  const preset = matchPreset(baseUrl);

  if (preset && !preset.requiresApiKey) {
    return true;
  }

  return Boolean(apiKey);
}

export function createEndpointModel(
  modelId: string,
  endpoint: AIEndpoint,
): LanguageModel {
  const provider = createOpenAICompatible({
    name: 'ai-endpoint',
    baseURL: normalizeBaseUrl(endpoint.baseUrl),
    // Some local servers require a key header even when unused.
    apiKey: endpoint.apiKey || 'not-needed',
  });

  return provider(modelId);
}

/** Accepts legacy `{ id, provider }` values from localStorage / agents. */
export function normalizeModelIdentifier(
  raw: unknown,
): AIModelIdentifier | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const id = (raw as { id?: unknown }).id;

  if (typeof id !== 'string' || !id) {
    return undefined;
  }

  return { id };
}

/** Strip legacy `provider:` prefixes from recent-model values. */
export function normalizeModelIdValue(value: string): string {
  for (const prefix of ['openrouter:', 'ollama:', 'openai-compatible:']) {
    if (value.startsWith(prefix)) {
      return value.slice(prefix.length);
    }
  }

  return value;
}

export type AIModelInfo = {
  id: string;
  name?: string;
  context_length?: number;
};

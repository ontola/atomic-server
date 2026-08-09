import { useEffect, useState } from 'react';
import { effectFetch } from '@helpers/effectFetch';
import { useAISettings } from '@components/AI/AISettingsContext';
import {
  isEndpointConfigured,
  normalizeBaseUrl,
  type AIModelInfo,
} from './aiEndpoint';

type ModelsResponse = {
  data?: Array<{
    id?: string;
    name?: string;
    context_length?: number;
    context_window?: number;
    max_model_len?: number;
  }>;
};

let cache: { baseUrl: string; models: AIModelInfo[] } | undefined;

function normalizeModels(data: ModelsResponse): AIModelInfo[] {
  return (data.data ?? [])
    .filter((row): row is { id: string } & typeof row => Boolean(row.id))
    .map(row => ({
      id: row.id,
      name: row.name,
      context_length:
        row.context_length ?? row.context_window ?? row.max_model_len,
    }));
}

/**
 * Lists models from the configured OpenAI-compatible endpoint (`{baseUrl}/models`).
 * `reachable` is true when that request succeeds — used for connection status.
 */
export function useAIModels() {
  const { aiBaseUrl, aiApiKey } = useAISettings();
  const configured = isEndpointConfigured(aiBaseUrl, aiApiKey);
  const [models, setModels] = useState<AIModelInfo[]>([]);
  const [checking, setChecking] = useState(false);
  const [reachable, setReachable] = useState(false);

  useEffect(() => {
    if (!configured || !aiBaseUrl) {
      setModels([]);
      setReachable(false);
      setChecking(false);

      return;
    }

    const baseUrl = normalizeBaseUrl(aiBaseUrl);

    if (cache?.baseUrl === baseUrl) {
      setModels(cache.models);
      setReachable(true);
      setChecking(false);

      return;
    }

    setChecking(true);

    const headers: Record<string, string> = {};

    if (aiApiKey) {
      headers.Authorization = `Bearer ${aiApiKey}`;
    }

    return effectFetch(`${baseUrl}/models`, { headers })(
      data => {
        const normalized = normalizeModels(data as ModelsResponse);
        cache = { baseUrl, models: normalized };
        setModels(normalized);
        setReachable(true);
        setChecking(false);
      },
      () => {
        setModels([]);
        setReachable(false);
        setChecking(false);
      },
    );
  }, [configured, aiBaseUrl, aiApiKey]);

  const getContextLength = (modelId: string): number | undefined =>
    models.find(m => m.id === modelId)?.context_length;

  return {
    models,
    configured,
    checking,
    reachable,
    available: configured && reachable,
    getContextLength,
  };
}

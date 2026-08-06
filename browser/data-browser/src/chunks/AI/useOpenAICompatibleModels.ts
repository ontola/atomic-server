import { useEffect, useState } from 'react';
import { effectFetch } from '@helpers/effectFetch';
import { useAISettings } from '@components/AI/AISettingsContext';
import {
  normalizeOpenAICompatibleBaseUrl,
  type OpenAICompatibleModel,
} from './providers';

type ModelsResponse = {
  data?: Array<{
    id?: string;
    name?: string;
    context_length?: number;
    context_window?: number;
    max_model_len?: number;
  }>;
};

let modelDataCache:
  | { baseUrl: string; models: OpenAICompatibleModel[] }
  | undefined;

function normalizeModels(data: ModelsResponse): OpenAICompatibleModel[] {
  const rows = data.data ?? [];

  return rows
    .filter((row): row is { id: string } & typeof row => Boolean(row.id))
    .map(row => ({
      id: row.id,
      name: row.name,
      context_length:
        row.context_length ?? row.context_window ?? row.max_model_len,
    }));
}

/**
 * Lists models from an OpenAI-compatible `{baseUrl}/models` endpoint.
 * Cache is keyed by base URL so switching presets refetches.
 */
export function useOpenAICompatibleModels() {
  const { openAICompatibleApiKey, openAICompatibleBaseUrl } = useAISettings();
  const [models, setModels] = useState<OpenAICompatibleModel[]>(() => {
    if (
      modelDataCache &&
      openAICompatibleBaseUrl &&
      modelDataCache.baseUrl ===
        normalizeOpenAICompatibleBaseUrl(openAICompatibleBaseUrl)
    ) {
      return modelDataCache.models;
    }

    return [];
  });

  const getContextLength = (modelId: string): number | undefined => {
    return models.find(m => m.id === modelId)?.context_length;
  };

  const checkSupportsImageInput = (_modelId: string): boolean => {
    // Most gateways do not expose modality metadata on /models. Assume yes and
    // let the model reject unsupported image parts.
    return true;
  };

  useEffect(() => {
    if (!openAICompatibleApiKey || !openAICompatibleBaseUrl) {
      setModels([]);

      return;
    }

    const baseUrl = normalizeOpenAICompatibleBaseUrl(openAICompatibleBaseUrl);

    if (modelDataCache?.baseUrl === baseUrl) {
      setModels(modelDataCache.models);

      return;
    }

    return effectFetch(`${baseUrl}/models`, {
      headers: {
        Authorization: `Bearer ${openAICompatibleApiKey}`,
      },
    })(
      data => {
        const normalized = normalizeModels(data as ModelsResponse);
        modelDataCache = { baseUrl, models: normalized };
        setModels(normalized);
      },
      () => {
        setModels([]);
      },
    );
  }, [openAICompatibleApiKey, openAICompatibleBaseUrl]);

  return {
    models,
    getContextLength,
    checkSupportsImageInput,
  };
}

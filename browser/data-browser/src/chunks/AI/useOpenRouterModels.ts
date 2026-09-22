import { useAISettings } from '@components/AI/AISettingsContext';
import { useEffect, useState } from 'react';
import { effectFetch } from '@helpers/effectFetch';
import type { Modalities } from './ClientOnlyTransport';

export type OpenRouterAIModel = {
  id: string;
  name: string;
  description: string;
  /** Unix seconds when added to the OpenRouter catalogue. */
  created?: number;
  architecture: {
    input_modalities: string[];
    output_modalities: string[];
  };
  pricing: {
    prompt: number;
    completion: number;
    web_search: number;
  };
  supported_parameters: string[];
  context_length: number;
};

let modelDataCache: OpenRouterAIModel[] | undefined = undefined;

export function useOpenRouterModels() {
  const { openRouterZdr } = useAISettings();
  const [zdrModels, setZdrModels] = useState<Set<string>>();
  const [privacyError, setPrivacyError] = useState(false);
  useEffect(() => {
    if (!openRouterZdr) return;
    const controller = new AbortController();
    setZdrModels(undefined);
    setPrivacyError(false);
    void fetch('https://openrouter.ai/api/v1/endpoints/zdr', {
      signal: controller.signal,
    })
      .then(async response => {
        if (!response.ok) throw new Error();
        const body = await response.json();
        if (!Array.isArray(body.data)) throw new Error();
        setZdrModels(
          new Set(
            body.data.map(
              (endpoint: { model_id: string }) => endpoint.model_id,
            ),
          ),
        );
      })
      .catch(() => {
        if (!controller.signal.aborted) setPrivacyError(true);
      });

    return () => controller.abort();
  }, [openRouterZdr]);
  const [models, setModels] = useState<OpenRouterAIModel[]>(
    modelDataCache ?? [],
  );

  const checkORModelSupport = (model: string, parameter: string) => {
    const foundModel = models.find(m => m.id === model);

    if (!foundModel) {
      return false;
    }

    return foundModel.supported_parameters.includes(parameter);
  };

  const checkORModelSupportsImageInput = (model: string) => {
    const foundModel = models.find(m => m.id === model);

    if (!foundModel) {
      return false;
    }

    return foundModel.architecture.input_modalities.includes('image');
  };

  const getORModelContextLength = (modelId: string): number | undefined => {
    const foundModel = models.find(m => m.id === modelId);

    if (!foundModel) {
      return undefined;
    }

    return foundModel.context_length;
  };

  const getOutputModalities = (modelId: string): Modalities[] => {
    const foundModel = models.find(m => m.id === modelId);

    if (!foundModel) {
      return ['text'];
    }

    return foundModel.architecture.output_modalities.filter(
      (m): m is Modalities => m === 'text' || m === 'image',
    );
  };

  useEffect(() => {
    if (modelDataCache) {
      return;
    }

    return effectFetch('https://openrouter.ai/api/v1/models')(data => {
      setModels(data.data as OpenRouterAIModel[]);
      modelDataCache = data.data as OpenRouterAIModel[];
    });
  }, []);

  return {
    models: openRouterZdr
      ? models.filter(model => zdrModels?.has(model.id))
      : models,
    privacyError,
    privacyLoading: openRouterZdr && !zdrModels && !privacyError,
    checkORModelSupport,
    checkORModelSupportsImageInput,
    getORModelContextLength,
    getOutputModalities,
  };
}

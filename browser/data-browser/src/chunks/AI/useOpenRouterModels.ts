import { useEffect, useState } from 'react';
import { effectFetch } from '@helpers/effectFetch';
import type { Modalities } from './ClientOnlyTransport';

export type OpenRouterAIModel = {
  id: string;
  name: string;
  description: string;
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
};

let modelDataCache: OpenRouterAIModel[] | undefined = undefined;

export function useOpenRouterModels() {
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
    models,
    checkORModelSupport,
    checkORModelSupportsImageInput,
    getOutputModalities,
  };
}

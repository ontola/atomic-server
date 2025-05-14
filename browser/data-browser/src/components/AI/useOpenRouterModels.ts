import { useEffect, useState } from 'react';

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

  const checkModelSupport = (model: string, parameter: string) => {
    const foundModel = models.find(m => m.id === model);

    if (!foundModel) {
      return false;
    }

    return foundModel.supported_parameters.includes(parameter);
  };

  const checkModelSupportsImageInput = (model: string) => {
    const foundModel = models.find(m => m.id === model);

    if (!foundModel) {
      return false;
    }

    return foundModel.architecture.input_modalities.includes('image');
  };

  useEffect(() => {
    if (modelDataCache) {
      return;
    }

    fetch('https://openrouter.ai/api/v1/models')
      .then(res => res.json())
      .then(data => {
        console.log(data);
        setModels(data.data as OpenRouterAIModel[]);
        modelDataCache = data.data as OpenRouterAIModel[];
      });
  }, []);

  return { models, checkModelSupport, checkModelSupportsImageInput };
}

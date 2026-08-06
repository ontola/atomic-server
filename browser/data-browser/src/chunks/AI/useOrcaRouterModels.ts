import { useEffect, useState } from 'react';
import { effectFetch } from '@helpers/effectFetch';
import type { Modalities } from './ClientOnlyTransport';
import { ORCAROUTER_BASE_URL } from './useModel';

export type OrcaRouterAIModel = {
  id: string;
  context_length?: number;
};

let modelDataCache: OrcaRouterAIModel[] | undefined = undefined;

export function useOrcaRouterModels() {
  const [models, setModels] = useState<OrcaRouterAIModel[]>(
    modelDataCache ?? [],
  );

  const checkORModelSupport = (model: string, parameter: string) => {
    // OrcaRouter is an OpenAI-compatible gateway; all upstream models accept a
    // temperature, and the reasoning-effort parameter is accepted upstream too.
    if (parameter === 'temperature' || parameter === 'reasoning') {
      return true;
    }

    return false;
  };

  const checkORModelSupportsImageInput = (model: string) => {
    const foundModel = models.find(m => m.id === model);

    if (!foundModel) {
      return false;
    }

    // The OrcaRouter models endpoint does not expose per-model modality info,
    // so we optimistically assume image support and let the model handle it.
    return true;
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

    // OrcaRouter does not expose per-model output modalities; all models emit text.
    return ['text'];
  };

  useEffect(() => {
    if (modelDataCache) {
      return;
    }

    return effectFetch(`${ORCAROUTER_BASE_URL}/models`)(data => {
      setModels(data.data as OrcaRouterAIModel[]);
      modelDataCache = data.data as OrcaRouterAIModel[];
    });
  }, []);

  return {
    models,
    checkORModelSupport,
    checkORModelSupportsImageInput,
    getORModelContextLength,
    getOutputModalities,
  };
}
